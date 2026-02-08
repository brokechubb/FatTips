import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
  TextChannel,
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
import { activityService } from '../services/activity';

// Discord error codes
const DISCORD_CANNOT_DM = 50007;

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

export const data = new SlashCommandBuilder()
  .setName('rain')
  .setDescription('Randomly distribute tokens to active users in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setIntegrationTypes([ApplicationIntegrationType.GuildInstall]) // Only visible when bot is guild-installed
  .setContexts([InteractionContextType.Guild]) // Only usable in guild channels
  .addStringOption((option) =>
    option
      .setName('amount')
      .setDescription('Total amount to rain (e.g., $10, 1 SOL)')
      .setRequired(true)
  )
  .addIntegerOption((option) =>
    option
      .setName('count')
      .setDescription('Number of lucky users to pick (default: 5)')
      .setMinValue(1)
      .setMaxValue(25)
      .setRequired(false)
  )
  .addStringOption((option) =>
    option
      .setName('token')
      .setDescription('Token to rain (default: SOL)')
      .setRequired(false)
      .addChoices(
        { name: 'SOL', value: 'SOL' },
        { name: 'USDC', value: 'USDC' },
        { name: 'USDT', value: 'USDT' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Check if bot is actually a member of this guild
  // Rain requires bot membership to track channel activity
  const botIsMember = interaction.guild?.members.me !== null;

  if (!botIsMember) {
    await interaction.reply({
      content:
        '❌ **Rain requires the bot to be added to this server.**\n\n' +
        'The rain command tracks active users in channels, which only works when the bot is a server member.\n\n' +
        '**Options:**\n' +
        '• Ask a server admin to add FatTips to the server\n' +
        '• Use `/tip @users` to tip specific people instead',
      ephemeral: true,
    });
    return;
  }

  const amountStr = interaction.options.getString('amount', true);
  const count = interaction.options.getInteger('count') || 5;
  const tokenPreference = interaction.options.getString('token') || 'SOL';

  await interaction.deferReply();

  try {
    // 1. Get Active Users
    const activeUserIds = activityService.getActiveUsers(interaction.channelId, 15); // Last 15 mins

    // Filter out sender and bots (though listener filters bots)
    const candidates = activeUserIds.filter((id) => id !== interaction.user.id);

    if (candidates.length === 0) {
      await interaction.editReply({
        content: '❌ No active users found to rain on! The channel is dry. 🏜️',
      });
      return;
    }

    // Pick Winners
    const winners: string[] = [];
    // Shuffle candidates
    const shuffled = candidates.sort(() => 0.5 - Math.random());
    // Pick top N
    winners.push(...shuffled.slice(0, Math.min(count, candidates.length)));

    // 2. Sender Wallet Check
    const sender = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!sender) {
      await interaction.editReply({
        content: `${interaction.user} ❌ You don't have a wallet yet! Use \`/wallet create\` to create one.`,
      });
      return;
    }

    // 3. Prepare Recipient Wallets
    const recipientWallets = [];
    const newWallets: { id: string; key: string }[] = [];

    for (const recipientId of winners) {
      let recipient = await prisma.user.findUnique({
        where: { discordId: recipientId },
      });

      if (!recipient) {
        // Auto-create wallet
        try {
          const wallet = walletService.createEncryptedWallet();
          recipient = await prisma.user.create({
            data: {
              discordId: recipientId,
              walletPubkey: wallet.publicKey,
              encryptedPrivkey: wallet.encryptedPrivateKey,
              keySalt: wallet.keySalt,
              encryptedMnemonic: wallet.encryptedMnemonic,
              mnemonicSalt: wallet.mnemonicSalt,
              seedDelivered: false,
            },
          });
          newWallets.push({ id: recipientId, key: wallet.privateKeyBase58 });
        } catch (error) {
          console.error(`Error creating wallet for ${recipientId}:`, error);
          continue; // Skip failed creations
        }
      }
      recipientWallets.push(recipient);
    }

    if (recipientWallets.length === 0) {
      await interaction.editReply({ content: '❌ Failed to prepare recipient wallets.' });
      return;
    }

    // 4. Parse Amount & Calculate Split
    const parsedAmount = parseAmountInput(amountStr);
    if (!parsedAmount.valid) {
      await interaction.editReply({ content: `❌ ${parsedAmount.error}` });
      return;
    }

    let tokenSymbol: string;
    let tokenMint: string;
    let totalAmountToken: number;
    let amountPerUser: number;
    let usdValuePerUser: number;

    const tokenMap: Record<string, { symbol: string; mint: string }> = {
      SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
      USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
      USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
    };

    let preferredToken = parsedAmount.token ? parsedAmount.token.toUpperCase() : tokenPreference;
    if (parsedAmount.type === 'usd' && parsedAmount.token) preferredToken = parsedAmount.token;

    const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];
    tokenSymbol = selectedToken.symbol;
    tokenMint = selectedToken.mint;

    if (parsedAmount.type === 'max') {
      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00001 * recipientWallets.length;
      const rentReserve = 0.001;

      if (tokenSymbol === 'SOL') {
        totalAmountToken = Math.max(0, balances.sol - feeBuffer - rentReserve);
      } else if (tokenSymbol === 'USDC') {
        totalAmountToken = balances.usdc;
      } else {
        totalAmountToken = balances.usdt;
      }

      if (totalAmountToken <= 0) {
        await interaction.editReply({ content: `${interaction.user} ❌ Insufficient balance!` });
        return;
      }
      amountPerUser = totalAmountToken / recipientWallets.length;

      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValuePerUser = price ? amountPerUser * price.price : 0;
      } catch {
        usdValuePerUser = 0;
      }
    } else if (parsedAmount.type === 'usd') {
      let conversion: ConversionResult | null = null;
      try {
        conversion = await priceService.convertUsdToToken(
          parsedAmount.value,
          tokenMint,
          tokenSymbol
        );
      } catch {
        conversion = null;
      }

      if (!conversion) {
        await interaction.editReply({ content: '❌ Price service unavailable.' });
        return;
      }
      totalAmountToken = conversion.amountToken;
      amountPerUser = totalAmountToken / recipientWallets.length;
      usdValuePerUser = parsedAmount.value / recipientWallets.length;
    } else {
      // Direct Token Amount
      totalAmountToken = parsedAmount.value;
      amountPerUser = totalAmountToken / recipientWallets.length;
      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValuePerUser = price ? amountPerUser * price.price : 0;
      } catch {
        usdValuePerUser = 0;
      }
    }

    if (amountPerUser <= 0) {
      await interaction.editReply({ content: '❌ Amount too small to split!' });
      return;
    }

    // 5. Check Balance
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.00002;
    const rentReserve = 0.001;

    if (tokenSymbol === 'SOL') {
      const requiredSol = totalAmountToken + feeBuffer + rentReserve;
      if (balances.sol < requiredSol) {
        await interaction.editReply({
          content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${requiredSol.toFixed(5)} SOL\n**Available:** ${balances.sol.toFixed(5)} SOL`,
        });
        return;
      }
    } else {
      const currentBal = tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;
      if (currentBal < totalAmountToken) {
        await interaction.editReply({
          content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${totalAmountToken} ${tokenSymbol}\n**Available:** ${currentBal} ${tokenSymbol}`,
        });
        return;
      }
      if (balances.sol < feeBuffer) {
        await interaction.editReply({ content: '❌ Insufficient SOL for gas fees!' });
        return;
      }
    }

    // 6. Execute Batch Transfer
    const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
    const transfers = recipientWallets.map((r) => ({
      recipient: r.walletPubkey,
      amount: amountPerUser,
    }));

    let signature: string;
    try {
      signature = await transactionService.batchTransfer(senderKeypair, transfers, tokenMint);
    } catch (error: any) {
      console.error('Rain Transaction failed:', error);
      await interaction.editReply({
        content: `❌ Transaction failed: ${error.message || 'Unknown error'}`,
      });
      return;
    }

    // 7. Log & Respond
    // For batch transactions, append an index to the signature to satisfy the unique constraint
    // The real Solana signature can be extracted by splitting on ':'
    for (let i = 0; i < recipientWallets.length; i++) {
      const recipient = recipientWallets[i];
      const batchSignature = recipientWallets.length > 1 ? `${signature}:${i}` : signature;
      await prisma.transaction.create({
        data: {
          signature: batchSignature,
          fromId: sender.discordId,
          toId: recipient.discordId,
          amountUsd: usdValuePerUser,
          amountToken: amountPerUser,
          tokenMint,
          usdRate: usdValuePerUser > 0 ? usdValuePerUser / amountPerUser : 0,
          txType: 'TIP', // Rain is a type of tip
          status: 'CONFIRMED',
        },
      });

      logTransaction('TIP', {
        fromId: sender.discordId,
        toId: recipient.discordId,
        amount: amountPerUser,
        token: tokenSymbol,
        signature: batchSignature,
        status: 'SUCCESS',
      });
    }

    const winnerMentions = recipientWallets.map((r) => `<@${r.discordId}>`).join(', ');
    const embed = new EmbedBuilder()
      .setTitle('🌧️ Making it Rain!')
      .setDescription(
        `**${interaction.user}** made it rain on **${recipientWallets.length} active users**!\n\n` +
          `**Total Rain:** ${formatTokenAmount(totalAmountToken)} ${tokenSymbol}\n` +
          `**Each User Gets:** ${formatTokenAmount(amountPerUser)} ${tokenSymbol} (~$${usdValuePerUser.toFixed(2)})\n\n` +
          `**Lucky Winners:**\n${winnerMentions}\n\n` +
          `[View on Solscan](https://solscan.io/tx/${signature})`
      )
      .setColor(0x00aaff) // Cyan for rain
      .setThumbnail(
        'https://em-content.zobj.net/source/microsoft-teams/337/cloud-with-rain_1f327.png'
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    // DMs (with fallback for users who have DMs disabled)
    const failedDMs: string[] = [];

    for (const recipient of recipientWallets) {
      try {
        const user = await interaction.client.users.fetch(recipient.discordId);
        const isNew = newWallets.find((w) => w.id === recipient.discordId);

        let msg = `🌧️ **It's Raining!** You caught **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** (~$${usdValuePerUser.toFixed(2)}) from ${interaction.user.username}!`;

        if (isNew) {
          msg += `\n\n**🔐 New Wallet Key:**\n\`\`\`\n${isNew.key}\n\`\`\`\n*Self-destructs in 15m.*`;
          const sentMsg = await user.send(msg);

          setTimeout(async () => {
            try {
              await sentMsg.edit('🔒 **Key removed for security.**');
            } catch {}
          }, 900000);

          const guideEmbed = new EmbedBuilder()
            .setTitle('🚀 Welcome to FatTips')
            .setDescription('You just received crypto! Use `/balance` to check it.')
            .setColor(0x00aaff);
          await user.send({ embeds: [guideEmbed] });

          await prisma.user.update({
            where: { discordId: recipient.discordId },
            data: { seedDelivered: true },
          });
        } else {
          await user.send(msg);
        }
      } catch (error: any) {
        const isNew = newWallets.find((w) => w.id === recipient.discordId);
        if (isNew) {
          failedDMs.push(recipient.discordId);
        }
      }
    }

    // Send public fallback for new users who couldn't receive DMs
    if (failedDMs.length > 0) {
      try {
        const mentions = failedDMs.map((id) => `<@${id}>`).join(' ');
        const clientId = interaction.client.user?.id;
        const installLink = `https://discord.com/oauth2/authorize?client_id=${clientId}`;

        const fallbackMsg =
          `💰 ${mentions} — You just received a tip from ${interaction.user} and a new wallet was created for you!\n` +
          `To access your wallet: **[Install FatTips](${installLink})** → then use \`/help\` for help`;

        await interaction.followUp({
          content: fallbackMsg,
          allowedMentions: { users: failedDMs },
        });
      } catch {}
    }
  } catch (error: any) {
    console.error('Error in rain command:', error);
    try {
      await interaction.editReply({ content: '❌ An unexpected error occurred.' });
    } catch {}
  }
}

