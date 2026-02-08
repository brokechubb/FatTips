import {
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { PublicKey } from '@solana/web3.js';
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
  // Handle context menu token selection
  if (interaction.customId.startsWith('tip_token_')) {
    const targetUserId = interaction.customId.replace('tip_token_', '');
    const selectedToken = interaction.values[0];

    const modal = new ModalBuilder()
      .setCustomId(`tip_amount_${targetUserId}_${selectedToken}`)
      .setTitle(`Tip ${selectedToken}`);

    const amountInput = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Amount')
      .setPlaceholder('Enter amount (e.g., $5, 0.5 SOL, 10 USDC)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const firstActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput);
    modal.addComponents(firstActionRow);

    await interaction.showModal(modal);
    return true;
  }

  // Handle tip form token selection
  if (interaction.customId.startsWith('tip_form_token_')) {
    return handleTipFormTokenSelect(interaction);
  }

  return false;
}

// Handle token selection from the full tip form
async function handleTipFormTokenSelect(
  interaction: StringSelectMenuInteraction
): Promise<boolean> {
  const parts = interaction.customId.replace('tip_form_token_', '').split('_');
  const recipientIdsStr = parts[0];
  const amountStr = parts.slice(1).join('_'); // Handle amount with underscores
  const selectedToken = interaction.values[0];

  const modal = new ModalBuilder()
    .setCustomId(`tip_amount_form_${recipientIdsStr}_${selectedToken}_split`)
    .setTitle(`Confirm Tip 💸`);

  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('Amount')
    .setValue(amountStr)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
  return true;
}

export async function handleTipModal(interaction: ModalSubmitInteraction) {
  // Handle tip form modal (full form with recipients and amount)
  if (interaction.customId === 'tip_form_recipients') {
    return handleTipFormModal(interaction);
  }

  // Handle amount form modal (recipients provided via command, amount via modal)
  if (interaction.customId.startsWith('tip_amount_form_')) {
    return handleTipAmountFormModal(interaction);
  }

  // Handle context menu tip modal
  if (!interaction.customId.startsWith('tip_amount_')) return false;

  const parts = interaction.customId.replace('tip_amount_', '').split('_');
  const targetUserId = parts[0];
  const tokenSymbol = parts[1];

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

    if (parsedAmount.type === 'usd') {
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

    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.00002;
    const rentReserve = 0.001;

    if (tokenSymbol === 'SOL') {
      const requiredSol = amountToken + feeBuffer + rentReserve;
      if (balances.sol < requiredSol) {
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

// Handle the full tip form modal (recipients + amount)
async function handleTipFormModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const recipientsStr = interaction.fields.getTextInputValue('recipients');
  const amountStr = interaction.fields.getTextInputValue('amount');

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
    return true;
  }

  if (validRecipientIds.length > 10) {
    await interaction.reply({
      content: '❌ You can tip up to 10 users at once.',
      ephemeral: true,
    });
    return true;
  }

  // Now show token selection menu
  const select = new StringSelectMenuBuilder()
    .setCustomId(`tip_form_token_${validRecipientIds.join(',')}_${amountStr}`)
    .setPlaceholder('Select a token to tip')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('SOL')
        .setDescription('Solana native token')
        .setValue('SOL')
        .setEmoji('💎'),
      new StringSelectMenuOptionBuilder()
        .setLabel('USDC')
        .setDescription('USD Coin')
        .setValue('USDC')
        .setEmoji('💵'),
      new StringSelectMenuOptionBuilder()
        .setLabel('USDT')
        .setDescription('Tether USD')
        .setValue('USDT')
        .setEmoji('💸')
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  await interaction.reply({
    content: `💸 Select which token to send to ${validRecipientIds.length} recipient(s):`,
    components: [row],
    ephemeral: true,
  });

  return true;
}

// Handle the amount-only form modal (recipients already provided)
async function handleTipAmountFormModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  const parts = interaction.customId.replace('tip_amount_form_', '').split('_');
  const recipientIdsStr = parts[0];
  const tokenPreference = parts[1] || 'SOL';
  // const mode = parts[2] || 'split'; // TODO: Implement split/each mode logic

  const recipientIds = recipientIdsStr.split(',');
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

    const sender = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!sender) {
      await interaction.editReply({
        content: `${interaction.user} ❌ You don't have a wallet yet! Use \`/wallet create\` to create one.`,
      });
      return true;
    }

    // Process all recipients
    const recipientWallets = [];
    const newWallets: { id: string; key: string }[] = [];

    for (const recipientId of recipientIds) {
      let recipient = await prisma.user.findUnique({
        where: { discordId: recipientId },
      });

      if (!recipient) {
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
      }
      recipientWallets.push(recipient);
    }

    const tokenMap: Record<string, { symbol: string; mint: string }> = {
      SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
      USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
      USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
    };

    const preferredToken = parsedAmount.token ? parsedAmount.token.toUpperCase() : tokenPreference;
    const selectedToken = tokenMap[preferredToken] || tokenMap['SOL'];
    const tokenSymbol = selectedToken.symbol;
    const tokenMint = selectedToken.mint;

    let amountPerUser: number;
    let totalAmountToken: number;
    let usdValuePerUser: number;

    if (parsedAmount.type === 'usd') {
      const conversion = await priceService.convertUsdToToken(
        parsedAmount.value,
        tokenMint,
        tokenSymbol
      );
      if (!conversion) {
        await interaction.editReply({ content: '❌ Price service unavailable.' });
        return true;
      }
      amountPerUser = conversion.amountToken;
      totalAmountToken = amountPerUser * recipientWallets.length;
      usdValuePerUser = parsedAmount.value;
    } else {
      amountPerUser = parsedAmount.value;
      totalAmountToken = amountPerUser * recipientWallets.length;
      const price = await priceService.getTokenPrice(tokenMint);
      usdValuePerUser = price ? amountPerUser * price.price : 0;
    }

    if (amountPerUser <= 0) {
      await interaction.editReply({ content: '❌ Amount too small!' });
      return true;
    }

    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.00002;
    const rentReserve = 0.001;
    const epsilon = 0.000001; // Tolerance for floating point precision issues

    if (tokenSymbol === 'SOL') {
      const requiredSol = totalAmountToken + feeBuffer + rentReserve;
      // Use epsilon to handle floating point precision issues, especially for "max" amounts
      if (balances.sol + epsilon < requiredSol) {
        await interaction.editReply({
          content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${requiredSol.toFixed(5)} SOL\n**Available:** ${balances.sol.toFixed(5)} SOL`,
        });
        return true;
      }
    } else {
      const currentBal = tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;
      if (currentBal < totalAmountToken) {
        await interaction.editReply({
          content: `${interaction.user} ❌ Insufficient funds!\n**Required:** ${totalAmountToken} ${tokenSymbol}\n**Available:** ${currentBal} ${tokenSymbol}`,
        });
        return true;
      }
      if (balances.sol < feeBuffer) {
        await interaction.editReply({ content: '❌ Insufficient SOL for gas fees!' });
        return true;
      }
    }

    const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

    const transfers = recipientWallets.map((r) => ({
      recipient: r.walletPubkey,
      amount: amountPerUser,
    }));

    const signature = await transactionService.batchTransfer(senderKeypair, transfers, tokenMint);

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

    if (newWallets.length > 0) {
      embed.addFields({
        name: '🆕 New Wallets Created',
        value: `Created wallets for ${newWallets.length} new users. Check DMs!`,
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // Send DMs
    for (const recipient of recipientWallets) {
      try {
        const user = await interaction.client.users.fetch(recipient.discordId);
        const isNew = newWallets.find((w) => w.id === recipient.discordId);

        let msg = `🎉 You received **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** (~$${usdValuePerUser.toFixed(2)}) from ${interaction.user.username}!`;

        if (isNew) {
          msg += `\n\n**🔐 New Wallet Key:**\n\`\`\`\n${isNew.key}\n\`\`\`\n*Self-destructs in 15m.*`;
          const sentMsg = await user.send(msg);

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
          await user.send({ embeds: [guideEmbed] });

          await prisma.user.update({
            where: { discordId: recipient.discordId },
            data: { seedDelivered: true },
          });
        } else {
          await user.send(msg);
        }
      } catch {
        // DM failed, ignore
      }
    }

    return true;
  } catch (error) {
    console.error('Error in tip amount form modal:', error);
    await interaction.editReply({ content: '❌ An unexpected error occurred.' });
    return true;
  }
}

// Handle user select menu for recipient selection
export async function handleTipUserSelect(
  interaction: UserSelectMenuInteraction
): Promise<boolean> {
  if (interaction.customId !== 'tip_select_recipients') return false;

  const selectedUserIds = interaction.values;

  // Filter out invalid targets (self, bot)
  const validRecipientIds = selectedUserIds.filter(
    (id) => id !== interaction.user.id && id !== interaction.client.user?.id
  );

  if (validRecipientIds.length === 0) {
    await interaction.update({
      content: '❌ No valid recipients selected! (You cannot tip yourself or the bot)',
      components: [],
    });
    return true;
  }

  // Show token selection menu
  const select = new StringSelectMenuBuilder()
    .setCustomId(`tip_form_token_${validRecipientIds.join(',')}_`)
    .setPlaceholder('Select a token to tip')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('SOL')
        .setDescription('Solana native token')
        .setValue('SOL')
        .setEmoji('💎'),
      new StringSelectMenuOptionBuilder()
        .setLabel('USDC')
        .setDescription('USD Coin')
        .setValue('USDC')
        .setEmoji('💵'),
      new StringSelectMenuOptionBuilder()
        .setLabel('USDT')
        .setDescription('Tether USD')
        .setValue('USDT')
        .setEmoji('💸')
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const mentions = validRecipientIds.map((id) => `<@${id}>`).join(', ');
  await interaction.update({
    content: `💸 Selected recipients: ${mentions}\n\nNow choose which token to send:`,
    components: [row],
  });

  return true;
}

// Handle send/withdraw form modal
export async function handleSendModal(interaction: ModalSubmitInteraction): Promise<boolean> {
  // Handle full form modal (address + amount)
  if (interaction.customId === 'send_form') {
    const address = interaction.fields.getTextInputValue('address');
    const amountStr = interaction.fields.getTextInputValue('amount');

    // Show token selection
    const select = new StringSelectMenuBuilder()
      .setCustomId(`send_token_${address}_${amountStr}`)
      .setPlaceholder('Select a token to send')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('SOL')
          .setDescription('Solana native token')
          .setValue('SOL')
          .setEmoji('💎'),
        new StringSelectMenuOptionBuilder()
          .setLabel('USDC')
          .setDescription('USD Coin')
          .setValue('USDC')
          .setEmoji('💵'),
        new StringSelectMenuOptionBuilder()
          .setLabel('USDT')
          .setDescription('Tether USD')
          .setValue('USDT')
          .setEmoji('💸')
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.reply({
      content: `💸 Sending to: \`${address}\`\nAmount: ${amountStr}\n\nSelect which token:`,
      components: [row],
      ephemeral: true,
    });

    return true;
  }

  // Handle amount-only modal
  if (interaction.customId.startsWith('send_amount_form_')) {
    const parts = interaction.customId.replace('send_amount_form_', '').split('_');
    const address = parts[0];
    // const tokenPreference = parts[1] || 'SOL'; // Reserved for future default token selection
    const amountStr = interaction.fields.getTextInputValue('amount');

    // Show token selection
    const select = new StringSelectMenuBuilder()
      .setCustomId(`send_token_${address}_${amountStr}`)
      .setPlaceholder('Select a token to send')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('SOL')
          .setDescription('Solana native token')
          .setValue('SOL')
          .setEmoji('💎'),
        new StringSelectMenuOptionBuilder()
          .setLabel('USDC')
          .setDescription('USD Coin')
          .setValue('USDC')
          .setEmoji('💵'),
        new StringSelectMenuOptionBuilder()
          .setLabel('USDT')
          .setDescription('Tether USD')
          .setValue('USDT')
          .setEmoji('💸')
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    await interaction.reply({
      content: `💸 Sending to: \`${address}\`\nAmount: ${amountStr}\n\nSelect which token:`,
      components: [row],
      ephemeral: true,
    });

    return true;
  }

  return false;
}

// Handle send token selection
export async function handleSendTokenSelect(
  interaction: StringSelectMenuInteraction
): Promise<boolean> {
  if (!interaction.customId.startsWith('send_token_')) return false;

  const parts = interaction.customId.replace('send_token_', '').split('_');
  const address = parts[0];
  const amountStr = parts[1];
  const selectedToken = interaction.values[0];

  await interaction.deferReply({ ephemeral: true });

  try {
    // Validate the Solana address
    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(address);
      // Verify it's a valid pubkey
      if (!PublicKey.isOnCurve(recipientPubkey.toBytes())) {
        throw new Error('Address is not on the ed25519 curve');
      }
    } catch {
      await interaction.editReply({
        content:
          `${interaction.user} ❌ Invalid Solana address!\n\n` +
          `Please provide a valid Solana wallet address.`,
      });
      return true;
    }

    // Get sender's wallet
    const sender = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!sender) {
      await interaction.editReply({
        content: `${interaction.user} ❌ You don't have a wallet yet! Use \`/wallet create\` to create one.`,
      });
      return true;
    }

    // Prevent sending to self
    if (recipientPubkey.toBase58() === sender.walletPubkey) {
      await interaction.editReply({
        content: `${interaction.user} ❌ You can't send funds to yourself!`,
      });
      return true;
    }

    // Parse amount
    const parsedAmount = parseAmountInput(amountStr);

    if (!parsedAmount.valid) {
      await interaction.editReply({
        content: `❌ ${parsedAmount.error}\n\nExamples:\n• $5\n• 0.5 SOL\n• all`,
      });
      return true;
    }

    // Determine token
    const tokenMap: Record<string, { symbol: string; mint: string }> = {
      SOL: { symbol: 'SOL', mint: TOKEN_MINTS.SOL },
      USDC: { symbol: 'USDC', mint: TOKEN_MINTS.USDC },
      USDT: { symbol: 'USDT', mint: TOKEN_MINTS.USDT },
    };

    const tokenSymbol = parsedAmount.token ? parsedAmount.token.toUpperCase() : selectedToken;
    const selectedTokenData = tokenMap[tokenSymbol] || tokenMap['SOL'];
    const tokenMint = selectedTokenData.mint;

    // Calculate amount
    let amountToken: number;
    let usdValue: number;

    if (parsedAmount.type === 'max') {
      const balances = await balanceService.getBalances(sender.walletPubkey);
      const feeBuffer = 0.00001;
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
          content: `${interaction.user} ❌ Insufficient balance!`,
        });
        return true;
      }

      const price = await priceService.getTokenPrice(tokenMint);
      usdValue = price ? amountToken * price.price : 0;
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
      await interaction.editReply({ content: '❌ Amount must be greater than 0!' });
      return true;
    }

    // Check balance
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
          content: `${interaction.user} ❌ Insufficient ${tokenSymbol} balance!`,
        });
        return true;
      }
      if (balances.sol < feeBuffer) {
        await interaction.editReply({ content: '❌ Insufficient SOL for gas fees!' });
        return true;
      }
    }

    // Check for rent exemption on new accounts
    if (tokenSymbol === 'SOL' && amountToken < 0.001) {
      try {
        const recipientBalances = await balanceService.getBalances(recipientPubkey.toBase58());
        if (recipientBalances.sol === 0) {
          const minRent = 0.00089088;
          if (amountToken < minRent) {
            await interaction.editReply({
              content:
                `${interaction.user} ❌ Transaction rejected!\n\n` +
                `The recipient wallet is new or empty.\n` +
                `Solana requires a minimum of **${minRent} SOL** to activate a new wallet.`,
            });
            return true;
          }
        }
      } catch {
        // Ignore error checking recipient balance
      }
    }

    // Execute transfer
    const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

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
      return true;
    }

    // Log to database
    await prisma.transaction.create({
      data: {
        signature,
        fromId: sender.discordId,
        toId: null as unknown as string, // External transfer
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

    logTransaction('SEND', {
      fromId: sender.discordId,
      toId: recipientPubkey.toBase58(),
      amount: amountToken,
      token: tokenSymbol,
      signature,
      status: 'SUCCESS',
    });

    // Send success message
    const embed = new EmbedBuilder()
      .setTitle('💸 Transfer Sent!')
      .setDescription(
        `${interaction.user} sent **${formatTokenAmount(amountToken)} ${tokenSymbol}** (~$${usdValue.toFixed(2)} USD) to\n` +
          `\`\`\`\n${recipientPubkey.toBase58()}\n\`\`\`\n\n` +
          `[View on Solscan](https://solscan.io/tx/${signature})`
      )
      .setColor(0x00ff00)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    return true;
  } catch (error) {
    console.error('Error in send token select:', error);
    await interaction.editReply({ content: '❌ An unexpected error occurred.' });
    return true;
  }
}
