import {
  Message,
  Client,
  EmbedBuilder,
  TextChannel,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageReaction,
  User,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { logger } from '../utils/logger';
import {
  PriceService,
  TOKEN_MINTS,
  TransactionService,
  WalletService,
  BalanceService,
} from 'fattips-solana';
import { activityService } from '../services/activity';

export const DEFAULT_PREFIX = 'f';
const DISCORD_CANNOT_DM = 50007;

// Cache for guild prefixes (refresh every 5 minutes)
const prefixCache = new Map<string, { prefix: string; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

/**
 * Get the prefix for a guild (cached)
 */
export async function getGuildPrefix(guildId: string | null): Promise<string> {
  if (!guildId) return DEFAULT_PREFIX; // DMs use default

  const cached = prefixCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.prefix;
  }

  const settings = await prisma.guildSettings.findUnique({
    where: { guildId },
  });

  const prefix = settings?.prefix || DEFAULT_PREFIX;
  prefixCache.set(guildId, { prefix, expiresAt: Date.now() + CACHE_TTL });
  return prefix;
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
    return { valid: true, type: 'token', value, token: tokenMatch[2]?.toUpperCase() || 'SOL' };
  }

  return { valid: false, value: 0, error: 'Invalid format. Try: $5, 0.5 SOL, or max' };
}

function formatTokenAmount(amount: number): string {
  if (amount < 0.0001) return amount.toExponential(2);
  if (amount < 1) return amount.toFixed(6);
  if (amount < 100) return amount.toFixed(4);
  return amount.toFixed(2);
}

/**
 * Handle prefix commands ($$command or custom prefix)
 */
export async function handlePrefixCommand(message: Message, client: Client) {
  if (message.author.bot) return;

  // Get the prefix for this guild (or default for DMs)
  const prefix = await getGuildPrefix(message.guild?.id || null);

  let commandName: string | undefined;
  let args: string[] = [];

  if (message.content.startsWith(prefix)) {
    // Normal command with prefix
    args = message.content.slice(prefix.length).trim().split(/\s+/);
    commandName = args.shift()?.toLowerCase();
  } else if (message.channel.type === ChannelType.DM) {
    // DM: Treat as command without prefix
    args = message.content.trim().split(/\s+/);
    commandName = args.shift()?.toLowerCase();
  } else {
    // Not a command
    return;
  }

  if (!commandName) return;

  try {
    switch (commandName) {
      case 'help':
        await handleHelp(message, prefix);
        break;
      case 'balance':
      case 'bal':
      case 'bals':
        await handleBalance(message, prefix);
        break;
      case 'deposit':
        await handleDeposit(message, prefix);
        break;
      case 'wallet':
        await handleWallet(message, args, prefix);
        break;
      case 'tip':
        await handleTip(message, args, client, prefix);
        break;
      case 'send':
        await handleSend(message, args, prefix);
        break;
      case 'history':
        await handleHistory(message);
        break;
      case 'withdraw':
        await handleWithdraw(message, args, prefix);
        break;
      case 'airdrop':
        await handleAirdrop(message, args, client, prefix);
        break;
      case 'rain':
        await handleRain(message, args, client, prefix);
        break;
      case 'setprefix':
        await handleSetPrefix(message, args);
        break;
      default:
        // Unknown command - ignore silently
        break;
    }
  } catch (error) {
    logger.error(`Error in prefix command ${commandName}:`, error);
    await message.reply('❌ An error occurred. Please try again.').catch(() => {});
  }
}

// ============ HELP ============
async function handleHelp(message: Message, prefix: string) {
  const p = prefix; // shorthand
  const embed = new EmbedBuilder()
    .setTitle('💰 FatTips Commands')
    .setDescription(
      `Send crypto tips instantly on Discord!\n` +
        `**Prefix:** \`${prefix}\` (recommended for guilds)\n\n` +
        `💡 **Pro Tips:**\n` +
        `• Reply to any message with \`${p}tip $5\` to tip the author\n` +
        `• Amount can go anywhere: \`${p}tip $5 @user\` or \`${p}tip @user $5\`\n` +
        `• Slash commands also available: \`/tip user:@user amount:$5\``
    )
    .setColor(0x00ff00)
    .addFields(
      {
        name: '💸 Tipping & Fun',
        value:
          `\`${p}tip @user $5\` • \`${p}tip 0.1 SOL\`\n` +
          `\`${p}rain $10 5\` (Active users)\n` +
          `\`${p}airdrop $20 10m\``,
      },
      {
        name: '💰 Wallet & Transfers',
        value:
          `\`${p}balance\` • \`${p}deposit\` • \`${p}history\`\n` +
          `\`${p}send <addr> $10\` • \`${p}withdraw <addr> all\`\n` +
          `\`${p}wallet create\` • \`${p}wallet export-key\``,
      },
      {
        name: '⚙️ Info',
        value:
          `\`${p}help\` • \`${p}setprefix <new>\`\n` + `*Slash commands available for all actions*`,
      }
    )
    .setFooter({
      text: '⚡ Prefix commands recommended for guilds | Large tips (>$20) require confirmation',
    });

  await message.reply({ embeds: [embed] });
}

