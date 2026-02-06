import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  InteractionContextType,
} from 'discord.js';
import { prisma } from 'fattips-database';
import {
  PriceService,
  TOKEN_MINTS,
  ConversionResult,
  TransactionService,
  WalletService,
  BalanceService,
} from 'fattips-solana';
import { PublicKey } from '@solana/web3.js';

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

export const data = new SlashCommandBuilder()
  .setName('send')
  .setDescription('Send SOL, USDC, or USDT to any Solana address')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .addStringOption((option) =>
    option
      .setName('address')
      .setDescription('Solana wallet address (e.g., 9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY)')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('amount')
      .setDescription('Amount to send (e.g., $5, 0.5 SOL, all, max)')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('token')
      .setDescription('Token to send (default: SOL)')
      .setRequired(false)
      .addChoices(
        { name: 'SOL', value: 'SOL' },
        { name: 'USDC', value: 'USDC' },
        { name: 'USDT', value: 'USDT' }
      )
  );

// Alias command for /withdraw
export const withdrawData = new SlashCommandBuilder()
  .setName('withdraw')
  .setDescription('Withdraw funds to external wallet (alias for /send)')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .addStringOption((option) =>
    option.setName('address').setDescription('Solana wallet address').setRequired(true)
  )
  .addStringOption((option) =>
    option.setName('amount').setDescription('Amount to withdraw').setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('token')
      .setDescription('Token to withdraw')
      .setRequired(false)
      .addChoices(
        { name: 'SOL', value: 'SOL' },
        { name: 'USDC', value: 'USDC' },
        { name: 'USDT', value: 'USDT' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const address = interaction.options.getString('address', true);
  const amountStr = interaction.options.getString('amount', true);
  const tokenPreference = interaction.options.getString('token') || 'SOL';

  await interaction.deferReply();

  try {
    // Validate the Solana address
    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(address);
      // Verify it's a valid pubkey (not just any 32 bytes)
      if (!PublicKey.isOnCurve(recipientPubkey.toBytes())) {
        throw new Error('Address is not on the ed25519 curve');
      }
    } catch {
      await interaction.editReply({
        content:
          `${interaction.user} ❌ Invalid Solana address!\n\n` +
          `Please provide a valid Solana wallet address (e.g., \`9HMqaDgnbvy4VYi9VpNVb6u3xv4vqD5RG12cyxcsVRFY\`).`,
      });
      return;
    }

    // Parse the amount
    const parsedAmount = parseAmountInput(amountStr);

    if (!parsedAmount.valid) {
      await interaction.editReply({
        content: `${interaction.user} ❌ ${parsedAmount.error}\n\nExamples:\n• \`/send <address> $5\`\n• \`/send <address> 0.5 SOL\`\n• \`/send <address> all\``,
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

    // Prevent sending to self
    if (recipientPubkey.toBase58() === sender.walletPubkey) {
      await interaction.editReply({
        content: `${interaction.user} ❌ You can't send funds to yourself!`,
      });
      return;
    }

    // Determine token and conversion
    let conversion: ConversionResult | null = null;
    let tokenSymbol: string;
    let tokenMint: string;
    let amountToken: number;
    let usdValue: number;

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
      const feeBuffer = 0.00001; // Tiny buffer for fee

      if (tokenSymbol === 'SOL') {
        // Max SOL = balance - fees (Drain Mode: No rent reserve kept)
        amountToken = Math.max(0, balances.sol - feeBuffer);
      } else if (tokenSymbol === 'USDC') {
        amountToken = balances.usdc;
      } else {
        amountToken = balances.usdt;
      }

      if (amountToken <= 0) {
        await interaction.editReply({
          content:
            `${interaction.user} ❌ Insufficient balance!\n` +
            `You have **${balances.sol.toFixed(6)} SOL**.\n` +
            `Minimum fee required: **${feeBuffer.toFixed(6)} SOL**.\n` +
            `You don't have enough to cover the transaction fee.`,
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
          content: `${interaction.user} ❌ Price service temporarily unavailable. Please try specifying the amount in SOL/USDC directly (e.g., \`/send <address> 0.5 SOL\`).`,
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

    // Check sender balance (skip if MAX since we calculated it based on balance)
    if (parsedAmount.type !== 'max') {
      try {
        const balances = await balanceService.getBalances(sender.walletPubkey);
        const feeBuffer = 0.00001; // Tiny buffer for fee
        const rentReserve = 0.001; // Minimum to keep account alive

        if (tokenSymbol === 'SOL') {
          const requiredSol = amountToken + feeBuffer + rentReserve;
          if (balances.sol < requiredSol) {
            await interaction.editReply({
              content:
                `${interaction.user} ❌ Insufficient funds! You need to leave a small amount of SOL for rent and fees.\n\n` +
                `**Required:** ${requiredSol.toFixed(5)} SOL\n` +
                `**Available:** ${balances.sol.toFixed(5)} SOL\n\n` +
                `Try sending a smaller amount or use \`all\` to send everything.`,
            });
            return;
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
    }

    // --- TRANSACTION EXECUTION ---

    // 1. Get sender's keypair
    const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

    // 2. Execute transfer
    let signature: string;
    try {
      signature = await transactionService.transfer(
        senderKeypair,
        recipientPubkey.toBase58(),
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

    // 3. Log to database (store as WITHDRAWAL since it's going off-platform)
    await prisma.transaction.create({
      data: {
        signature,
        fromId: sender.discordId,
        toId: undefined, // External transfer, so no Discord user ID
        toAddress: recipientPubkey.toBase58(),
        fromAddress: sender.walletPubkey,
        amountUsd: usdValue,
        amountToken,
        tokenMint,
        usdRate: usdValue > 0 ? usdValue / amountToken : 0,
        txType: 'WITHDRAWAL',
        status: 'CONFIRMED',
      },
    });

    // 4. Send success message
    const embed = new EmbedBuilder()
      .setTitle(
        interaction.commandName === 'withdraw' ? '💸 Withdrawal Sent!' : '💸 Transfer Sent!'
      )
      .setDescription(
        `${interaction.user} sent **${formatTokenAmount(amountToken)} ${tokenSymbol}** (~$${usdValue.toFixed(2)} USD) to\n` +
          `\`\`\`\n${recipientPubkey.toBase58()}\n\`\`\`\n\n` +
          `[View on Solscan](https://solscan.io/tx/${signature})`
      )
      .setColor(0x00ff00)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error processing send:', error);
    try {
      await interaction.editReply({
        content: `${interaction.user} ❌ Failed to process transfer. Please try again later.`,
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
  // Also supports "$0.01 sol" or "$5 usdc" pattern
  const usdMatch = trimmed.match(/^\$(\d+\.?\d*)\s*([a-zA-Z]*)?$/i);
  if (usdMatch) {
    const value = parseFloat(usdMatch[1]);
    const tokenHint = usdMatch[2]?.toUpperCase();

    if (isNaN(value) || value <= 0) {
      return { valid: false, value: 0, error: 'Invalid USD amount' };
    }

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
