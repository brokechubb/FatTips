import {
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { logTransaction } from '../utils/logger';
import {
  PriceService,
  TOKEN_MINTS,
  TransactionService,
  WalletService,
  BalanceService,
} from 'fattips-solana';

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

export async function handleTipSelectMenu(interaction: StringSelectMenuInteraction) {
  // Handle context menu token selection only
  if (!interaction.customId.startsWith('tip_token_')) return false;
  // Deprecated: Context menu now opens modal directly
  return false;
}

export async function handleTipModal(interaction: ModalSubmitInteraction) {
  // Handle context menu tip modal only
  if (!interaction.customId.startsWith('tip_modal_')) return false;

  const targetUserId = interaction.customId.replace('tip_modal_', '');
  const amountStr = interaction.fields.getTextInputValue('amount');

  await interaction.deferReply({ ephemeral: true });

  try {
    const parsedAmount = parseAmountInput(amountStr);

    if (!parsedAmount.valid) {
      await interaction.editReply({
        content: `❌ ${parsedAmount.error}\n\nExamples:\n• $5\n• 0.5 SOL\n• 10 USDC`,
      });
      return true;
    }

    // Default to SOL if no token specified
    const tokenSymbol = parsedAmount.token || 'SOL';

    const sender = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!sender) {
      await interaction.editReply({
        content: `${interaction.user} ❌ You don't have a wallet yet! Use \`/wallet create\` to create one.`,
      });
      return true;
    }

    let recipient = await prisma.user.findUnique({
      where: { discordId: targetUserId },
    });

    let newWalletKey: string | null = null;

    if (!recipient) {
      const wallet = walletService.createEncryptedWallet();
      recipient = await prisma.user.create({
        data: {
          discordId: targetUserId,
          walletPubkey: wallet.publicKey,
          encryptedPrivkey: wallet.encryptedPrivateKey,
          keySalt: wallet.keySalt,
          encryptedMnemonic: wallet.encryptedMnemonic,
          mnemonicSalt: wallet.mnemonicSalt,
          seedDelivered: false,
        },
      });
      newWalletKey = wallet.privateKeyBase58;
    }

    const tokenMap: Record<string, { symbol: string; mint: string }> = {
      SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
      USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
      USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
    };

    const selectedToken = tokenMap[tokenSymbol] || tokenMap['SOL'];
    const tokenMint = selectedToken.mint;

    let amountToken: number;
    let usdValue: number;
    let skipBalanceCheck = false;

    if (parsedAmount.type === 'max') {
      // Handle max/all - calculate based on actual balance
      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00002;
      const rentReserve = 0.001;

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
            `${interaction.user} ❌ Insufficient balance!\\n` +
            `You have **${balances.sol.toFixed(6)} SOL**.\\n` +
            `Required reserve: **${(feeBuffer + rentReserve).toFixed(5)} SOL** (to keep wallet active).`,
        });
        return true;
      }

      const price = await priceService.getTokenPrice(tokenMint);
      usdValue = price ? amountToken * price.price : 0;
      skipBalanceCheck = true;
    } else if (parsedAmount.type === 'usd') {
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
      amountToken = parsedAmount.value;
      const price = await priceService.getTokenPrice(tokenMint);
      usdValue = price ? amountToken * price.price : 0;
    }

    if (amountToken <= 0) {
      await interaction.editReply({ content: '❌ Amount too small!' });
      return true;
    }

    // Skip balance check for 'max' since we calculated based on actual balance
    if (!skipBalanceCheck) {
      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00002;
      const rentReserve = 0.001;
      const epsilon = 0.000001;

      if (tokenSymbol === 'SOL') {
        const requiredSol = amountToken + feeBuffer + rentReserve;
        if (balances.sol + epsilon < requiredSol) {
          await interaction.editReply({
            content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${requiredSol.toFixed(5)} SOL\n**Available:** ${balances.sol.toFixed(5)} SOL`,
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

    const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

    const signature = await transactionService.transfer(
      senderKeypair,
      recipient.walletPubkey,
      amountToken,
      tokenMint
    );

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

    const targetUser = await interaction.client.users.fetch(targetUserId);
    const embed = new EmbedBuilder()
      .setTitle('💸 Tip Sent!')
      .setDescription(
        `**${interaction.user}** tipped **${targetUser}**!\n\n` +
          `**Amount:** ${formatTokenAmount(amountToken)} ${tokenSymbol} (~$${usdValue.toFixed(2)})\n\n` +
          `[View on Solscan](https://solscan.io/tx/${signature})`
      )
      .setColor(0x00ff00)
      .setTimestamp();

    if (newWalletKey) {
      embed.addFields({
        name: '🆕 New Wallet Created',
        value: 'A new wallet was created for the recipient. Check their DMs!',
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // Send DM to recipient
    try {
      let msg = `🎉 You received **${formatTokenAmount(amountToken)} ${tokenSymbol}** (~$${usdValue.toFixed(2)}) from ${interaction.user.username}!`;

      if (newWalletKey) {
        msg += `\n\n**🔐 New Wallet Key:**\n\`\`\`\n${newWalletKey}\n\`\`\`\n*Self-destructs in 15m.*`;
        const sentMsg = await targetUser.send(msg);

        setTimeout(async () => {
          try {
            await sentMsg.edit('🔒 **Key removed for security.**');
          } catch {
            // Message might have been deleted, ignore
          }
        }, 900000);

        const guideEmbed = new EmbedBuilder()
          .setTitle('🚀 Welcome to FatTips')
          .setDescription('You just received crypto! Use `/balance` to check it.')
          .setColor(0x00aaff);
        await targetUser.send({ embeds: [guideEmbed] });

        await prisma.user.update({
          where: { discordId: targetUserId },
          data: { seedDelivered: true },
        });
      } else {
        await targetUser.send(msg);
      }
    } catch {
      // DM failed, ignore
    }

    return true;
  } catch (error) {
    console.error('Error in tip modal:', error);
    await interaction.editReply({ content: '❌ An unexpected error occurred.' });
    return true;
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