// ============ BALANCE ============
async function handleBalance(message: Message, prefix: string) {
  const user = await prisma.user.findUnique({
    where: { discordId: message.author.id },
  });

  if (!user) {
    await message.reply(
      `❌ You don't have a wallet yet! Use \`${prefix}wallet create\` to create one.`
    );
    return;
  }

  const balances = await balanceService.getBalances(user.walletPubkey);

  const embed = new EmbedBuilder()
    .setTitle('💰 Your Wallet')
    .setDescription(`\`${user.walletPubkey}\``)
    .addFields(
      { name: 'SOL', value: `${balances.sol.toFixed(6)}`, inline: true },
      { name: 'USDC', value: `${balances.usdc.toFixed(2)}`, inline: true },
      { name: 'USDT', value: `${balances.usdt.toFixed(2)}`, inline: true }
    )
    .setColor(0x00ff00)
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// ============ WALLET ============
async function handleWallet(message: Message, args: string[], prefix: string) {
  const action = args[0]?.toLowerCase();

  if (action === 'create') {
    const existing = await prisma.user.findUnique({
      where: { discordId: message.author.id },
    });

    if (existing) {
      await message.reply(`You already have a wallet!\nAddress: \`${existing.walletPubkey}\``);
      return;
    }

    const wallet = walletService.createEncryptedWallet();
    await prisma.user.create({
      data: {
        discordId: message.author.id,
        walletPubkey: wallet.publicKey,
        encryptedPrivkey: wallet.encryptedPrivateKey,
        keySalt: wallet.keySalt,
        encryptedMnemonic: wallet.encryptedMnemonic,
        mnemonicSalt: wallet.mnemonicSalt,
        seedDelivered: false,
      },
    });

    // Try to DM the private key
    try {
      const dmMsg = await message.author.send(
        `🎉 **Wallet Created!**\n\n` +
          `**Address:** \`${wallet.publicKey}\`\n\n` +
          `**Private Key:**\n\`\`\`${wallet.privateKeyBase58}\`\`\`\n` +
          `⚠️ **Save this key! This message self-destructs in 15 minutes.**`
      );

      setTimeout(async () => {
        try {
          await dmMsg.edit(
            `🔒 **Private key removed for security.** Use \`${prefix}wallet export-key\` to view again.`
          );
        } catch {}
      }, 900000);

      await prisma.user.update({
        where: { discordId: message.author.id },
        data: { seedDelivered: true },
      });

      await message.reply(
        `✅ Wallet created! Check your DMs for the private key.\nAddress: \`${wallet.publicKey}\``
      );
    } catch (error: any) {
      if (error.code === DISCORD_CANNOT_DM) {
        await message.reply(
          `✅ Wallet created!\nAddress: \`${wallet.publicKey}\`\n\n` +
            `⚠️ I couldn't DM you the private key. Use \`${prefix}wallet export-key\` in DMs to get it.`
        );
      }
    }
  } else if (action === 'export-key') {
    // Only allow in DMs for security
    if (message.guild) {
      await message.reply('⚠️ For security, use this command in DMs with the bot.');
      return;
    }

    const user = await prisma.user.findUnique({
      where: { discordId: message.author.id },
    });

    if (!user) {
      await message.reply(`❌ You don't have a wallet yet! Use \`${prefix}wallet create\` first.`);
      return;
    }

    const privateKey = walletService.decryptPrivateKey(user.encryptedPrivkey, user.keySalt);

    const dmMsg = await message.reply(
      `🔐 **Your Private Key:**\n\`\`\`${privateKey}\`\`\`\n` +
        `⚠️ This message self-destructs in 15 minutes.`
    );

    setTimeout(async () => {
      try {
        await dmMsg.edit('🔒 **Private key removed for security.**');
      } catch {}
    }, 900000);
  } else {
    await message.reply(`Usage: \`${prefix}wallet create\` or \`${prefix}wallet export-key\``);
  }
}

// ============ TIP ============
async function handleTip(message: Message, args: string[], client: Client, prefix: string) {
  const mentions = message.mentions.users.filter((u) => !u.bot && u.id !== message.author.id);
  let amountArg: string | null = null;

  // Check for reply-to-tip feature
  if (mentions.size === 0 && message.reference?.messageId) {
    try {
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (
        repliedMsg.author &&
        !repliedMsg.author.bot &&
        repliedMsg.author.id !== message.author.id
      ) {
        message.mentions.users.set(repliedMsg.author.id, repliedMsg.author);
        amountArg = args.join(' ');
      }
    } catch {
      // Failed to fetch replied message
    }
  }

  // Support flexible parsing - amount can be anywhere in args
  if (mentions.size === 0 && message.mentions.users.size === 0) {
    await message.reply(
      `Usage: \`${prefix}tip @user $5\` or reply to a message with \`${prefix}tip $5\``
    );
    return;
  }

  const targetUsers = mentions.size > 0 ? mentions : message.mentions.users;

  // Find amount in args (skip mentions, amount can be anywhere)
  if (!amountArg) {
    amountArg = args.filter((a: string) => !a.startsWith('<@')).join(' ');
  }
  const parsedAmount = parseAmountInput(amountArg);

  if (!parsedAmount.valid) {
    await message.reply(
      `❌ ${parsedAmount.error}\nUsage: \`${prefix}tip @user $5\` or \`${prefix}tip $5 @user\``
    );
    return;
  }

  // Get sender wallet
  const sender = await prisma.user.findUnique({
    where: { discordId: message.author.id },
  });

  if (!sender) {
    await message.reply(`❌ You don't have a wallet yet! Use \`${prefix}wallet create\` first.`);
    return;
  }

  // Process recipients
  const recipientWallets = [];
  const newWallets: { id: string; key: string }[] = [];

  for (const [recipientId, recipientUser] of targetUsers) {
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

  // Calculate amounts
  const tokenSymbol = parsedAmount.token || 'SOL';
  const tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS] || TOKEN_MINTS.SOL;
  let amountToken: number;
  let usdValue: number;

  if (parsedAmount.type === 'usd') {
    const conversion = await priceService.convertUsdToToken(
      parsedAmount.value,
      tokenMint,
      tokenSymbol
    );
    if (!conversion) {
      await message.reply('❌ Failed to fetch prices. Try again.');
      return;
    }
    amountToken = conversion.amountToken;
    usdValue = parsedAmount.value;
  } else if (parsedAmount.type === 'max') {
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.002;
    amountToken =
      tokenSymbol === 'SOL'
        ? Math.max(0, balances.sol - feeBuffer)
        : tokenSymbol === 'USDC'
          ? balances.usdc
          : balances.usdt;

    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? amountToken * price.price : 0;
  } else {
    amountToken = parsedAmount.value;
    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? amountToken * price.price : 0;
  }

  const amountPerUser = amountToken / recipientWallets.length;
  const usdPerUser = usdValue / recipientWallets.length;

  // Check for large amount confirmation (> $20)
  if (usdValue > 20) {
    const confirmMsg = await message.reply({
      content:
        `⚠️ **Large Transaction Warning**\n\n` +
        `You're about to send **$${usdValue.toFixed(2)}** (${formatTokenAmount(amountToken)} ${tokenSymbol}) to ${recipientWallets.length} user(s).\n\n` +
        `React with ✅ to confirm or ❌ to cancel.`,
    });

    await confirmMsg.react('✅');
    await confirmMsg.react('❌');

    const filter = (reaction: MessageReaction, user: User) => {
      return ['✅', '❌'].includes(reaction.emoji.name ?? '') && user.id === message.author.id;
    };

    try {
      const collected = await confirmMsg.awaitReactions({
        filter,
        max: 1,
        time: 30000,
        errors: ['time'],
      });
      const reaction = collected.first();

      if (reaction?.emoji.name === '❌') {
        await confirmMsg.edit({ content: '❌ Transaction cancelled.', embeds: [] });
        return;
      }

      await confirmMsg.delete().catch(() => {});
    } catch {
      await confirmMsg.edit({
        content: '⏰ Confirmation timed out. Transaction cancelled.',
        embeds: [],
      });
      return;
    }
  }

  if (amountPerUser <= 0) {
    await message.reply('❌ Amount too small!');
    return;
  }

  // Check balance
  const balances = await balanceService.getBalances(sender.walletPubkey);
  const required = tokenSymbol === 'SOL' ? amountToken + 0.002 : amountToken;
  const available =
    tokenSymbol === 'SOL' ? balances.sol : tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;

  if (available < required) {
    await message.reply(
      `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol}, have ${available.toFixed(4)}`
    );
    return;
  }

  // Execute transfer
  const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
  const transfers = recipientWallets.map((r) => ({
    recipient: r.walletPubkey,
    amount: amountPerUser,
  }));

  let signature: string;
  try {
    signature = await transactionService.batchTransfer(senderKeypair, transfers, tokenMint);
  } catch (error: any) {
    await message.reply(`❌ Transaction failed: ${error.message || 'Unknown error'}`);
    return;
  }

  // Log transactions
  for (let i = 0; i < recipientWallets.length; i++) {
    const recipient = recipientWallets[i];
    const batchSignature = recipientWallets.length > 1 ? `${signature}:${i}` : signature;
    await prisma.transaction.create({
      data: {
        signature: batchSignature,
        fromId: sender.discordId,
        toId: recipient.discordId,
        amountUsd: usdPerUser,
        amountToken: amountPerUser,
        tokenMint,
        usdRate: usdPerUser > 0 ? usdPerUser / amountPerUser : 0,
        txType: 'TIP',
        status: 'CONFIRMED',
      },
    });
  }

  // Reply with success
  const userMentions = recipientWallets.map((r) => `<@${r.discordId}>`).join(', ');
  const embed = new EmbedBuilder()
    .setTitle('💸 Tip Sent!')
    .setDescription(
      `**${message.author}** tipped ${userMentions}\n\n` +
        `**Amount:** ${formatTokenAmount(amountPerUser)} ${tokenSymbol} (~$${usdPerUser.toFixed(2)}) each\n` +
        `[View on Solscan](https://solscan.io/tx/${signature})`
    )
    .setColor(0x00ff00)
    .setTimestamp();

  await message.reply({ embeds: [embed] });

  // Send DMs to recipients
  const failedDMs: string[] = [];
  for (const recipient of recipientWallets) {
    try {
      const user = await client.users.fetch(recipient.discordId);
      const isNew = newWallets.find((w) => w.id === recipient.discordId);

      let msg = `🎉 You received **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** (~$${usdPerUser.toFixed(2)}) from ${message.author.username}!`;

      if (isNew) {
        msg += `\n\n**🔐 New Wallet Key:**\n\`\`\`\n${isNew.key}\n\`\`\`\n*Self-destructs in 15m.*`;
        const sentMsg = await user.send(msg);

        setTimeout(async () => {
          try {
            await sentMsg.edit('🔒 **Key removed for security.**');
          } catch {}
        }, 900000);

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

  // Public fallback for failed DMs
  if (failedDMs.length > 0 && message.channel.isTextBased()) {
    const mentions = failedDMs.map((id) => `<@${id}>`).join(' ');
    const installLink = `https://discord.com/oauth2/authorize?client_id=${client.user?.id}`;
    await (message.channel as TextChannel)
      .send(
        `💰 ${mentions} — You just received a tip from ${message.author} and a new wallet was created for you!\n` +
          `To access your wallet: **[Install FatTips](${installLink})** → then use \`${prefix}help\` for help`
      )
      .catch(() => {});
  }
}

// ============ SEND ============
async function handleSend(message: Message, args: string[], prefix: string) {
  // %send <address> $5 or %send <address> 0.1 SOL
  if (args.length < 2) {
    await message.reply(
      `Usage: \`${prefix}send <solana_address> $5\` or \`${prefix}send <address> 0.1 SOL\``
    );
    return;
  }

  const address = args[0];
  const amountArg = args.slice(1).join(' ');
  const parsedAmount = parseAmountInput(amountArg);

  if (!parsedAmount.valid) {
    await message.reply(`❌ ${parsedAmount.error}`);
    return;
  }

  // Validate Solana address
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    await message.reply('❌ Invalid Solana address.');
    return;
  }

  const sender = await prisma.user.findUnique({
    where: { discordId: message.author.id },
  });

  if (!sender) {
    await message.reply(`❌ You don't have a wallet yet! Use \`${prefix}wallet create\` first.`);
    return;
  }

  const tokenSymbol = parsedAmount.token || 'SOL';
  const tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS] || TOKEN_MINTS.SOL;
  let amountToken: number;

  if (parsedAmount.type === 'usd') {
    const conversion = await priceService.convertUsdToToken(
      parsedAmount.value,
      tokenMint,
      tokenSymbol
    );
    if (!conversion) {
      await message.reply('❌ Failed to fetch prices.');
      return;
    }
    amountToken = conversion.amountToken;
  } else if (parsedAmount.type === 'max') {
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.002;
    amountToken =
      tokenSymbol === 'SOL'
        ? Math.max(0, balances.sol - feeBuffer)
        : tokenSymbol === 'USDC'
          ? balances.usdc
          : balances.usdt;
  } else {
    amountToken = parsedAmount.value;
  }

  if (amountToken <= 0) {
    await message.reply('❌ Amount too small!');
    return;
  }

  // Check balance
  const balances = await balanceService.getBalances(sender.walletPubkey);
  const required = tokenSymbol === 'SOL' ? amountToken + 0.002 : amountToken;
  const available =
    tokenSymbol === 'SOL' ? balances.sol : tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;

  if (available < required) {
    await message.reply(
      `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol}, have ${available.toFixed(4)}`
    );
    return;
  }

  const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

  let signature: string;
  try {
    signature = await transactionService.transfer(senderKeypair, address, amountToken, tokenMint);
  } catch (error: any) {
    await message.reply(`❌ Transaction failed: ${error.message || 'Unknown error'}`);
    return;
  }

  // Log transaction
  await prisma.transaction.create({
    data: {
      signature,
      fromId: sender.discordId,
      toAddress: address,
      amountUsd: 0,
      amountToken,
      tokenMint,
      usdRate: 0,
      txType: 'WITHDRAWAL',
      status: 'CONFIRMED',
    },
  });

  const embed = new EmbedBuilder()
    .setTitle('✅ Sent!')
    .setDescription(
      `**Amount:** ${formatTokenAmount(amountToken)} ${tokenSymbol}\n` +
        `**To:** \`${address}\`\n\n` +
        `[View on Solscan](https://solscan.io/tx/${signature})`
    )
    .setColor(0x00ff00)
    .setTimestamp();

  await message.reply({ embeds: [embed] });
}

// ============ HISTORY ============
async function handleHistory(message: Message) {
  const transactions = await prisma.transaction.findMany({
    where: {
      OR: [{ fromId: message.author.id }, { toId: message.author.id }],
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  if (transactions.length === 0) {
    await message.reply('No transactions found.');
    return;
  }

  const lines = transactions.map((tx) => {
    const isSent = tx.fromId === message.author.id;
    const arrow = isSent ? '→' : '←';
    const other = isSent ? tx.toId || tx.toAddress?.slice(0, 8) : tx.fromId;
    const amount = Number(tx.amountToken).toFixed(4);
    const token =
      tx.tokenMint === TOKEN_MINTS.USDC
        ? 'USDC'
        : tx.tokenMint === TOKEN_MINTS.USDT
          ? 'USDT'
          : 'SOL';
    return `${arrow} ${amount} ${token} ${isSent ? 'to' : 'from'} ${other ? `<@${other}>` : 'external'}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📜 Transaction History')
    .setDescription(lines.join('\n'))
    .setColor(0x00aaff)
    .setFooter({ text: 'Last 10 transactions' });

  await message.reply({ embeds: [embed] });
}

// ============ WITHDRAW ============
async function handleWithdraw(message: Message, args: string[], prefix: string) {
  // Alias for send
  await handleSend(message, args, prefix);
}

// ============ SETPREFIX ============
async function handleSetPrefix(message: Message, args: string[]) {
  // Must be in a guild
  if (!message.guild) {
    await message.reply('❌ This command can only be used in a server.');
    return;
  }

  // Check if user has admin permissions
  const member = message.member;
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.reply('❌ Only administrators can change the prefix.');
    return;
  }

  const newPrefix = args[0];

  if (!newPrefix) {
    const currentPrefix = await getGuildPrefix(message.guild.id);
    await message.reply(
      `Current prefix: \`${currentPrefix}\`\nUsage: \`${currentPrefix}setprefix <new_prefix>\``
    );
    return;
  }

  // Validate prefix
  if (newPrefix.length > 10) {
    await message.reply('❌ Prefix must be 10 characters or less.');
    return;
  }

  if (newPrefix.includes(' ')) {
    await message.reply('❌ Prefix cannot contain spaces.');
    return;
  }

  // Update or create guild settings
  await prisma.guildSettings.upsert({
    where: { guildId: message.guild.id },
    update: { prefix: newPrefix },
    create: { guildId: message.guild.id, prefix: newPrefix },
  });

  // Clear cache for this guild
  prefixCache.delete(message.guild.id);

  await message.reply(`✅ Prefix changed to \`${newPrefix}\`\nExample: \`${newPrefix}help\``);
}

// ============ RAIN ============
async function handleRain(message: Message, args: string[], client: Client, prefix: string) {
  if (!message.guild) {
    await message.reply('❌ Rain can only be used in a server.');
    return;
  }

  // Parse: %rain $10 5 or %rain 0.5 SOL 10
  if (args.length < 1) {
    await message.reply(
      `Usage: \`${prefix}rain $10 5\` (rain $10 on 5 users) or \`${prefix}rain 0.5 SOL\` (rain 0.5 SOL on 5 users)`
    );
    return;
  }

  // Find amount and count
  const amountArg = args[0];
  const count = parseInt(args[1]) || 5;
  const tokenArg = args.find((a) => /^(SOL|USDC|USDT)$/i.test(a));

  const parsedAmount = parseAmountInput(
    amountArg + (tokenArg && !amountArg.includes(tokenArg) ? ` ${tokenArg}` : '')
  );

  if (!parsedAmount.valid) {
    await message.reply(
      `❌ ${parsedAmount.error}\nUsage: \`${prefix}rain $10 5\` or \`${prefix}rain 0.5 SOL 10\``
    );
    return;
  }

  // Get active users
  const activeUserIds = activityService.getActiveUsers(message.channel.id, 15);
  const candidates = activeUserIds.filter((id) => id !== message.author.id);

  if (candidates.length === 0) {
    await message.reply('❌ No active users found to rain on! The channel is dry. 🏜️');
    return;
  }

  // Pick winners
  const shuffled = candidates.sort(() => 0.5 - Math.random());
  const winners = shuffled.slice(0, Math.min(count, candidates.length));

  // Get sender wallet
  const sender = await prisma.user.findUnique({
    where: { discordId: message.author.id },
  });

  if (!sender) {
    await message.reply("❌ You don't have a wallet yet! Use `%wallet create` first.");
    return;
  }

  // Process recipient wallets
  const recipientWallets = [];
  const newWallets: { id: string; key: string }[] = [];

  for (const recipientId of winners) {
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
          seedDelivered: false,
        },
      });
      newWallets.push({ id: recipientId, key: wallet.privateKeyBase58 });
    }
    recipientWallets.push(recipient);
  }

  if (recipientWallets.length === 0) {
    await message.reply('❌ Failed to prepare recipient wallets.');
    return;
  }

  // Calculate amounts
  const tokenSymbol = parsedAmount.token || 'SOL';
  const tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS] || TOKEN_MINTS.SOL;
  let totalAmountToken: number;
  let usdValue: number;

  if (parsedAmount.type === 'usd') {
    const conversion = await priceService.convertUsdToToken(
      parsedAmount.value,
      tokenMint,
      tokenSymbol
    );
    if (!conversion) {
      await message.reply('❌ Failed to fetch prices.');
      return;
    }
    totalAmountToken = conversion.amountToken;
    usdValue = parsedAmount.value;
  } else if (parsedAmount.type === 'max') {
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = 0.002;
    totalAmountToken =
      tokenSymbol === 'SOL'
        ? Math.max(0, balances.sol - feeBuffer)
        : tokenSymbol === 'USDC'
          ? balances.usdc
          : balances.usdt;
    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? totalAmountToken * price.price : 0;
  } else {
    totalAmountToken = parsedAmount.value;
    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? totalAmountToken * price.price : 0;
  }

  const amountPerUser = totalAmountToken / recipientWallets.length;
  const usdPerUser = usdValue / recipientWallets.length;

  if (amountPerUser <= 0) {
    await message.reply('❌ Amount too small to split!');
    return;
  }

  // Check balance
  const balances = await balanceService.getBalances(sender.walletPubkey);
  const required = tokenSymbol === 'SOL' ? totalAmountToken + 0.002 : totalAmountToken;
  const available =
    tokenSymbol === 'SOL' ? balances.sol : tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;

  if (available < required) {
    await message.reply(
      `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol}, have ${available.toFixed(4)}`
    );
    return;
  }

  // Execute transfer
  const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
  const transfers = recipientWallets.map((r) => ({
    recipient: r.walletPubkey,
    amount: amountPerUser,
  }));

  let signature: string;
  try {
    signature = await transactionService.batchTransfer(senderKeypair, transfers, tokenMint);
  } catch (error: any) {
    await message.reply(`❌ Transaction failed: ${error.message || 'Unknown error'}`);
    return;
  }

  // Log transactions
  for (let i = 0; i < recipientWallets.length; i++) {
    const recipient = recipientWallets[i];
    const batchSignature = recipientWallets.length > 1 ? `${signature}:${i}` : signature;
    await prisma.transaction.create({
      data: {
        signature: batchSignature,
        fromId: sender.discordId,
        toId: recipient.discordId,
        amountUsd: usdPerUser,
        amountToken: amountPerUser,
        tokenMint,
        usdRate: usdPerUser > 0 ? usdPerUser / amountPerUser : 0,
        txType: 'TIP',
        status: 'CONFIRMED',
      },
    });
  }

  // Reply with success
  const winnerMentions = recipientWallets.map((r) => `<@${r.discordId}>`).join(', ');
  const embed = new EmbedBuilder()
    .setTitle('🌧️ Making it Rain!')
    .setDescription(
      `**${message.author}** made it rain on **${recipientWallets.length} active users**!\n\n` +
        `**Total Rain:** ${formatTokenAmount(totalAmountToken)} ${tokenSymbol}\n` +
        `**Each User Gets:** ${formatTokenAmount(amountPerUser)} ${tokenSymbol} (~$${usdPerUser.toFixed(2)})\n\n` +
        `**Lucky Winners:**\n${winnerMentions}\n\n` +
        `[View on Solscan](https://solscan.io/tx/${signature})`
    )
    .setColor(0x00aaff)
    .setTimestamp();

  await message.reply({ embeds: [embed] });

  // Send DMs (same pattern as tip)
  const failedDMs: string[] = [];
  for (const recipient of recipientWallets) {
    try {
      const user = await client.users.fetch(recipient.discordId);
      const isNew = newWallets.find((w) => w.id === recipient.discordId);

      let msg = `🌧️ **It's Raining!** You caught **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** (~$${usdPerUser.toFixed(2)}) from ${message.author.username}!`;

      if (isNew) {
        msg += `\n\n**🔐 New Wallet Key:**\n\`\`\`\n${isNew.key}\n\`\`\`\n*Self-destructs in 15m.*`;
        const sentMsg = await user.send(msg);
        setTimeout(async () => {
          try {
            await sentMsg.edit('🔒 **Key removed for security.**');
          } catch {}
        }, 900000);
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

  if (failedDMs.length > 0 && message.channel.isTextBased()) {
    const mentions = failedDMs.map((id) => `<@${id}>`).join(' ');
    const installLink = `https://discord.com/oauth2/authorize?client_id=${client.user?.id}`;
    await (message.channel as TextChannel)
      .send(
        `💰 ${mentions} — You just received a tip from ${message.author} and a new wallet was created for you!\n` +
          `To access your wallet: **[Install FatTips](${installLink})** → then use \`${prefix}help\` for help`
      )
      .catch(() => {});
  }
}

// ============ AIRDROP ============
async function handleAirdrop(message: Message, args: string[], client: Client, prefix: string) {
  if (!message.guild) {
    await message.reply('❌ Airdrop can only be used in a server.');
    return;
  }

  // Parse: %airdrop $10 10m or %airdrop 0.5 SOL 1h 10
  if (args.length < 2) {
    await message.reply(
      `Usage: \`${prefix}airdrop $10 10m\` or \`${prefix}airdrop 0.5 SOL 1h 10\` (amount, duration, optional max winners)`
    );
    return;
  }

  const amountArg = args[0];
  const durationArg = args.find((a) => /^\d+[mhdw]$/i.test(a)) || args[1];
  const maxWinnersArg = args.find((a) => /^\d+$/.test(a) && a !== amountArg.replace(/\D/g, ''));
  const tokenArg = args.find((a) => /^(SOL|USDC|USDT)$/i.test(a));

  const parsedAmount = parseAmountInput(
    amountArg +
      (tokenArg && !amountArg.toLowerCase().includes(tokenArg.toLowerCase()) ? ` ${tokenArg}` : '')
  );

  if (!parsedAmount.valid) {
    await message.reply(`❌ ${parsedAmount.error}`);
    return;
  }

  // Parse duration
  const durationMs = parseDuration(durationArg);
  if (!durationMs || durationMs < 60000) {
    await message.reply('❌ Invalid duration. Must be at least 1 minute (e.g., `10m`, `1h`).');
    return;
  }

  const maxWinners = maxWinnersArg ? parseInt(maxWinnersArg) : null;
  const expiresAt = new Date(Date.now() + durationMs);

  // Get sender wallet
  const sender = await prisma.user.findUnique({
    where: { discordId: message.author.id },
  });

  if (!sender) {
    await message.reply("❌ You don't have a wallet yet! Use `%wallet create` first.");
    return;
  }

  // Calculate amounts
  const tokenSymbol = parsedAmount.token || 'SOL';
  const tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS] || TOKEN_MINTS.SOL;
  let amountToken: number;
  let usdValue: number;

  if (parsedAmount.type === 'usd') {
    const conversion = await priceService.convertUsdToToken(
      parsedAmount.value,
      tokenMint,
      tokenSymbol
    );
    if (!conversion) {
      await message.reply('❌ Failed to fetch prices.');
      return;
    }
    amountToken = conversion.amountToken;
    usdValue = parsedAmount.value;
  } else {
    amountToken = parsedAmount.value;
    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? amountToken * price.price : 0;
  }

  // Create ephemeral wallet
  const ephemeralWallet = walletService.createEncryptedWallet();
  const GAS_BUFFER = 0.003;

  // Check balance
  const balances = await balanceService.getBalances(sender.walletPubkey);
  const requiredSol = tokenSymbol === 'SOL' ? amountToken + GAS_BUFFER : GAS_BUFFER;

  if (balances.sol < requiredSol) {
    await message.reply(`❌ Insufficient SOL! Need ${requiredSol.toFixed(4)} SOL.`);
    return;
  }

  if (tokenSymbol !== 'SOL') {
    const tokenBal = tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;
    if (tokenBal < amountToken) {
      await message.reply(`❌ Insufficient ${tokenSymbol}! Need ${amountToken}.`);
      return;
    }
  }

  // Fund ephemeral wallet
  const senderKeypair = walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

  try {
    const solToSend = tokenSymbol === 'SOL' ? amountToken + GAS_BUFFER : GAS_BUFFER;
    await transactionService.transfer(
      senderKeypair,
      ephemeralWallet.publicKey,
      solToSend,
      TOKEN_MINTS.SOL
    );

    if (tokenSymbol !== 'SOL') {
      await transactionService.transfer(
        senderKeypair,
        ephemeralWallet.publicKey,
        amountToken,
        tokenMint
      );
    }
  } catch (error: any) {
    await message.reply(`❌ Failed to fund airdrop: ${error.message || 'Unknown error'}`);
    return;
  }

  // Create airdrop in DB
  const airdrop = await prisma.airdrop.create({
    data: {
      walletPubkey: ephemeralWallet.publicKey,
      encryptedPrivkey: ephemeralWallet.encryptedPrivateKey,
      keySalt: ephemeralWallet.keySalt,
      creatorId: sender.discordId,
      amountTotal: amountToken,
      tokenMint,
      maxParticipants: maxWinners ?? 0,
      expiresAt,
      channelId: message.channel.id,
    },
  });

  // Send embed with claim button
  const endTimestamp = Math.floor(expiresAt.getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle('🎉 Crypto Airdrop!')
    .setDescription(
      `**${message.author}** dropped a pot of **${amountToken.toFixed(2)} ${tokenSymbol}** (~$${usdValue.toFixed(2)})!\n\n` +
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

  const sentMessage = await message.reply({ embeds: [embed], components: [row] });

  // Save message ID
  await prisma.airdrop.update({
    where: { id: airdrop.id },
    data: { messageId: sentMessage.id },
  });

  // Schedule settlement for short airdrops
  if (durationMs < 60000 * 5) {
    client.emit('scheduleAirdrop', airdrop.id, durationMs);
  }
}

// Helper: Parse duration string
function parseDuration(str: string): number | null {
  const match = str.match(/^(\d+)([mhdw])$/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  if (unit === 'w') return val * 7 * 24 * 60 * 60 * 1000;
  return null;
}

// ============ DEPOSIT ============
async function handleDeposit(message: Message, prefix: string) {
  const user = await prisma.user.findUnique({
    where: { discordId: message.author.id },
  });

  if (!user) {
    await message.reply(
      `❌ You don't have a wallet yet! Use \`${prefix}wallet create\` to create one.`
    );
    return;
  }

  await message.reply(
    `**Your Deposit Address:**\n\`\`\`\n${user.walletPubkey}\n\`\`\`\nSend SOL, USDC, or USDT to this address to fund your wallet.`
  );
}
