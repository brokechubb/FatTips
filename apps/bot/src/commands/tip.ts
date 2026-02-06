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

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

export const data = new SlashCommandBuilder()
  .setName('tip')
  .setDescription('Tip a user with SOL, USDC, or USDT')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .addUserOption((option) =>
    option.setName('user').setDescription('The user to tip').setRequired(true)
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
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const targetUser = interaction.options.getUser('user', true);
  const amountStr = interaction.options.getString('amount', true);
  const tokenPreference = interaction.options.getString('token') || 'SOL';

  // Prevent tipping yourself
  if (targetUser.id === interaction.user.id) {
    await interaction.reply({
      content: "❌ You can't tip yourself!",
      ephemeral: true,
    });
    return;
  }

  // Prevent tipping the bot
  if (targetUser.id === interaction.client.user?.id) {
    await interaction.reply({
      content: "❌ You can't tip me! I'm just a bot.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Parse the amount
    const parsedAmount = parseAmountInput(amountStr);

    if (!parsedAmount.valid) {
      await interaction.editReply({
        content: `❌ ${parsedAmount.error}\n\nExamples:\n• \`/tip @user $5\`\n• \`/tip @user 0.5 SOL\`\n• \`/tip @user 10 USDC\``,
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

    // Get recipient's wallet, or create one if it doesn't exist
    let recipient = await prisma.user.findUnique({
      where: { discordId: targetUser.id },
    });

    let isNewWallet = false;
    let newWalletPrivateKey = '';

    if (!recipient) {
      // Auto-create wallet for recipient
      try {
        const wallet = walletService.createEncryptedWallet();
        recipient = await prisma.user.create({
          data: {
            discordId: targetUser.id,
            walletPubkey: wallet.publicKey,
            encryptedPrivkey: wallet.encryptedPrivateKey,
            keySalt: wallet.keySalt,
            encryptedMnemonic: wallet.encryptedMnemonic,
            mnemonicSalt: wallet.mnemonicSalt,
            seedDelivered: false,
          },
        });
        isNewWallet = true;
        newWalletPrivateKey = wallet.privateKeyBase58;
      } catch (error) {
        console.error('Error creating recipient wallet:', error);
        await interaction.editReply({
          content: `${interaction.user} ❌ Failed to create wallet for ${targetUser}. Please try again later.`,
        });
        return;
      }
    }

    // Determine token and conversion
    let conversion: ConversionResult | null = null;
    let tokenSymbol: string;
    let tokenMint: string;
    let amountToken: number;
    let usdValue: number;

    // Handle "max" / "all" amount
    if (parsedAmount.type === 'max') {
      const tokenMap: Record<string, { symbol: string; mint: string }> = {
        SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
        USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
        USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
      };

      // Determine which token to send max of
      const preferredToken = parsedAmount.token
        ? parsedAmount.token.toUpperCase()
        : tokenPreference;
      const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];

      tokenSymbol = selectedToken.symbol;
      tokenMint = selectedToken.mint;

      // Get balance to calculate max
      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00001; // Tiny buffer for fee (actual fee is usually ~0.000005)
      const rentReserve = 0.001; // Minimum to keep account alive (~0.00089 required)

      if (tokenSymbol === 'SOL') {
        // Max SOL = balance - fees - rent reserve
        amountToken = Math.max(0, balances.sol - feeBuffer - rentReserve);
      } else if (tokenSymbol === 'USDC') {
        amountToken = balances.usdc;
      } else {
        amountToken = balances.usdt;
      }

      if (amountToken <= 0) {
        await interaction.editReply({
          content: `${interaction.user} ❌ Insufficient balance! You don't have enough ${tokenSymbol} to send.`,
        });
        return;
      }

      // Get USD value
      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValue = price ? amountToken * price.price : 0;
      } catch {
        usdValue = 0;
      }
    } else if (parsedAmount.type === 'usd') {
      // USD amount - convert to preferred token
      const tokenMap: Record<string, { symbol: string; mint: string }> = {
        SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
        USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
        USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
      };

      // Use token from input (e.g. "$5 SOL") if provided, otherwise fallback to command option or default
      const preferredToken = parsedAmount.token
        ? parsedAmount.token.toUpperCase()
        : tokenPreference;
      // Validate token exists in our map, otherwise fallback to SOL
      const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];

      tokenSymbol = selectedToken.symbol;
      tokenMint = selectedToken.mint;

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
        await interaction.editReply({
          content: `${interaction.user} ❌ Price service temporarily unavailable. Please try specifying the amount in SOL/USDC directly (e.g., \`/tip @user 0.5 SOL\`).`,
        });
        return;
      }

      amountToken = conversion.amountToken;
      usdValue = parsedAmount.value;
    } else {
      // Direct token amount
      tokenSymbol = parsedAmount.token!;
      tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS];
      amountToken = parsedAmount.value;

      // Get USD value (optional)
      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValue = price ? amountToken * price.price : 0;
      } catch {
        usdValue = 0;
      }
    }

    // Validate amount
    if (amountToken <= 0) {
      await interaction.editReply({
        content: `${interaction.user} ❌ Amount must be greater than 0!`,
      });
      return;
    }

    // Check sender balance
    try {
      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00001; // Tiny buffer for fee
      const rentReserve = 0.001; // Minimum to keep account alive (~0.00089 required)

      if (tokenSymbol === 'SOL') {
        const requiredSol = amountToken + feeBuffer + rentReserve;
        if (balances.sol < requiredSol) {
          await interaction.editReply({
            content:
              `${interaction.user} ❌ Insufficient funds! You need to leave a small amount of SOL for rent and fees.\n\n` +
              `**Required:** ${requiredSol.toFixed(5)} SOL\n` +
              `**Available:** ${balances.sol.toFixed(5)} SOL\n\n` +
              `Try tipping a smaller amount.`,
          });
          return;
        }

        // Check recipient rent-exemption for small SOL tips
        const RENT_EXEMPT_MIN = 0.001;
        try {
          const recipientBalance = await balanceService.getBalances(recipient.walletPubkey);
          if (recipientBalance.sol === 0 && amountToken < RENT_EXEMPT_MIN) {
            // Calculate dynamic USD value
            let minUsdVal = 0;
            try {
              const solPrice = await priceService.getTokenPrice(TOKEN_MINTS.SOL);
              if (solPrice) {
                minUsdVal = RENT_EXEMPT_MIN * solPrice.price;
              }
            } catch {
              // Ignore price fetch error
            }

            const usdString = minUsdVal > 0 ? `(~$${minUsdVal.toFixed(2)})` : '';

            await interaction.editReply({
              content:
                `${interaction.user} ❌ Tip too small for new wallet!\n\n` +
                `The recipient has 0 SOL. To activate their account, the first tip must be at least **${RENT_EXEMPT_MIN} SOL** ${usdString}.\n` +
                `You tried to send: **${amountToken.toFixed(6)} SOL**`,
            });
            return;
          }
        } catch {
          // Ignore recipient check errors
        }
      } else {
        // For SPL tokens (USDC/USDT)
        if (
          (tokenSymbol === 'USDC' && balances.usdc < amountToken) ||
          (tokenSymbol === 'USDT' && balances.usdt < amountToken)
        ) {
          await interaction.editReply({
            content: `${interaction.user} ❌ Insufficient ${tokenSymbol} balance! You have ${tokenSymbol === 'USDC' ? balances.usdc : balances.usdt} ${tokenSymbol}.`,
          });
          return;
        }

        if (balances.sol < feeBuffer) {
          await interaction.editReply({
            content: `${interaction.user} ❌ Insufficient SOL for gas fees! You need at least 0.005 SOL to process this transaction.`,
          });
          return;
        }
      }
    } catch (error) {
      console.error('Error checking balance:', error);
    }

    // --- TRANSACTION EXECUTION ---

    // 1. Get sender's keypair
    const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

    // 2. Execute transfer
    let signature: string;
    try {
      signature = await transactionService.transfer(
        senderKeypair,
        recipient.walletPubkey,
        amountToken,
        tokenMint
      );
    } catch (error) {
      console.error('Transaction failed:', error);
      await interaction.editReply({
        content: `${interaction.user} ❌ Transaction failed. Please check your balance and try again.`,
      });
      return;
    }

    // 3. Log to database
    await prisma.transaction.create({
      data: {
        signature,
        fromId: sender.discordId,
        toId: recipient.discordId,
        amountUsd: usdValue,
        amountToken,
        tokenMint,
        usdRate: usdValue > 0 ? usdValue / amountToken : 0,
        txType: 'TIP',
        status: 'CONFIRMED',
      },
    });

    logTransaction('TIP', {
      fromId: sender.discordId,
      toId: recipient.discordId,
      amount: amountToken,
      token: tokenSymbol,
      signature,
      status: 'SUCCESS',
    });

    // 4. Send success message
    const embed = new EmbedBuilder()
      .setTitle('💸 Tip Sent!')
      .setDescription(
        `**${interaction.user}** tipped **${targetUser}**!\n\n` +
          `**Amount:** ${formatTokenAmount(amountToken)} ${tokenSymbol}\n` +
          `**Value:** ~$${usdValue.toFixed(2)} USD\n\n` +
          `[View on Solscan](https://solscan.io/tx/${signature})`
      )
      .setColor(0x00ff00)
      .setTimestamp();

    if (isNewWallet) {
      embed.addFields({
        name: '🆕 New Wallet Created',
        value:
          `A new Solana wallet was created for ${targetUser} to receive this tip!\n\n` +
          `📩 **Check your DMs:** I've sent you the key to access these funds.\n` +
          `🤖 **Tip:** You can install **FatTips** to your account to manage your wallet anywhere!`,
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // 5. DM recipient
    try {
      const recipientUser = await interaction.client.users.fetch(recipient.discordId);
      let dmContent = `🎉 You received a tip of **${formatTokenAmount(amountToken)} ${tokenSymbol}** (~$${usdValue.toFixed(2)}) from ${interaction.user.username}!`;

      let dmMessage: any;

      if (isNewWallet) {
        dmContent +=
          `\n\n**🔐 A new wallet was created for you!**\n` +
          `Here is your **Private Key**. **Keep this safe and secret!**\n` +
          `\`\`\`\n${newWalletPrivateKey}\n\`\`\`\n` +
          `You can use this key to import your wallet into **Phantom** or **Solflare** (Select "Import Private Key").\n\n` +
          `⚠️ **This message will self-destruct in 15 minutes.**`;

        dmMessage = await recipientUser.send({ content: dmContent });

        // Send a separate persistent guide message
        const guideEmbed = new EmbedBuilder()
          .setTitle('🚀 Getting Started with FatTips')
          .setDescription('FatTips is a non-custodial wallet. Here is how to use it:')
          .setColor(0x00aaff)
          .addFields(
            {
              name: '💰 Check Balance',
              value: 'Use `/balance` to see your funds and public address.',
            },
            {
              name: '💸 Send & Tip',
              value: 'Use `/tip @user $5` to tip friends instantly.',
            },
            {
              name: '📤 Withdraw Funds',
              value:
                'Want to move funds to Phantom/Solflare? Use:\n' +
                '`/send <address> all`\n' +
                '(This drains your wallet completely to your external address).',
            },
            {
              name: '🔐 Security',
              value:
                'The private key above allows you to import this wallet anywhere. **It will self-destruct in 15 minutes.** If you miss it, use `/wallet action:export-key` to see it again.',
            }
          );

        await recipientUser.send({ embeds: [guideEmbed] });
      } else {
        await recipientUser.send({ content: dmContent });
      }

      // Auto-delete after 15 minutes (with edit fallback)
      if (isNewWallet && dmMessage) {
        setTimeout(async () => {
          try {
            await dmMessage.edit({
              content:
                '🔒 **Private Key removed for security.**\nUse `/wallet action:export-key` to view it again.',
            });
          } catch {
            // Message might already be deleted or channel closed
          }
        }, 900000); // 15 minutes
      }

      // Update delivered status if successful
      if (isNewWallet) {
        await prisma.user.update({
          where: { discordId: recipient.discordId },
          data: { seedDelivered: true },
        });
      }
    } catch {
      // Ignore DM errors
    }
  } catch (error: any) {
    console.error('Error processing tip:', error);
    logTransaction('TIP', {
      status: 'FAILED',
      error: error.message || String(error),
    });
    try {
      await interaction.editReply({
        content: '❌ Failed to process tip. Please try again later.',
      });
    } catch {
      // Ignore reply errors
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

  // Check for "all" or "max" keywords
  if (trimmed === 'all' || trimmed === 'max') {
    return { valid: true, type: 'max', value: 0, token: undefined };
  }

  // Check for "all SOL", "max USDC", etc.
  const maxTokenMatch = trimmed.match(/^(all|max)\s*(sol|usdc|usdt)?$/i);
  if (maxTokenMatch) {
    const token = maxTokenMatch[2]?.toUpperCase() || 'SOL';
    return { valid: true, type: 'max', value: 0, token };
  }

  // Check for USD format: $5, $5.50, 5 USD
  // Also supports "$0.01 sol" or "$5 usdc" pattern (ignores token name if $ is present, treats as USD value converted to that token)
  const usdMatch = trimmed.match(/^\$(\d+\.?\d*)\s*([a-zA-Z]*)?$/i);
  if (usdMatch) {
    const value = parseFloat(usdMatch[1]);
    const tokenHint = usdMatch[2]?.toUpperCase(); // e.g. "SOL" from "$0.01 sol"

    if (isNaN(value) || value <= 0) {
      return { valid: false, value: 0, error: 'Invalid USD amount' };
    }

    // Return as 'usd' type, but pass token hint if available so we know which token to convert TO
    return { valid: true, type: 'usd', value, token: tokenHint };
  }

  // Check for token format: 5 SOL, 10 USDC, 0.5 USDT
  const tokenMatch = trimmed.match(/^(\d+\.?\d*)\s*(SOL|USDC|USDT)$/i);
  if (tokenMatch) {
    const value = parseFloat(tokenMatch[1]);
    const token = tokenMatch[2].toUpperCase();
    if (isNaN(value) || value <= 0) {
      return { valid: false, value: 0, error: 'Invalid token amount' };
    }
    return { valid: true, type: 'token', value, token };
  }

  return {
    valid: false,
    value: 0,
    error: `Invalid format: "${input}". Try: $5, 0.5 SOL, all, or max`,
  };
}

function formatTokenAmount(amount: number): string {
  if (amount < 0.0001) return amount.toExponential(2);
  if (amount < 1) return amount.toFixed(6);
  if (amount < 100) return amount.toFixed(4);
  return amount.toFixed(2);
}
