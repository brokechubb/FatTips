import {
  ButtonInteraction,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { PublicKey } from '@solana/web3.js';
import {
  BalanceService,
  PriceService,
  TransactionService,
  WalletService,
  TOKEN_MINTS,
  ConversionResult,
} from 'fattips-solana';
import { logTransaction } from '../utils/logger';

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

export async function handleBalanceDeposit(interaction: ButtonInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content: "You don't have a wallet yet. Use `/wallet action:create` to create one!",
      });
      return;
    }

    await interaction.editReply({
      content: `**Your Deposit Address:**\n\`\`\`\n${user.walletPubkey}\n\`\`\`\nSend SOL, USDC, or USDT to this address to fund your wallet.`,
    });
  } catch (error) {
    console.error('Error handling balance deposit:', error);
    await interaction.editReply({
      content: 'Failed to fetch deposit address. Please try again later.',
    });
  }
}

export async function handleBalanceHistory(interaction: ButtonInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content: "You don't have a wallet yet! Use `/wallet create` to get started.",
      });
      return;
    }

    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [{ fromId: user.discordId }, { toId: user.discordId }],
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    if (transactions.length === 0) {
      await interaction.editReply({
        content: 'No transactions found.',
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📜 Transaction History')
      .setColor(0x00aaff)
      .setTimestamp();

    let description = '';

    for (const tx of transactions) {
      const isSender = tx.fromId === user.discordId;
      const typeEmoji = isSender ? '📤' : '📥';
      const amount = Number(tx.amountToken).toFixed(4);
      let symbol = 'SOL';

      // Simple heuristic for symbol based on mint address
      if (tx.tokenMint === 'So11111111111111111111111111111111111111112') {
        symbol = 'SOL';
      } else if (tx.tokenMint.startsWith('EPj')) {
        symbol = 'USDC';
      } else if (tx.tokenMint.startsWith('Es9')) {
        symbol = 'USDT';
      }

      const date = tx.createdAt.toLocaleDateString();
      const time = tx.createdAt.toLocaleTimeString();

      let action: string = tx.txType;
      if (tx.txType === 'TIP') {
        action = isSender ? `Sent tip to <@${tx.toId}>` : `Received tip from <@${tx.fromId}>`;
      } else if (tx.txType === 'WITHDRAWAL') {
        const toAddr = (tx as any).toAddress || 'External Wallet';
        action = `Withdrawal to \`${toAddr.slice(0, 4)}...${toAddr.slice(-4)}\``;
      } else if (tx.txType === 'DEPOSIT') {
        action = 'Deposit';
      }

      description +=
        `${typeEmoji} **${action}**\n` +
        `> **${amount} ${symbol}** (~$${Number(tx.amountUsd).toFixed(2)})\n` +
        `> [Solscan](https://solscan.io/tx/${tx.signature}) • ${date} ${time}\n\n`;
    }

    embed.setDescription(description);

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching history:', error);
    await interaction.editReply({
      content: 'Failed to fetch history. Please try again later.',
    });
  }
}

export async function handleBalanceWithdraw(interaction: ButtonInteraction) {
  const modal = new ModalBuilder().setCustomId('withdraw_modal').setTitle('Withdraw Funds');

  const addressInput = new TextInputBuilder()
    .setCustomId('address')
    .setLabel('Solana Address')
    .setPlaceholder('Enter recipient wallet address')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('Amount')
    .setPlaceholder('Amount (e.g., 5 SOL, 10 USDC, all)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const firstActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(addressInput);
  const secondActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput);

  modal.addComponents(firstActionRow, secondActionRow);

  await interaction.showModal(modal);
}

export async function handleWithdrawModal(interaction: ModalSubmitInteraction) {
  if (interaction.customId !== 'withdraw_modal') return false;

  await interaction.deferReply({ ephemeral: true });

  try {
    const addressStr = interaction.fields.getTextInputValue('address').trim();
    const amountStr = interaction.fields.getTextInputValue('amount').trim();

    // Validate Address
    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(addressStr);
      if (!PublicKey.isOnCurve(recipientPubkey.toBuffer())) {
        throw new Error('Invalid address');
      }
    } catch {
      await interaction.editReply({ content: '❌ Invalid Solana address.' });
      return true;
    }

    // Parse Amount
    const parsedAmount = parseAmountInput(amountStr);
    if (!parsedAmount.valid) {
      await interaction.editReply({
        content: `❌ ${parsedAmount.error || 'Invalid amount format'}`,
      });
      return true;
    }

    // Get Sender
    const sender = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!sender) {
      await interaction.editReply({
        content: "❌ You don't have a wallet yet! Use `/wallet create` to create one.",
      });
      return true;
    }

    if (recipientPubkey.toBase58() === sender.walletPubkey) {
      await interaction.editReply({
        content: '❌ You cannot withdraw to your own bot wallet.',
      });
      return true;
    }

    // Calculate Amounts & Tokens
    let tokenSymbol: string;
    let tokenMint: string;
    let amountToken: number;
    let usdValue: number;

    const tokenMap: Record<string, { symbol: string; mint: string }> = {
      SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
      USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
      USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
    };

    if (parsedAmount.type === 'max') {
      // Handle Max Withdrawal
      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00001;
      const rentReserve = 0.001;

      // Smart token detection if not specified
      let preferredToken = parsedAmount.token ? parsedAmount.token.toUpperCase() : null;

      if (!preferredToken) {
        // Auto-detect based on available balance
        if (balances.sol > feeBuffer + rentReserve) {
          preferredToken = 'SOL';
        } else if (balances.usdc > 0) {
          preferredToken = 'USDC';
        } else if (balances.usdt > 0) {
          preferredToken = 'USDT';
        } else {
          preferredToken = 'SOL';
        }
      }

      const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];
      tokenSymbol = selectedToken.symbol;
      tokenMint = selectedToken.mint;

      if (tokenSymbol === 'SOL') {
        amountToken = Math.max(0, balances.sol - feeBuffer - rentReserve);
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
            `Required reserve: **${(feeBuffer + rentReserve).toFixed(5)} SOL** (to keep wallet active).\n` +
            `You can only withdraw funds above this amount.`,
        });
        return true;
      }

      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValue = price ? amountToken * price.price : 0;
      } catch {
        usdValue = 0;
      }

      // Skip balance check below since we calculated based on actual balance
    } else if (parsedAmount.type === 'usd') {
      // Handle USD Amount
      const preferredToken = parsedAmount.token ? parsedAmount.token.toUpperCase() : 'SOL';
      const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];
      tokenSymbol = selectedToken.symbol;
      tokenMint = selectedToken.mint;

      const conversion = await priceService.convertUsdToToken(
        parsedAmount.value,
        tokenMint,
        tokenSymbol
      );

      if (!conversion) {
        await interaction.editReply({ content: '❌ Price service unavailable.' });
        return true;
      }

      amountToken = conversion.amountToken;
      usdValue = parsedAmount.value;
    } else {
      // Handle Token Amount
      tokenSymbol = parsedAmount.token || 'SOL'; // Default to SOL if not specified
      const selectedToken = tokenMap[tokenSymbol] || tokenMap['SOL'];
      tokenSymbol = selectedToken.symbol;
      tokenMint = selectedToken.mint;
      amountToken = parsedAmount.value;

      try {
        const price = await priceService.getTokenPrice(tokenMint);
        usdValue = price ? amountToken * price.price : 0;
      } catch {
        usdValue = 0;
      }
    }

    if (amountToken <= 0) {
      await interaction.editReply({ content: '❌ Amount must be greater than 0.' });
      return true;
    }

    // Check Balances (skip for max since we calculated based on actual balance)
    if (parsedAmount.type !== 'max') {
      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00001;
      const rentReserve = 0.001;

      if (tokenSymbol === 'SOL') {
        const requiredSol = amountToken + feeBuffer + rentReserve;
        if (balances.sol < requiredSol) {
          await interaction.editReply({
            content:
              `${interaction.user} ❌ Insufficient funds!\n` +
              `**Required:** ${requiredSol.toFixed(5)} SOL\n` +
              `**Available:** ${balances.sol.toFixed(5)} SOL\n\n` +
              `Try using \`all\` to withdraw everything.`,
          });
          return true;
        }
      } else {
        const currentBal = tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;
        if (currentBal < amountToken) {
          await interaction.editReply({
            content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${amountToken} ${tokenSymbol}\n**Available:** ${currentBal} ${tokenSymbol}`,
          });
          return true;
        }
        if (balances.sol < feeBuffer) {
          await interaction.editReply({ content: '❌ Insufficient SOL for gas fees!' });
          return true;
        }
      }
    }

    // Execute Transfer
    const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
    const signature = await transactionService.transfer(
      senderKeypair,
      recipientPubkey.toBase58(),
      amountToken,
      tokenMint
    );

    // Record Transaction
    await prisma.transaction.create({
      data: {
        signature,
        fromId: sender.discordId,
        toAddress: recipientPubkey.toBase58(),
        amountUsd: usdValue,
        amountToken,
        tokenMint,
        usdRate: usdValue > 0 ? usdValue / amountToken : 0,
        txType: 'WITHDRAWAL',
        status: 'CONFIRMED',
      },
    });

    logTransaction('SEND', {
      fromId: sender.discordId,
      toId: recipientPubkey.toBase58(),
      amount: amountToken,
      token: tokenSymbol,
      signature,
      status: 'SUCCESS',
    });

    const embed = new EmbedBuilder()
      .setTitle('📤 Withdrawal Successful')
      .setDescription(
        `Sent **${formatTokenAmount(amountToken)} ${tokenSymbol}** (~$${usdValue.toFixed(2)}) to:\n\`${addressStr}\`\n\n[View on Solscan](https://solscan.io/tx/${signature})`
      )
      .setColor(0x00ff00)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error('Error handling withdraw modal:', error);
    await interaction.editReply({
      content: '❌ Withdrawal failed. Please try again.',
    });
    return true;
  }
}

// Helpers
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

// Handle /send and /withdraw form modals
export async function handleSendFormModal(interaction: ModalSubmitInteraction) {
  // Handle send_form (full form with address + amount)
  if (interaction.customId === 'send_form') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const addressStr = interaction.fields.getTextInputValue('address').trim();
      const amountStr = interaction.fields.getTextInputValue('amount').trim();

      // Validate Address
      let recipientPubkey: PublicKey;
      try {
        recipientPubkey = new PublicKey(addressStr);
        if (!PublicKey.isOnCurve(recipientPubkey.toBuffer())) {
          throw new Error('Invalid address');
        }
      } catch {
        await interaction.editReply({ content: '❌ Invalid Solana address.' });
        return true;
      }

      // Parse Amount
      const parsedAmount = parseAmountInput(amountStr);
      if (!parsedAmount.valid) {
        await interaction.editReply({
          content: `❌ ${parsedAmount.error || 'Invalid amount format'}`,
        });
        return true;
      }

      // Delegate to common send logic
      await processSendTransaction(interaction, recipientPubkey, parsedAmount, 'SOL');
      return true;
    } catch (error) {
      console.error('Error handling send form modal:', error);
      await interaction.editReply({
        content: '❌ Send failed. Please try again.',
      });
      return true;
    }
  }

  // Handle send_amount_form_{address}_{token} (amount-only form)
  if (interaction.customId.startsWith('send_amount_form_')) {
    await interaction.deferReply({ ephemeral: true });

    try {
      // Parse customId: send_amount_form_{address}_{token}
      const parts = interaction.customId.replace('send_amount_form_', '').split('_');
      const addressStr = parts[0];
      const tokenPreference = parts[1] || 'SOL';
      const amountStr = interaction.fields.getTextInputValue('amount').trim();

      // Validate Address
      let recipientPubkey: PublicKey;
      try {
        recipientPubkey = new PublicKey(addressStr);
        if (!PublicKey.isOnCurve(recipientPubkey.toBuffer())) {
          throw new Error('Invalid address');
        }
      } catch {
        await interaction.editReply({ content: '❌ Invalid Solana address.' });
        return true;
      }

      // Parse Amount
      const parsedAmount = parseAmountInput(amountStr);
      if (!parsedAmount.valid) {
        await interaction.editReply({
          content: `❌ ${parsedAmount.error || 'Invalid amount format'}`,
        });
        return true;
      }

      // Delegate to common send logic
      await processSendTransaction(interaction, recipientPubkey, parsedAmount, tokenPreference);
      return true;
    } catch (error) {
      console.error('Error handling send amount form modal:', error);
      await interaction.editReply({
        content: '❌ Send failed. Please try again.',
      });
      return true;
    }
  }

  return false;
}

