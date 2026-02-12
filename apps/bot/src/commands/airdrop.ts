import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  ApplicationIntegrationType,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { logTransaction } from '../utils/logger';
import {
  PriceService,
  TOKEN_MINTS,
  ConversionResult,
  TransactionService,
  WalletService,
  BalanceService,
} from 'fattips-solana';

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

export const data = new SlashCommandBuilder()
  .setName('airdrop')
  .setDescription('Create a crypto airdrop for the community')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setIntegrationTypes([ApplicationIntegrationType.GuildInstall]) // Only visible when bot is guild-installed
  .setContexts([InteractionContextType.Guild]) // Only usable in guild channels
  .addStringOption((option) =>
    option
      .setName('amount')
      .setDescription('Total amount to drop (e.g., $10, 1 SOL)')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('duration')
      .setDescription('Duration (e.g., 10s, 10m, 1h, 24h)')
      .setRequired(true)
  )
  .addIntegerOption((option) =>
    option.setName('max-winners').setDescription('Max number of winners (optional)')
  )
  .addStringOption((option) =>
    option
      .setName('token')
      .setDescription('Token to drop (default: SOL)')
      .addChoices(
        { name: 'SOL', value: 'SOL' },
        { name: 'USDC', value: 'USDC' },
        { name: 'USDT', value: 'USDT' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await handleCreate(interaction);
}

async function handleCreate(interaction: ChatInputCommandInteraction) {
  // Check if bot is actually a member of this guild
  // With user-installable apps, command can be used in guilds where bot isn't a member
  const botIsMember = interaction.guild?.members.me !== null;

  if (!botIsMember) {
    await interaction.reply({
      content:
        '❌ **Airdrops require the bot to be added to this server.**\n\n' +
        "Since you're using FatTips as a user-installed app, the bot cannot update the airdrop message when it ends.\n\n" +
        '**Options:**\n' +
        '• Ask a server admin to [add FatTips to the server](https://discord.com/oauth2/authorize?client_id=' +
        interaction.client.user?.id +
        '&permissions=2147483648&scope=bot%20applications.commands)\n' +
        '• Use `/tip` or `/send` instead (these work anywhere!)',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const amountStr = interaction.options.getString('amount', true);
  const durationStr = interaction.options.getString('duration', true);
  const maxWinners = interaction.options.getInteger('max-winners') || null;
  const tokenPreference = interaction.options.getString('token') || 'SOL';

  // 1. Parse Duration
  const durationMs = parseDuration(durationStr);

  if (!durationMs || durationMs < 10000) {
    await interaction.editReply({
      content: '❌ Invalid duration. Must be at least 10 seconds (e.g., `10s`, `10m`, `1h`).',
    });
    return;
  }

  // Use interaction timestamp to ensure sync with Discord's clock (avoids server drift)
  const startTime = interaction.createdTimestamp;
  const expiresAt = new Date(startTime + durationMs);

  // 2. Parse Amount
  const parsedAmount = parseAmountInput(amountStr);
  if (!parsedAmount.valid) {
    await interaction.editReply({ content: `❌ ${parsedAmount.error || 'Invalid amount format'}` });
    return;
  }

  // 3. Get Creator Wallet
  const creator = await prisma.user.findUnique({
    where: { discordId: interaction.user.id },
  });

  if (!creator) {
    await interaction.editReply({
      content: "❌ You don't have a wallet! Use `/wallet action:create` first.",
    });
    return;
  }

  // 4. Calculate Amounts
  let tokenSymbol = 'SOL';
  let tokenMint = TOKEN_MINTS.SOL;
  let amountToken = 0;
  let usdValue = 0;

  // Smart token detection for max
  if (parsedAmount.type === 'max' && !parsedAmount.token) {
    // Auto-detect based on available balance
    const balances = await balanceService.getBalances(creator.walletPubkey);
    const gasBuffer = 0.003;

    // Check which token has significant balance
    if (balances.sol > gasBuffer) {
      tokenSymbol = 'SOL';
    } else if (balances.usdc > 0) {
      tokenSymbol = 'USDC';
    } else if (balances.usdt > 0) {
      tokenSymbol = 'USDT';
    } else {
      tokenSymbol = 'SOL';
    }
  }

  // Determine token
  if (parsedAmount.type === 'max') {
    tokenSymbol = parsedAmount.token || tokenSymbol;
    tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS];

    // Calculate max amount
    const balances = await balanceService.getBalances(creator.walletPubkey);
    const gasBuffer = 0.003;

    if (tokenSymbol === 'SOL') {
      amountToken = Math.max(0, balances.sol - gasBuffer);
    } else if (tokenSymbol === 'USDC') {
      amountToken = balances.usdc;
    } else {
      amountToken = balances.usdt;
    }

    // Estimate USD
    try {
      const price = await priceService.getTokenPrice(tokenMint);
      usdValue = price ? amountToken * price.price : 0;
    } catch {
      usdValue = 0;
    }
  } else if (parsedAmount.type === 'usd') {
    const tokenMap: any = {
      SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
      USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
      USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
    };
    const selected = tokenMap[parsedAmount.token || tokenPreference] || tokenMap.SOL;
    tokenSymbol = selected.symbol;
    tokenMint = selected.mint;

    const conversion = await priceService.convertUsdToToken(
      parsedAmount.value,
      tokenMint,
      tokenSymbol
    );
    if (!conversion) {
      await interaction.editReply({ content: '❌ Failed to fetch prices.' });
      return;
    }
    amountToken = conversion.amountToken;
    usdValue = parsedAmount.value;
  } else {
    tokenSymbol = parsedAmount.token || tokenPreference;
    tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS];
    amountToken = parsedAmount.value || 0;
    // Estimate USD
    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? amountToken * price.price : 0;
  }

  // Validate amount
  if (amountToken <= 0) {
    await interaction.editReply({ content: '❌ Amount must be greater than 0.' });
    return;
  }

  // 5. Generate Ephemeral Wallet
  const ephemeralWallet = await walletService.createEncryptedWallet();

  // 6. Fund Ephemeral Wallet
  // Calculate gas buffer based on max winners to account for rent exemption
  // Each new winner wallet needs 0.00089 SOL rent exemption + 0.000005 SOL tx fee
  const winnerCount = maxWinners || 100; // Default to 100 if not specified
  const RENT_EXEMPTION = 0.00089; // Minimum balance for rent exemption
  const TX_FEE = 0.000005; // Per transaction fee
  const GAS_BUFFER = 0.003 + winnerCount * (RENT_EXEMPTION + TX_FEE);

  let fundingAmountSol = 0;
  let fundingAmountToken = 0;

  if (tokenSymbol === 'SOL') {
    // For max, amountToken already has gas buffer subtracted, so we don't add it again
    if (parsedAmount.type === 'max') {
      fundingAmountSol = amountToken;
    } else {
      fundingAmountSol = amountToken + GAS_BUFFER;
    }
  } else {
    fundingAmountSol = GAS_BUFFER; // Sender pays SOL gas for the bot wallet
    fundingAmountToken = amountToken;
  }

  // Check Creator Balance (skip for max since we calculated based on actual balance)
  if (parsedAmount.type !== 'max') {
    const creatorBalances = await balanceService.getBalances(creator.walletPubkey);
    if (creatorBalances.sol < fundingAmountSol) {
      await interaction.editReply({
        content: `❌ Insufficient SOL! You need ${fundingAmountSol.toFixed(4)} SOL (Amount + Gas Buffer).`,
      });
      return;
    }
    if (fundingAmountToken > 0) {
      if (
        (tokenSymbol === 'USDC' && creatorBalances.usdc < fundingAmountToken) ||
        (tokenSymbol === 'USDT' && creatorBalances.usdt < fundingAmountToken)
      ) {
        await interaction.editReply({
          content: `❌ Insufficient ${tokenSymbol}! You need ${fundingAmountToken}.`,
        });
        return;
      }
    }
  }

  // Execute Funding Transaction
  try {
    const creatorKeypair = await walletService.getKeypair(
      creator.encryptedPrivkey,
      creator.keySalt
    );

    // Transfer SOL if needed
    if (fundingAmountSol > 0) {
      // If dropping SOL, we send total. If dropping Token, we send just Gas.
      // Wait, if dropping SOL, the amountToken is included in fundingAmountSol logic above? Yes.
      // But transactionService.transfer sends pure amount.
      // If tokenSymbol is SOL, we send `amountToken + GAS_BUFFER`.
      // If tokenSymbol is USDC, we send `GAS_BUFFER` SOL separately?
      // My transactionService.transfer does ONE transfer.

      // We need TWO transfers if it's an SPL token airdrop:
      // 1. Send SOL for gas
      // 2. Send Tokens for the pot

      // Let's keep it simple: Just trigger the transfers.

      // Send SOL
      const solToSend = tokenSymbol === 'SOL' ? amountToken + GAS_BUFFER : GAS_BUFFER;
      const solSig = await transactionService.transfer(
        creatorKeypair,
        ephemeralWallet.publicKey,
        solToSend,
        TOKEN_MINTS.SOL
      );
      logTransaction('AIRDROP', {
        fromId: creator.discordId,
        amount: solToSend,
        token: 'SOL',
        signature: solSig,
        status: 'SUCCESS',
      });
    }

    // Transfer SPL Token if needed
    if (fundingAmountToken > 0) {
      const tokenSig = await transactionService.transfer(
        creatorKeypair,
        ephemeralWallet.publicKey,
        fundingAmountToken,
        tokenMint
      );
      logTransaction('AIRDROP', {
        fromId: creator.discordId,
        amount: fundingAmountToken,
        token: tokenSymbol,
        signature: tokenSig,
        status: 'SUCCESS',
      });
    }
  } catch (error: any) {
    console.error('Funding failed:', error);
    logTransaction('AIRDROP', { status: 'FAILED', error: error.message || String(error) });
    await interaction.editReply({ content: '❌ Failed to fund airdrop wallet. Please try again.' });
    return;
  }

  // Verify the ephemeral wallet was funded before creating airdrop
  await interaction.editReply({ content: '✅ Verifying funds received...' });
  try {
    const walletBalances = await balanceService.getBalances(ephemeralWallet.publicKey);
    if (tokenMint === TOKEN_MINTS.SOL) {
      if (walletBalances.sol < amountToken) {
        await interaction.editReply({
          content: '❌ Failed to verify SOL in airdrop wallet. Please try again.',
        });
        return;
      }
    } else {
      const tokenBal = tokenMint === TOKEN_MINTS.USDC ? walletBalances.usdc : walletBalances.usdt;
      if (tokenBal < amountToken) {
        await interaction.editReply({
          content: `❌ Failed to verify ${tokenSymbol} in airdrop wallet. Please try again.`,
        });
        return;
      }
    }
  } catch (verifyError) {
    console.error('Balance verification failed:', verifyError);
    // Continue anyway - the balance check might fail due to RPC issues
  }

  // 7. Create DB Record
  const airdrop = await prisma.airdrop.create({
    data: {
      walletPubkey: ephemeralWallet.publicKey,
      encryptedPrivkey: ephemeralWallet.encryptedPrivateKey,
      keySalt: ephemeralWallet.keySalt,
      creatorId: creator.discordId,
      amountTotal: amountToken,
      tokenMint,
      maxParticipants: maxWinners ?? 0, // Use 0 for "unlimited" if integer required, or fix type
      expiresAt,
      channelId: interaction.channelId,
    },
  });

  // 8. Send Embed
  const endTimestamp = Math.floor(expiresAt.getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle('🎉 Crypto Airdrop!')
    .setDescription(
      `**${interaction.user}** dropped a pot of **${amountToken.toFixed(2)} ${tokenSymbol}** (~$${usdValue.toFixed(2)})!\n\n` +
        `Click **Claim** to enter.\n` +
        `⏳ Ends: <t:${endTimestamp}:R>`
    )
    .setColor(0x00ff00)
    .addFields(
      { name: 'Pot Size', value: `${amountToken.toFixed(2)} ${tokenSymbol}`, inline: true },
      { name: 'Max Winners', value: maxWinners ? `${maxWinners}` : 'Unlimited', inline: true }
    )
    .setFooter({ text: 'Funds are held securely in a temporary wallet.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`claim_airdrop_${airdrop.id}`)
      .setLabel('💰 Claim')
      .setStyle(ButtonStyle.Success)
  );

  const message = await interaction.editReply({ embeds: [embed], components: [row] });

  // Save message ID for updates
  try {
    await prisma.airdrop.update({
      where: { id: airdrop.id },
      data: { messageId: message.id },
    });
  } catch (err) {
    console.error('Failed to save message ID', err);
  }

  // Schedule short airdrops for precise settlement
  if (durationMs < 60000 * 5) {
    // If less than 5 minutes
    interaction.client.emit('scheduleAirdrop', airdrop.id, durationMs);
  }
}

// Helpers (reused from tip.ts logic, ideally shared)
function parseDuration(str: string): number | null {
  // Allow spaces, decimals, case-insensitive
  // Example: "10m", "10 m", "0.5h"
  const match = str.trim().match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  // Safety cap for val to prevent overflow (though unlikely)
  if (val < 0) return null;

  let multiplier = 1000; // seconds
  if (unit === 'm') multiplier *= 60;
  if (unit === 'h') multiplier *= 60 * 60;
  if (unit === 'd') multiplier *= 24 * 60 * 60;
  if (unit === 'w') multiplier *= 7 * 24 * 60 * 60;

  return Math.floor(val * multiplier);
}

function parseAmountInput(input: string) {
  // Simplified regex for speed (full one in tip.ts)
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'all' || trimmed === 'max') return { valid: true, type: 'max', value: 0 };

  const maxTokenMatch = trimmed.match(/^(all|max)\s*(sol|usdc|usdt)?$/i);
  if (maxTokenMatch)
    return { valid: true, type: 'max', value: 0, token: maxTokenMatch[2]?.toUpperCase() || 'SOL' };

  const usdMatch = trimmed.match(/^\$(\d+\.?\d*)\s*([a-zA-Z]*)?$/i);
  if (usdMatch)
    return {
      valid: true,
      type: 'usd',
      value: parseFloat(usdMatch[1]),
      token: usdMatch[2]?.toUpperCase(),
    };

  const tokenMatch = trimmed.match(/^(\d+\.?\d*)\s*(SOL|USDC|USDT)?$/i);
  if (tokenMatch)
    return {
      valid: true,
      type: 'token',
      value: parseFloat(tokenMatch[1]),
      token: tokenMatch[2] ? tokenMatch[2].toUpperCase() : undefined,
    };

  return { valid: false, error: 'Invalid format' };
}
