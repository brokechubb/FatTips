import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  InteractionContextType,
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

// Solana constants
const MIN_RENT_EXEMPTION = 0.00089088; // SOL - minimum to keep account active
const FEE_BUFFER = 0.001; // SOL - standard fee buffer (~$0.15)
const MIN_SOL_FOR_GAS = 0.001; // Minimum SOL required for gas fees
const ATA_RENT_EXEMPTION = 0.002; // SOL - rent for creating associated token account

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);
const solanaConnection = new Connection(process.env.SOLANA_RPC_URL!);

export const data = new SlashCommandBuilder()
  .setName('tip')
  .setDescription('Tip one or more users with SOL, USDC, or USDT')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .addStringOption((option) =>
    option
      .setName('recipients')
      .setDescription('User(s) to tip (e.g. @User1 @User2)')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('amount')
      .setDescription('Amount to tip (e.g., $5, 0.5 SOL, 10 USDC)')
      .setRequired(true)
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
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const recipientsStr = interaction.options.getString('recipients', true);
  const amountStr = interaction.options.getString('amount', true);
  const tokenPreference = interaction.options.getString('token') || 'SOL';
  const mode = interaction.options.getString('mode') || 'split';

  // Parse mentions from recipients string
  const mentionedIds = [...new Set([...recipientsStr.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))];

  // Filter out invalid targets (self, bot)
  const validRecipientIds = mentionedIds.filter(
    (id) => id !== interaction.user.id && id !== interaction.client.user?.id
  );

  if (validRecipientIds.length === 0) {
    await interaction.reply({
      content: '❌ No valid recipients found! (You cannot tip yourself or the bot)',
      ephemeral: true,
    });
    return;
  }

  if (validRecipientIds.length > 10) {
    await interaction.reply({
      content: '❌ You can tip up to 10 users at once.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Parse the amount (we know amountStr is defined at this point)
    const parsedAmount = parseAmountInput(amountStr!);

    if (!parsedAmount.valid) {
      await interaction.editReply({
        content: `❌ ${parsedAmount.error}\n\nExamples:\n• \`/tip recipients:@user $5\`\n• \`/tip recipients:"@user1 @user2" amount:$10 mode:split\``,
      });
      return;
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

    // Process all recipients (Get or Create Wallets)
    const recipientWallets = [];
    const newWallets: { id: string; key: string }[] = [];

    for (const recipientId of validRecipientIds) {
      let recipient = await prisma.user.findUnique({
        where: { discordId: recipientId },
      });

      if (!recipient) {
        // Auto-create wallet
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
          continue; // Skip failed creations
        }
      }
      recipientWallets.push(recipient);
    }

    if (recipientWallets.length === 0) {
      await interaction.editReply({
        content: '❌ Failed to prepare recipient wallets.',
      });
      return;
    }

    // --- AMOUNT CALCULATION ---
    let totalAmountToken: number; // Total to be deducted
    let amountPerUser: number; // Amount each user receives
    let usdValuePerUser: number;

    const tokenMap: Record<string, { symbol: string; mint: string }> = {
      SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
      USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
      USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
    };

    // Determine Token
    let preferredToken = parsedAmount.token ? parsedAmount.token.toUpperCase() : tokenPreference;
    if (parsedAmount.type === 'usd' && parsedAmount.token) {
      preferredToken = parsedAmount.token; // Use hint from "$5 sol"
    }
    const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];
    const tokenSymbol = selectedToken.symbol;
    const tokenMint = selectedToken.mint;

    // Calculate Amounts based on Input Type
    if (parsedAmount.type === 'max') {
      // Logic for MAX: "Max" is always total balance.
      // Mode 'split': Total balance split among users.
      // Mode 'each': Not supported for MAX (ambiguous).
      if (mode === 'each') {
        await interaction.editReply({
          content:
            '❌ "Max" amount cannot be used with "Each" mode. Use "Split" or specify an amount.',
        });
        return;
      }

      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00002; // Fixed fee buffer for single signature transaction
      const rentReserve = MIN_RENT_EXEMPTION;

      if (tokenSymbol === 'SOL') {
        totalAmountToken = Math.max(0, balances.sol - feeBuffer - rentReserve);
      } else if (tokenSymbol === 'USDC') {
        totalAmountToken = balances.usdc;
      } else {
        totalAmountToken = balances.usdt;
      }

      if (totalAmountToken <= 0) {
        await interaction.editReply({
          content: `${interaction.user} ❌ Insufficient balance!`,
        });
        return;
      }

      amountPerUser = totalAmountToken / recipientWallets.length;

      // Get USD value
      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValuePerUser = price ? amountPerUser * price.price : 0;
      } catch {
        usdValuePerUser = 0;
      }
    } else if (parsedAmount.type === 'usd') {
      // USD Value Input
      // Convert TOTAL input to Token
      // If mode=each: input is per user.
      // If mode=split: input is total.

      const inputUsdValue = parsedAmount.value;

      let conversion: ConversionResult | null = null;
      try {
        conversion = await priceService.convertUsdToToken(inputUsdValue, tokenMint, tokenSymbol);
      } catch {
        conversion = null;
      }

      if (!conversion) {
        await interaction.editReply({ content: '❌ Price service unavailable.' });
        return;
      }

      const convertedTokenAmount = conversion.amountToken;

      if (mode === 'each') {
        amountPerUser = convertedTokenAmount;
        totalAmountToken = amountPerUser * recipientWallets.length;
        usdValuePerUser = inputUsdValue;
      } else {
        // split
        totalAmountToken = convertedTokenAmount;
        amountPerUser = totalAmountToken / recipientWallets.length;
        usdValuePerUser = inputUsdValue / recipientWallets.length;
      }
    } else {
      // Direct Token Input
      const inputTokenAmount = parsedAmount.value;

      if (mode === 'each') {
        amountPerUser = inputTokenAmount;
        totalAmountToken = amountPerUser * recipientWallets.length;
      } else {
        // split
        totalAmountToken = inputTokenAmount;
        amountPerUser = totalAmountToken / recipientWallets.length;
      }

      // Get USD value
      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValuePerUser = price ? amountPerUser * price.price : 0;
      } catch {
        usdValuePerUser = 0;
      }
    }

    // Validate Amounts
    if (amountPerUser <= 0) {
      await interaction.editReply({ content: '❌ Amount too small!' });
      return;
    }

    // Check Balance
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.00002; // Slightly higher buffer for batch tx
    const rentReserve = MIN_RENT_EXEMPTION;
    const epsilon = 0.000001; // Tolerance for floating point precision issues
    let isAdjusted = false;

    if (tokenSymbol === 'SOL') {
      // Check if any recipients are new wallets (need rent exemption)
      let newWalletCount = 0;
      const checkCount = Math.min(recipientWallets.length, 10);
      for (let i = 0; i < checkCount; i++) {
        try {
          const recipientBalances = await balanceService.getBalances(
            recipientWallets[i].walletPubkey
          );
          if (
            recipientBalances.sol === 0 &&
            recipientBalances.usdc === 0 &&
            recipientBalances.usdt === 0
          ) {
            newWalletCount++;
          }
        } catch {
          newWalletCount++;
        }
      }
      const estimatedNewWallets =
        newWalletCount > 0 ? Math.ceil(newWalletCount * (recipientWallets.length / checkCount)) : 0;
      const recipientRentReserve = estimatedNewWallets * MIN_RENT_EXEMPTION;

      const requiredSol = totalAmountToken + feeBuffer + rentReserve + recipientRentReserve;
      // Use epsilon to handle floating point precision issues, especially for "max" amounts
      if (balances.sol + epsilon < requiredSol) {
        // Auto-adjust logic
        const maxPossible = Math.max(
          0,
          balances.sol - feeBuffer - rentReserve - recipientRentReserve
        );

        // If they have enough to send something, adjust it
        if (maxPossible > 0) {
          totalAmountToken = maxPossible;
          amountPerUser = totalAmountToken / recipientWallets.length;
          isAdjusted = true;

          // Recalculate USD value
          try {
            const price = await priceService.getTokenPrice(tokenMint);
            usdValuePerUser = price ? amountPerUser * price.price : 0;
          } catch {
            usdValuePerUser = 0;
          }
        } else {
          // Genuine insufficient funds (can't even pay fees/rent)
          const rentInfo =
            estimatedNewWallets > 0
              ? `\n• +${estimatedNewWallets} recipient${estimatedNewWallets > 1 ? 's need' : ' needs'} ${MIN_RENT_EXEMPTION} SOL each for wallet activation`
              : '';
          await interaction.editReply({
            content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${requiredSol.toFixed(5)} SOL\n• ${totalAmountToken.toFixed(4)} SOL for tips\n• ${feeBuffer.toFixed(5)} SOL for fees\n• ${rentReserve.toFixed(5)} SOL (sender rent buffer)${rentInfo}\n**Available:** ${balances.sol.toFixed(5)} SOL`,
          });
          return;
        }
      }
    } else {
      // SPL Token - check if recipients need ATA creation
      const mintPubkey = new PublicKey(tokenMint);
      let newAtaCount = 0;

      // Check up to 10 recipients to see if they need ATA creation
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
      // Estimate total new ATAs needed (extrapolate if we checked only a sample)
      const estimatedNewAtas =
        newAtaCount > 0 ? Math.ceil(newAtaCount * (recipientWallets.length / checkCount)) : 0;
      const ataRentRequired = estimatedNewAtas * ATA_RENT_EXEMPTION;

      const currentBal = tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;
      if (currentBal < totalAmountToken) {
        await interaction.editReply({
          content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${totalAmountToken} ${tokenSymbol}\n**Available:** ${currentBal} ${tokenSymbol}`,
        });
        return;
      }

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

    // --- EXECUTE BATCH TRANSFER ---
    const senderKeypair = await walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

    // Prepare transfers array
    const transfers = recipientWallets.map((r) => ({
      recipient: r.walletPubkey,
      amount: amountPerUser,
    }));

    let signature: string;
    try {
      signature = await transactionService.batchTransfer(senderKeypair, transfers, tokenMint);
    } catch (error) {
      console.error('Batch Transaction failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await interaction.editReply({
        content: `❌ Transaction failed: ${errorMessage}`,
      });
      return;
    }

    // --- LOGGING & RESPONSES ---

    // 1. Log Transactions to DB
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
          txType: 'TIP',
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

    // 2. Reply Embed
    const userMentions = recipientWallets.map((r) => `<@${r.discordId}>`).join(', ');
    const embed = new EmbedBuilder()
      .setTitle('💸 Tip Sent!')
      .setDescription(
        `**${interaction.user}** tipped **${recipientWallets.length} users**!\n\n` +
          `**Recipients:** ${userMentions}\n` +
          `**Amount Each:** ${formatTokenAmount(amountPerUser)} ${tokenSymbol} (~$${usdValuePerUser.toFixed(2)})\n` +
          `**Total Sent:** ${formatTokenAmount(totalAmountToken)} ${tokenSymbol}\n\n` +
          `[View on Solscan](https://solscan.io/tx/${signature})`
      )
      .setColor(0x00ff00)
      .setTimestamp();

    if (isAdjusted) {
      embed.setFooter({
        text: '⚠️ Amount automatically adjusted to fit available balance (minus rent/fees)',
      });
    }

    if (newWallets.length > 0) {
      embed.addFields({
        name: '🆕 New Wallets Created',
        value: `Created wallets for ${newWallets.length} new users.\nCheck DMs! Use \`/balance\` to see your funds.`,
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // 3. Send DMs (with fallback for users who have DMs disabled)
    const failedDMs: string[] = []; // Track users we couldn't DM

    for (const recipient of recipientWallets) {
      try {
        const user = await interaction.client.users.fetch(recipient.discordId);
        const isNew = newWallets.find((w) => w.id === recipient.discordId);

        let msg = `🎉 You received **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** (~$${usdValuePerUser.toFixed(2)}) from ${interaction.user.username}!`;

        if (isNew) {
          await user.send(msg);

          // Send Guide Embed
          const guideEmbed = new EmbedBuilder()
            .setTitle('🚀 Welcome to FatTips')
            .setDescription('You just received crypto! Use `/balance` to check it.')
            .setColor(0x00aaff)
            .addFields({
              name: '🔐 Access Your Wallet',
              value:
                'To view your private key for import into Phantom/Solflare, use `/wallet action:export-key` in a secure environment.',
            });
          await user.send({ embeds: [guideEmbed] });

          await prisma.user.update({
            where: { discordId: recipient.discordId },
            data: { seedDelivered: true },
          });
        } else {
          await user.send(msg);
        }
      } catch {
        // If this was a new wallet and DM failed, track for public notification
        const isNew = newWallets.find((w) => w.id === recipient.discordId);
        if (isNew) {
          failedDMs.push(recipient.discordId);
        }
      }
    }

    // 4. Send public fallback for users who couldn't receive DMs
    if (failedDMs.length > 0) {
      try {
        const mentions = failedDMs.map((id) => `<@${id}>`).join(' ');
        const clientId = interaction.client.user?.id;
        const installLink = `https://discord.com/oauth2/authorize?client_id=${clientId}`;

        const fallbackMsg =
          `💰 ${mentions} — You just received a tip from ${interaction.user} and a new wallet was created for you!\n` +
          `To access your wallet: **[Install FatTips](${installLink})** → then use \`/help\` for help`;

        // Use followUp to ensure message delivery in all contexts (including User App DMs)
        await interaction.followUp({
          content: fallbackMsg,
          allowedMentions: { users: failedDMs }, // Ensure mention works
        });
      } catch {
        // Ignore fallback errors
      }
    }
  } catch (error) {
    console.error('Error in tip command:', error);
    try {
      await interaction.editReply({ content: '❌ An unexpected error occurred.' });
    } catch {
      // Ignore edit errors
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

  const usdMatch = trimmed.match(/^\$(\d+\.?\d*)\s*([a-zA-Z]*)?$/i);
  if (usdMatch) {
    const value = parseFloat(usdMatch[1]);
    if (isNaN(value) || value <= 0) return { valid: false, value: 0, error: 'Invalid USD amount' };
    return { valid: true, type: 'usd', value, token: usdMatch[2]?.toUpperCase() };
  }

  const tokenMatch = trimmed.match(/^(\d+\.?\d*)\s*(SOL|USDC|USDT)?$/i);
  if (tokenMatch) {
    const value = parseFloat(tokenMatch[1]);
    if (isNaN(value) || value <= 0)
      return { valid: false, value: 0, error: 'Invalid token amount' };
    return { valid: true, type: 'token', value, token: tokenMatch[2]?.toUpperCase() };
  }

  return { valid: false, value: 0, error: 'Invalid format. Try: $5, 0.5 SOL, or max' };
}

function formatTokenAmount(amount: number): string {
  if (amount < 0.0001) return amount.toExponential(2);
  if (amount < 1) return amount.toFixed(6);
  if (amount < 100) return amount.toFixed(4);
  return amount.toFixed(2);
}