// Common send/withdraw transaction processing
async function processSendTransaction(
  interaction: ModalSubmitInteraction,
  recipientPubkey: PublicKey,
  parsedAmount: ParsedAmount,
  tokenPreference: string
) {
  // Get Sender
  const sender = await prisma.user.findUnique({
    where: { discordId: interaction.user.id },
  });

  if (!sender) {
    await interaction.editReply({
      content: "❌ You don't have a wallet yet! Use `/wallet create` to create one.",
    });
    return;
  }

  if (recipientPubkey.toBase58() === sender.walletPubkey) {
    await interaction.editReply({
      content: '❌ You cannot send to your own bot wallet.',
    });
    return;
  }

  // Calculate Amounts & Tokens
  let tokenSymbol: string;
  let tokenMint: string;
  let amountToken: number;
  let usdValue: number;

  const tokenMap: Record<string, { symbol: string; mint: string }> = {
    SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
    USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
    USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
  };

  if (parsedAmount.type === 'max') {
    // Handle Max Withdrawal
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.00001;
    const rentReserve = 0.001;

    // Smart token detection if not specified
    let preferredToken = parsedAmount.token ? parsedAmount.token.toUpperCase() : null;

    if (!preferredToken) {
      // Auto-detect based on available balance
      if (balances.sol > feeBuffer + rentReserve) {
        preferredToken = 'SOL';
      } else if (balances.usdc > 0) {
        preferredToken = 'USDC';
      } else if (balances.usdt > 0) {
        preferredToken = 'USDT';
      } else {
        preferredToken = 'SOL';
      }
    }

    const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];
    tokenSymbol = selectedToken.symbol;
    tokenMint = selectedToken.mint;

    if (tokenSymbol === 'SOL') {
      amountToken = Math.max(0, balances.sol - feeBuffer - rentReserve);
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
          `Required reserve: **${(feeBuffer + rentReserve).toFixed(5)} SOL** (to keep wallet active).\n` +
          `You can only withdraw funds above this amount.`,
      });
      return;
    }

    try {
      const price = await priceService.getTokenPrice(tokenMint);
      usdValue = price ? amountToken * price.price : 0;
    } catch {
      usdValue = 0;
    }

    // Skip balance check below since we calculated based on actual balance
  } else if (parsedAmount.type === 'usd') {
    // Handle USD Amount
    const preferredToken = parsedAmount.token ? parsedAmount.token.toUpperCase() : tokenPreference;
    const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];
    tokenSymbol = selectedToken.symbol;
    tokenMint = selectedToken.mint;

    const conversion = await priceService.convertUsdToToken(
      parsedAmount.value,
      tokenMint,
      tokenSymbol
    );

    if (!conversion) {
      await interaction.editReply({ content: '❌ Price service unavailable.' });
      return;
    }

    amountToken = conversion.amountToken;
    usdValue = parsedAmount.value;
  } else {
    // Handle Token Amount
    tokenSymbol = parsedAmount.token || tokenPreference;
    const selectedToken = tokenMap[tokenSymbol] || tokenMap['SOL'];
    tokenSymbol = selectedToken.symbol;
    tokenMint = selectedToken.mint;
    amountToken = parsedAmount.value;

    try {
      const price = await priceService.getTokenPrice(tokenMint);
      usdValue = price ? amountToken * price.price : 0;
    } catch {
      usdValue = 0;
    }
  }

  if (amountToken <= 0) {
    await interaction.editReply({ content: '❌ Amount must be greater than 0.' });
    return;
  }

  // Check Balances (skip for max since we calculated based on actual balance)
  if (parsedAmount.type !== 'max') {
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.00001;
    const rentReserve = 0.001;

    if (tokenSymbol === 'SOL') {
      const requiredSol = amountToken + feeBuffer + rentReserve;
      if (balances.sol < requiredSol) {
        await interaction.editReply({
          content:
            `${interaction.user} ❌ Insufficient funds!\n` +
            `**Required:** ${requiredSol.toFixed(5)} SOL\n` +
            `**Available:** ${balances.sol.toFixed(5)} SOL\n\n` +
            `Try using \`all\` to send everything.`,
        });
        return;
      }
    } else {
      const currentBal = tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;
      if (currentBal < amountToken) {
        await interaction.editReply({
          content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${amountToken} ${tokenSymbol}\n**Available:** ${currentBal} ${tokenSymbol}`,
        });
        return;
      }
      if (balances.sol < feeBuffer) {
        await interaction.editReply({ content: '❌ Insufficient SOL for gas fees!' });
        return;
      }
    }
  }

  // Execute Transfer
  const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
  const signature = await transactionService.transfer(
    senderKeypair,
    recipientPubkey.toBase58(),
    amountToken,
    tokenMint
  );

  // Record Transaction
  await prisma.transaction.create({
    data: {
      signature,
      fromId: sender.discordId,
      toAddress: recipientPubkey.toBase58(),
      amountUsd: usdValue,
      amountToken,
      tokenMint,
      usdRate: usdValue > 0 ? usdValue / amountToken : 0,
      txType: 'WITHDRAWAL',
      status: 'CONFIRMED',
    },
  });

  logTransaction('SEND', {
    fromId: sender.discordId,
    toId: recipientPubkey.toBase58(),
    amount: amountToken,
    token: tokenSymbol,
    signature,
    status: 'SUCCESS',
  });

  const embed = new EmbedBuilder()
    .setTitle('📤 Transfer Successful')
    .setDescription(
      `Sent **${formatTokenAmount(amountToken)} ${tokenSymbol}** (~$${usdValue.toFixed(2)}) to:\n\`${recipientPubkey.toBase58()}\`\n\n[View on Solscan](https://solscan.io/tx/${signature})`
    )
    .setColor(0x00ff00)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