// Helpers (Same as tip.ts - in a real refactor, move to utils)
interface ParsedAmount {
  valid: boolean;
  type?: 'usd' | 'token' | 'max';
  value: number;
  token?: string;
  error?: string;
}

function parseAmountInput(input: string): ParsedAmount {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'all' || trimmed === 'max') return { valid: true, type: 'max', value: 0 };

  const maxTokenMatch = trimmed.match(/^(all|max)\s*(sol|usdc|usdt)?$/i);
  if (maxTokenMatch)
    return { valid: true, type: 'max', value: 0, token: maxTokenMatch[2]?.toUpperCase() || 'SOL' };

  const usdMatch = trimmed.match(/^\$(\d+\.?\d*)\s*([a-zA-Z]*)?$/i);
  if (usdMatch) {
    const value = parseFloat(usdMatch[1]);
    if (isNaN(value) || value <= 0) return { valid: false, value: 0, error: 'Invalid USD amount' };
    return { valid: true, type: 'usd', value, token: usdMatch[2]?.toUpperCase() };
  }

  const tokenMatch = trimmed.match(/^(\d+\.?\d*)\s*(SOL|USDC|USDT)$/i);
  if (tokenMatch) {
    const value = parseFloat(tokenMatch[1]);
    if (isNaN(value) || value <= 0)
      return { valid: false, value: 0, error: 'Invalid token amount' };
    return { valid: true, type: 'token', value, token: tokenMatch[2].toUpperCase() };
  }

  return { valid: false, value: 0, error: 'Invalid format. Try: $5, 0.5 SOL, or max' };
}

function formatTokenAmount(amount: number): string {
  if (amount < 0.0001) return amount.toExponential(2);
  if (amount < 1) return amount.toFixed(6);
  if (amount < 100) return amount.toFixed(4);
  return amount.toFixed(2);
}
