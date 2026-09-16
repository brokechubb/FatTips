import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
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
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { networkMonitor } from '../index';
import { canCreateFeature, getRequiredRole } from '../services/guild-gate';

const MIN_RENT_EXEMPTION = 0.00089088;
const MIN_SOL_FOR_GAS = 0.001;
const ATA_RENT_EXEMPTION = 0.002; // SOL - rent for creating associated token account
const MAX_RECIPIENTS = 25; // Solana transaction size limit — matches /rain cap

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);
const solanaConnection = new Connection(process.env.SOLANA_RPC_URL!);

export const data = new SlashCommandBuilder()
  .setName('vctip')
  .setDescription('Tip everyone in your current voice channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
  .setContexts([InteractionContextType.Guild])
  .addStringOption((option) =>
    option
      .setName('amount')
      .setDescription('Amount to tip (e.g., $5, 0.5 SOL, 10 USDC). Total in split mode, per-user in each mode')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('mode')
      .setDescription('How to split the amount (default: split)')
      .setRequired(false)
      .addChoices(
        { name: 'Split (Total amount divided)', value: 'split' },
        { name: 'Each (Amount per user)', value: 'each' }
      )
  )
  .addStringOption((option) =>
    option
      .setName('token')
      .setDescription('Token to tip (default: SOL)')
      .setRequired(false)
      .addChoices(
        { name: 'SOL', value: 'SOL' },
        { name: 'USDC', value: 'USDC' },
        { name: 'USDT', value: 'USDT' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: '❌ Voice channel tips can only be used in a server.', ephemeral: true });
    return;
  }

  const amountStr = interaction.options.getString('amount', true);
  const mode = interaction.options.getString('mode') || 'split';
  const tokenPreference = interaction.options.getString('token') || 'SOL';

  // Per-guild role gating — voice tips follow the rain gate
  const gate = await canCreateFeature(interaction.member, 'rain');
  if (!gate.allowed) {
    await interaction.reply({ content: gate.reason ?? '❌ You cannot send voice tips here.', ephemeral: true });
    return;
  }

  // Resolve the sender's current voice channel (fetch full member — API members lack voice state)
  const senderMember = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannelId = senderMember.voice.channelId;
  if (!voiceChannelId) {
    await interaction.reply({
      content: '❌ You must be connected to a voice channel to use this command!',
      ephemeral: true,
    });
    return;
  }

  const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
  if (!voiceChannel || !voiceChannel.isVoiceBased()) {
    await interaction.reply({
      content: '❌ Could not find your voice channel. Please try again.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  // Warn if network is degraded/congested
  const networkWarning = networkMonitor.getWarningText();
  if (networkWarning)
    await interaction.followUp({ content: networkWarning, ephemeral: true }).catch(() => {});

  try {
    // Collect all human members in the voice channel (excluding sender)
    const voiceStates = interaction.guild.voiceStates.cache;
    const memberIds: string[] = [];
    for (const [stateUserId, state] of voiceStates) {
      if (state.channelId !== voiceChannelId) continue;
      if (stateUserId === interaction.user.id) continue;
      const member = interaction.guild.members.cache.get(stateUserId) ?? (await interaction.guild.members.fetch(stateUserId).catch(() => null));
      if (!member || member.user.bot) continue;
      memberIds.push(stateUserId);
    }

    if (memberIds.length === 0) {
      await interaction.editReply({
        content: `❌ No one else is in **${voiceChannel.name}** to tip! (excluding you and bots)`,
      });
      return;
    }

    // Per-guild role gating: only members with the rain gate role may receive
    const rainRoleId = await getRequiredRole(interaction.guildId!, 'rain');
    let eligibleIds = memberIds;
    if (rainRoleId) {
      const memberFetch = await interaction.guild.members
        .fetch({ user: memberIds, limit: 100 })
        .catch(() => null);
      eligibleIds = memberIds.filter((id) => {
        const m = memberFetch?.get(id);
        if (!m) return false;
        return m.roles.cache.has(rainRoleId);
      });

      if (eligibleIds.length === 0) {
        await interaction.editReply({
          content: `❌ No one in **${voiceChannel.name}** has <@&${rainRoleId}> (excluding you and bots).`,
        });
        return;
      }
    }

    // Cap at Solana transaction size limits (random selection, like /rain)
    const isCapped = eligibleIds.length > MAX_RECIPIENTS;
    if (isCapped) {
      eligibleIds = [...eligibleIds].sort(() => 0.5 - Math.random()).slice(0, MAX_RECIPIENTS);
    }

    // Get sender's wallet
    const sender = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!sender) {
      await interaction.editReply({
        content: `${interaction.user} ❌ You don't have a wallet yet! Use \`/wallet create\` to create one.`,
      });
      return;
    }

    // Prepare recipient wallets
    const recipientWallets = [];
    const newWallets: { id: string; key: string }[] = [];

    for (const recipientId of eligibleIds) {
      let recipient = await prisma.user.findUnique({
        where: { discordId: recipientId },
      });

      if (!recipient) {
        try {
          const wallet = await walletService.createEncryptedWallet();
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
          await interaction.editReply({
            content: '❌ Failed to create a wallet for one of the recipients. Please try again.',
          });
          return;
        }
      }
      recipientWallets.push(recipient);
    }

    if (recipientWallets.length === 0) {
      await interaction.editReply({ content: '❌ Failed to prepare recipient wallets.' });
      return;
    }

    // Parse amount
    const parsedAmount = parseAmountInput(amountStr);
    if (!parsedAmount.valid) {
      await interaction.editReply({ content: `❌ ${parsedAmount.error}` });
      return;
    }

    const tokenMap: Record<string, { symbol: string; mint: string }> = {
      SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
      USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
      USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
    };

    let preferredToken = parsedAmount.token ? parsedAmount.token.toUpperCase() : null;

    if (parsedAmount.type === 'max' && !preferredToken) {
      const balances = await balanceService.getBalances(sender.walletPubkey);
      if (balances.sol > MIN_SOL_FOR_GAS + MIN_RENT_EXEMPTION) {
        preferredToken = 'SOL';
      } else if (balances.usdc > 0) {
        preferredToken = 'USDC';
      } else if (balances.usdt > 0) {
        preferredToken = 'USDT';
      } else {
        preferredToken = 'SOL';
      }
    }

    if (parsedAmount.type === 'usd' && parsedAmount.token) preferredToken = parsedAmount.token;
    if (!preferredToken) preferredToken = tokenPreference;

    const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];
    const tokenSymbol = selectedToken.symbol;
    const tokenMint = selectedToken.mint;

    // Calculate amounts
    let totalAmountToken: number;
    let amountPerUser: number;
    let usdValuePerUser: number;

    if (parsedAmount.type === 'max') {
      if (mode === 'each') {
        await interaction.editReply({
          content: '❌ Max amount cannot be used with Each mode. Specify a fixed amount instead.',
        });
        return;
      }

      const balances = await balanceService.getBalances(sender.walletPubkey);
      if (tokenSymbol === 'SOL') {
        totalAmountToken = Math.max(0, balances.sol - MIN_SOL_FOR_GAS - MIN_RENT_EXEMPTION);
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
        conversion = await priceService.convertUsdToToken(parsedAmount.value, tokenMint, tokenSymbol);
      } catch {
        conversion = null;
      }

      if (!conversion) {
        await interaction.editReply({ content: '❌ Price service unavailable.' });
        return;
      }

      if (mode === 'each') {
        amountPerUser = conversion.amountToken;
        totalAmountToken = amountPerUser * recipientWallets.length;
        usdValuePerUser = parsedAmount.value;
      } else {
        totalAmountToken = conversion.amountToken;
        amountPerUser = totalAmountToken / recipientWallets.length;
        usdValuePerUser = parsedAmount.value / recipientWallets.length;
      }
    } else {
      if (mode === 'each') {
        amountPerUser = parsedAmount.value;
        totalAmountToken = parsedAmount.value * recipientWallets.length;
      } else {
        totalAmountToken = parsedAmount.value;
        amountPerUser = totalAmountToken / recipientWallets.length;
      }
      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValuePerUser = price ? amountPerUser * price.price : 0;
      } catch {
        usdValuePerUser = 0;
      }
    }

    if (amountPerUser <= 0) {
      await interaction.editReply({ content: '❌ Amount too small!' });
      return;
    }

    const MIN_PER_RECIPIENT = tokenSymbol === 'SOL' ? 0.0001 : 0.01;
    if (amountPerUser < MIN_PER_RECIPIENT) {
      await interaction.editReply({
        content:
          `❌ Per-recipient amount too small!\n` +
          `**Each user would get:** ${formatTokenAmount(amountPerUser)} ${tokenSymbol}\n` +
          `**Minimum:** ${MIN_PER_RECIPIENT} ${tokenSymbol} per person\n\n` +
          `Try a larger amount or wait for fewer people in the channel.`,
      });
      return;
    }

    // Check balance
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = MIN_SOL_FOR_GAS;
    const rentReserve = MIN_RENT_EXEMPTION;

    if (tokenSymbol === 'SOL') {
      const requiredSol = totalAmountToken + feeBuffer + rentReserve;
      if (balances.sol < requiredSol) {
        await interaction.editReply({
          content:
            `${interaction.user} ❌ Insufficient funds!\n` +
            `**Required:** ${requiredSol.toFixed(5)} SOL (incl. rent exemption)\n` +
            `**Available:** ${balances.sol.toFixed(5)} SOL`,
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

      // Check if recipients need ATA creation (rent paid by sender)
      const mintPubkey = new PublicKey(tokenMint);
      let newAtaCount = 0;
      const checkCount = Math.min(recipientWallets.length, 10);
      for (let i = 0; i < checkCount; i++) {
        try {
          const recipientAta = await getAssociatedTokenAddress(
            mintPubkey,
            new PublicKey(recipientWallets[i].walletPubkey)
          );
          await getAccount(solanaConnection, recipientAta);
        } catch {
          newAtaCount++;
        }
      }
      const estimatedNewAtas =
        newAtaCount > 0 ? Math.ceil(newAtaCount * (recipientWallets.length / checkCount)) : 0;
      const ataRentRequired = estimatedNewAtas * ATA_RENT_EXEMPTION;

      const totalSolNeeded = MIN_SOL_FOR_GAS + ataRentRequired;
      if (balances.sol < totalSolNeeded) {
        const rentInfo =
          estimatedNewAtas > 0
            ? `\n• +${estimatedNewAtas} new wallet${estimatedNewAtas > 1 ? 's' : ''} need ${ATA_RENT_EXEMPTION} SOL each for token accounts`
            : '';
        await interaction.editReply({
          content:
            `❌ Insufficient SOL for gas & rent!\n` +
            `**Required:** ${totalSolNeeded.toFixed(5)} SOL\n` +
            `• ${MIN_SOL_FOR_GAS} SOL for transaction fees\n` +
            `• ${ataRentRequired.toFixed(5)} SOL for new wallet${estimatedNewAtas > 1 ? 's' : ''} (rent exemption)${rentInfo}\n` +
            `**Available:** ${balances.sol.toFixed(5)} SOL\n\n` +
            `Deposit SOL to your wallet to cover fees.`,
        });
        return;
      }
    }

    // Execute batch transfer
    const senderKeypair = await walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
    const transfers = recipientWallets.map((r) => ({
      recipient: r.walletPubkey,
      amount: amountPerUser,
    }));

    let signature: string;
    try {
      signature = await transactionService.batchTransfer(senderKeypair, transfers, tokenMint);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Voice tip transaction failed:', error);
      await interaction.editReply({
        content: `❌ Transaction failed: ${errorMessage}`,
      });
      return;
    }

    // Log transactions
    const logEntries = recipientWallets.map((recipient, i) => ({
      recipient,
      batchSignature: recipientWallets.length > 1 ? `${signature}:${i}` : signature,
    }));
    await prisma.$transaction(
      logEntries.map(({ recipient, batchSignature }) =>
        prisma.transaction.create({
          data: {
            signature: batchSignature,
            fromId: sender.discordId,
            toId: recipient.discordId,
            amountUsd: usdValuePerUser,
            amountToken: amountPerUser,
            tokenMint,
            usdRate: usdValuePerUser > 0 ? usdValuePerUser / amountPerUser : 0,
            txType: 'TIP',
            status: 'CONFIRMED',
          },
        })
      )
    );
    for (const { recipient, batchSignature } of logEntries) {
      logTransaction('TIP', {
        fromId: sender.discordId,
        toId: recipient.discordId,
        amount: amountPerUser,
        token: tokenSymbol,
        signature: batchSignature,
        status: 'SUCCESS',
      });
    }

    // Respond
    const userMentions = recipientWallets.map((r) => `<@${r.discordId}>`).join(', ');
    const embed = new EmbedBuilder()
      .setTitle('🎙️ Voice Channel Tip Sent!')
      .setDescription(
        `**${interaction.user}** tipped ${isCapped ? `**${recipientWallets.length} of ${memberIds.length}** members in` : 'everyone in'} **🔊 ${voiceChannel.name}**!\n\n` +
          `**Recipients:** ${userMentions}\n` +
          `**Amount Each:** ${formatTokenAmount(amountPerUser)} ${tokenSymbol} (~$${usdValuePerUser.toFixed(2)})\n` +
          `**Total Sent:** ${formatTokenAmount(totalAmountToken)} ${tokenSymbol}\n\n` +
          `[View on Solscan](https://solscan.io/tx/${signature})`
      )
      .setColor(0x9b59b6)
      .setTimestamp();

    if (isCapped) {
      embed.setFooter({
        text: `⚠️ ${memberIds.length} members in the channel — randomly selected ${MAX_RECIPIENTS} (transaction limit)`,
      });
    }

    if (newWallets.length > 0) {
      embed.addFields({
        name: '🆕 New Wallets Created',
        value: `Created wallets for ${newWallets.length} new users.\nCheck DMs! Use \`/balance\` to see your funds.`,
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // DMs (with fallback for users who have DMs disabled)
    const failedDMs: string[] = [];

    for (const recipient of recipientWallets) {
      try {
        const user = await interaction.client.users.fetch(recipient.discordId);
        const isNew = newWallets.find((w) => w.id === recipient.discordId);

        const msg = `🎙️ You received **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** (~$${usdValuePerUser.toFixed(2)}) from ${interaction.user.username} in voice channel **${voiceChannel.name}**!`;

        if (isNew) {
          await user.send(msg);
          const guideEmbed = new EmbedBuilder()
            .setTitle('🚀 Welcome to FatTips')
            .setDescription('You just received Solana! Use `/balance` to check it.')
            .setColor(0x00aaff);
          await user.send({ embeds: [guideEmbed] });

          await prisma.user.update({
            where: { discordId: recipient.discordId },
            data: { seedDelivered: true },
          });
        } else {
          await user.send(msg);
        }
      } catch {
        const isNew = newWallets.find((w) => w.id === recipient.discordId);
        if (isNew) {
          failedDMs.push(recipient.discordId);
        }
      }
    }

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
      } catch {
        // followUp failed, non-critical
      }
    }
  } catch (error) {
    console.error('Error in vctip command:', error);
    try {
      await interaction.editReply({ content: '❌ An unexpected error occurred.' });
    } catch {
      // editReply failed
    }
  }
}

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

  const usdMatch =
    trimmed.match(/^\$(\d+(?:\.\d+)?|\.\d+)\s*([a-zA-Z]*)?$/i) ||
    trimmed.match(/^(\d+(?:\.\d+)?|\.\d+)\$\s*([a-zA-Z]*)?$/i);
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