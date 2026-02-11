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
  ComponentType,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { logger } from '../utils/logger';
import {
  PriceService,
  TOKEN_MINTS,
  TransactionService,
  WalletService,
  BalanceService,
  JupiterSwapService,
} from 'fattips-solana';
import { activityService } from '../services/activity';
import { transactionQueue } from '../queues/transaction.queue';

export const DEFAULT_PREFIX = 'f';
const DISCORD_CANNOT_DM = 50007;

// Solana constants
const MIN_RENT_EXEMPTION = 0.00089088; // SOL - minimum to keep account active
const FEE_BUFFER = 0.001; // SOL - standard fee buffer for transactions (~$0.15)
const PREFIX_FEE_BUFFER = 0.001; // SOL - consistent fee buffer for prefix commands
const MIN_SOL_FOR_GAS = 0.001; // Minimum SOL required for gas fees

// Cache for guild prefixes (refresh every 5 minutes)
const prefixCache = new Map<string, { prefix: string; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);
const swapService = new JupiterSwapService(process.env.SOLANA_RPC_URL!);

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

  if (message.content.toLowerCase().startsWith(prefix.toLowerCase())) {
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
      case 'swap':
        await handleSwap(message, args, prefix);
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

// ============ SWAP ============
async function handleSwap(message: Message, args: string[], prefix: string) {
  // Usage: %swap <amount> <from> <to>
  // Example: %swap 1 SOL USDC
  // Example: %swap max USDC SOL

  if (args.length < 3) {
    await message.reply(
      `Usage: \`${prefix}swap <amount> <from_token> <to_token>\`\n` +
        `Example: \`${prefix}swap 1 SOL USDC\` or \`${prefix}swap max USDC SOL\``
    );
    return;
  }

  const amountStr = args[0];
  const fromToken = args[1].toUpperCase();
  const toToken = args[2].toUpperCase();

  // Validate Tokens
  const validTokens = ['SOL', 'USDC', 'USDT'];
  if (!validTokens.includes(fromToken) || !validTokens.includes(toToken)) {
    await message.reply('❌ Invalid token. Supported: SOL, USDC, USDT.');
    return;
  }

  if (fromToken === toToken) {
    await message.reply('❌ You cannot swap the same token!');
    return;
  }

  // Parse Amount
  let amount = 0;
  const isMax = amountStr.toLowerCase() === 'max' || amountStr.toLowerCase() === 'all';

  if (!isMax) {
    if (amountStr.startsWith('$')) {
      const value = parseFloat(amountStr.substring(1));
      if (isNaN(value) || value <= 0) {
        await message.reply('❌ Invalid USD amount. Please enter a positive number.');
        return;
      }

      const inputMint = TOKEN_MINTS[fromToken as keyof typeof TOKEN_MINTS];
      const conversion = await priceService.convertUsdToToken(value, inputMint, fromToken);

      if (!conversion) {
        await message.reply('❌ Failed to fetch prices. Try again.');
        return;
      }
      amount = conversion.amountToken;
    } else {
      amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) {
        await message.reply('❌ Invalid amount. Please enter a positive number or "max".');
        return;
      }
    }
  }

  const statusMsg = await message.reply('⏳ Calculating swap...');

  try {
    // 1. Get User Wallet
    const user = await prisma.user.findUnique({
      where: { discordId: message.author.id },
    });

    if (!user) {
      await statusMsg.edit(
        `❌ You do not have a wallet yet. Use \`${prefix}wallet create\` first.`
      );
      return;
    }

    // 2. Check Balance & Resolve Max
    const balances = await balanceService.getBalances(user.walletPubkey);
    let balance = 0;
    if (fromToken === 'SOL') balance = balances.sol;
    else if (fromToken === 'USDC') balance = balances.usdc;
    else if (fromToken === 'USDT') balance = balances.usdt;

    let useGasless = false;
    const LOW_SOL_THRESHOLD = 0.005; // 0.005 SOL buffer for fees

    // Decide Gasless FIRST
    if (fromToken !== 'SOL' && balances.sol < LOW_SOL_THRESHOLD) {
      useGasless = true;
    }

    if (isMax) {
      if (fromToken === 'SOL') {
        // Standard SOL swap: Reserve buffer
        amount = Math.max(0, balance - LOW_SOL_THRESHOLD);
      } else {
        // Token swap (Gasless or Standard) -> Use full balance
        amount = balance;
      }

      if (amount <= 0) {
        await statusMsg.edit(
          `❌ Insufficient balance to swap (need buffer for fees). Balance: ${balance} ${fromToken}`
        );
        return;
      }
    }

    if (balance < amount) {
      await statusMsg.edit(
        `❌ Insufficient ${fromToken} balance. You have ${balance} ${fromToken}.`
      );
      return;
    }

    // Fee checks for Standard Swap
    if (!useGasless && fromToken === 'SOL' && balance < amount + LOW_SOL_THRESHOLD) {
      await statusMsg.edit(
        `❌ You need to leave some SOL for gas fees (approx ${LOW_SOL_THRESHOLD} SOL).`
      );
      return;
    } else if (fromToken !== 'SOL' && !useGasless && balances.sol < LOW_SOL_THRESHOLD) {
      // Fallback warning (though logic above likely caught it or set useGasless)
    }

    // 3. Get Quote
    const inputMint = TOKEN_MINTS[fromToken as keyof typeof TOKEN_MINTS];
    const outputMint = TOKEN_MINTS[toToken as keyof typeof TOKEN_MINTS];
    const outDecimals = swapService.getDecimals(outputMint);

    let quote: any;
    let outAmount = 0;
    let priceImpact = '';
    let minReceived = '';

    if (useGasless) {
      try {
        const result = await swapService.getGaslessSwap(
          inputMint,
          outputMint,
          amount,
          user.walletPubkey
        );
        quote = result.quote;
        // Parse Ultra API response format
        outAmount = parseInt(quote.outAmount) / Math.pow(10, outDecimals);
        priceImpact = quote.priceImpactPct
          ? (parseFloat(quote.priceImpactPct) * 100).toFixed(2)
          : '0';
        minReceived = quote.otherAmountThreshold
          ? (parseInt(quote.otherAmountThreshold) / Math.pow(10, outDecimals)).toFixed(
              outDecimals === 9 ? 4 : 2
            )
          : 'N/A';
      } catch (error: any) {
        await statusMsg.edit(
          `❌ Gasless swap failed. You need ~${LOW_SOL_THRESHOLD} SOL to pay for network fees.\nError: ${error.message}`
        );
        return;
      }
    } else {
      // Standard Swap
      try {
        quote = await swapService.getQuote(inputMint, outputMint, amount);
        outAmount = parseInt(quote.outAmount) / Math.pow(10, outDecimals);
        priceImpact = parseFloat(quote.priceImpactPct).toFixed(2);
        minReceived = (parseInt(quote.otherAmountThreshold) / Math.pow(10, outDecimals)).toFixed(
          outDecimals === 9 ? 4 : 2
        );
      } catch (error: any) {
        // Improve error message for network failures
        if (error.message.includes('fetch failed') || error.message.includes('Failed to fetch')) {
          await statusMsg.edit(
            `❌ Unable to connect to Jupiter API. This is usually a temporary network issue. Please try again in a few moments.`
          );
        } else {
          await statusMsg.edit(`❌ Failed to get quote: ${error.message}`);
        }
        return;
      }
    }

    // 4. Show Confirmation (Edit status message)
    const embed = new EmbedBuilder()
      .setTitle(useGasless ? '⛽ Gasless Swap Confirmation' : '🔄 Swap Confirmation')
      .setColor(useGasless ? 0x00ffaa : 0x00aaff)
      .addFields(
        { name: 'From', value: `${amount} ${fromToken}`, inline: true },
        {
          name: 'To (Est.)',
          value: `~${outAmount.toFixed(outDecimals === 9 ? 4 : 2)} ${toToken}`,
          inline: true,
        },
        { name: 'Price Impact', value: `${priceImpact}%`, inline: true },
        { name: 'Min. Received', value: `${minReceived} ${toToken}`, inline: true }
      )
      .setFooter({ text: `Powered by Jupiter API ${useGasless ? '(Ultra/Gasless)' : '(v6)'}` });

    const confirmButton = new ButtonBuilder()
      .setCustomId(`prefix_confirm_swap_${message.id}`) // Unique ID
      .setLabel('Confirm Swap')
      .setStyle(ButtonStyle.Success);

    const cancelButton = new ButtonBuilder()
      .setCustomId(`prefix_cancel_swap_${message.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

    const responseMsg = await statusMsg.edit({
      content: '',
      embeds: [embed],
      components: [row],
    });

    // 5. Handle Confirmation
    try {
      const confirmation = await responseMsg.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id,
        time: 60000,
        componentType: ComponentType.Button,
      });

      if (confirmation.customId.startsWith('prefix_cancel_swap')) {
        await confirmation.update({ content: '❌ Swap cancelled.', embeds: [], components: [] });
        return;
      }

      if (confirmation.customId.startsWith('prefix_confirm_swap')) {
        await confirmation.update({
          content: '🔄 Processing swap on Solana... (this may take up to 30s)',
          embeds: [],
          components: [],
        });

        try {
          // Get Swap Transaction
          let swapTransactionBase64 = '';
          let signature: string;

          if (useGasless) {
            swapTransactionBase64 = (quote as any).transaction;
            // Execute Gasless
            const requestId = (quote as any).requestId;
            // Decrypt User Key
            const userKeypair = await walletService.getKeypair(user.encryptedPrivkey, user.keySalt);
            signature = await swapService.executeGaslessSwap(
              userKeypair,
              swapTransactionBase64,
              requestId
            );
          } else {
            swapTransactionBase64 = await swapService.getSwapTransaction(quote, user.walletPubkey);
            // Decrypt User Key
            const userKeypair = await walletService.getKeypair(user.encryptedPrivkey, user.keySalt);
            // Execute Standard
            signature = await swapService.executeSwap(userKeypair, swapTransactionBase64);
          }

          const successEmbed = new EmbedBuilder()
            .setTitle('✅ Swap Successful!')
            .setColor(0x00ff00)
            .setDescription(
              `Swapped **${amount} ${fromToken}** to **${toToken}**\n\n[View on Solscan](https://solscan.io/tx/${signature})`
            )
            .setTimestamp();

          await confirmation.editReply({ content: '', embeds: [successEmbed], components: [] });

          logger.info(`Swap success (prefix): ${signature} (${user.discordId})`);
        } catch (error: any) {
          console.error('Swap failed:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await confirmation.editReply({
            content: `❌ Swap failed: ${errorMessage}`,
            embeds: [],
            components: [],
          });
        }
      }
    } catch (e) {
      // Timeout
      await responseMsg.edit({ content: '❌ Swap timed out.', components: [] }).catch(() => {});
    }
  } catch (error) {
    logger.error('Error in swap command:', error);
    await statusMsg.edit('❌ An error occurred while preparing the swap.');
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
          `\`${p}airdrop $20 10s\``,
      },
      {
        name: '💰 Wallet & Transfers',
        value:
          `\`${p}balance\` • \`${p}deposit\` • \`${p}history\`\n` +
          `\`${p}send <addr> $10\` • \`${p}withdraw <addr> all\`\n` +
          `\`${p}wallet create\` • \`${p}wallet export-key\`\n` +
          `\`${p}swap 1 SOL USDC\` • \`${p}swap max USDC SOL\``,
      },
      {
        name: '⚙️ Info',
        value:
          `\`${p}help\` • \`${p}setprefix <new>\`\n` + `*Slash commands available for all actions*`,
      }
    )
    .setFooter({
      text: '⚡ Prefix commands recommended for guilds',
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

  // Fetch balances from Solana with timeout
  let balances = { sol: 0, usdc: 0, usdt: 0 };
  try {
    const balancePromise = balanceService.getBalances(user.walletPubkey);
    const timeoutPromise = new Promise<typeof balances>((_, reject) =>
      setTimeout(() => reject(new Error('Balance fetch timeout')), 10000)
    );
    balances = await Promise.race([balancePromise, timeoutPromise]);
  } catch (error) {
    logger.error('Error fetching balances from Solana:', error);
    // Continue with zero balances
  }

  // Fetch SOL price for USD calculation
  let solUsdValue = 0;
  let showUsdValues = false;
  try {
    const solPrice = await priceService.getTokenPrice(TOKEN_MINTS.SOL);
    if (solPrice) {
      solUsdValue = balances.sol * solPrice.price;
      showUsdValues = true;
    }
  } catch {
    logger.warn('Price API unavailable, showing balances without USD values');
  }

  // Format balances
  const solFormatted = BalanceService.formatBalance(balances.sol);
  const usdcFormatted = BalanceService.formatBalance(balances.usdc);
  const usdtFormatted = BalanceService.formatBalance(balances.usdt);

  // Calculate total USD value
  const totalUsd = solUsdValue + balances.usdc + balances.usdt;

  let description = `\`${user.walletPubkey}\``;
  if (showUsdValues) {
    description += `\n\n**Total Value:** $${totalUsd.toFixed(2)} USD`;
  }

  const embed = new EmbedBuilder()
    .setTitle('💰 Your Wallet')
    .setDescription(description)
    .addFields(
      {
        name: 'SOL',
        value: showUsdValues ? `${solFormatted} ($${solUsdValue.toFixed(2)})` : solFormatted,
        inline: true,
      },
      { name: 'USDC', value: usdcFormatted, inline: true },
      { name: 'USDT', value: usdtFormatted, inline: true }
    )
    .setColor(0x00ff00)
    .setTimestamp();

  // If in DM, reply directly
  if (message.channel.type === ChannelType.DM) {
    await message.reply({ embeds: [embed] });
    return;
  }

  try {
    await message.author.send({ embeds: [embed] });
    const reply = await message.reply('✅ Sent your balance to your DMs!');

    // Clean up messages after 5 seconds
    setTimeout(() => {
      reply.delete().catch(() => {});
      if (message.deletable) {
        message.delete().catch(() => {});
      }
    }, 5000);
  } catch (error: any) {
    if (error.code === DISCORD_CANNOT_DM) {
      const reply = await message.reply(
        '❌ I cannot DM you. Please enable DMs to check your balance privately.'
      );
      setTimeout(() => reply.delete().catch(() => {}), 10000);
    } else {
      logger.error('Error sending balance DM:', error);
      await message.reply('❌ Failed to send balance. Please try again.');
    }
  }
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

    const wallet = await walletService.createEncryptedWallet();
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

    const privateKey = await walletService.decryptPrivateKey(user.encryptedPrivkey, user.keySalt);

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
      const wallet = await walletService.createEncryptedWallet();
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
    const feeBuffer = PREFIX_FEE_BUFFER;
    amountToken =
      tokenSymbol === 'SOL'
        ? Math.max(0, balances.sol - feeBuffer - MIN_RENT_EXEMPTION)
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

  if (amountPerUser <= 0) {
    await message.reply('❌ Amount too small!');
    return;
  }

  // Check balance (skip for 'max' since we calculated based on actual balance)
  const balances = await balanceService.getBalances(sender.walletPubkey);

  if (parsedAmount.type !== 'max') {
    const required =
      tokenSymbol === 'SOL' ? amountToken + PREFIX_FEE_BUFFER + MIN_RENT_EXEMPTION : amountToken;
    const available =
      tokenSymbol === 'SOL' ? balances.sol : tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;

    if (available < required) {
      await message.reply(
        `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol} (incl. rent exemption), have ${available.toFixed(4)}`
      );
      return;
    }
  }

  // Check SOL balance for gas fees (required for all transaction types)
  if (balances.sol < MIN_SOL_FOR_GAS) {
    await message.reply(
      `❌ Insufficient SOL for gas fees!\n` +
        `**Required:** ${MIN_SOL_FOR_GAS} SOL for transaction fees\n` +
        `**Available:** ${balances.sol.toFixed(6)} SOL\n\n` +
        `Deposit SOL to your wallet to pay for transaction fees.`
    );
    return;
  }

  // Send processing message
  const processingMsg = await message.reply('⏳ Processing transaction...');

  // Add to Queue
  await transactionQueue.add('tip', {
    type: 'TIP',
    senderDiscordId: sender.discordId,
    senderUsername: message.author.username,
    recipientDiscordIds: recipientWallets.map((r) => r.discordId),
    amountPerUser,
    tokenMint,
    tokenSymbol,
    usdValuePerUser: usdPerUser,
    channelId: message.channel.id,
    messageId: processingMsg.id,
  });

  // Handle New Wallets (Send Keys immediately)
  for (const newWallet of newWallets) {
    try {
      const user = await client.users.fetch(newWallet.id);
      const msg =
        `🎉 **Welcome to FatTips!**\n` +
        `You have a pending tip of **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** coming!\n\n` +
        `**🔐 Your Private Key:**\n\`\`\`\n${newWallet.key}\n\`\`\`\n*Self-destructs in 15m.*`;

      const sentMsg = await user.send(msg);
      setTimeout(async () => {
        try {
          await sentMsg.edit('🔒 **Key removed for security.**');
        } catch {}
      }, 900000);

      // Send Guide
      const guideEmbed = new EmbedBuilder()
        .setTitle('🚀 Getting Started')
        .setDescription('You just received crypto! Use `/balance` to check it.')
        .setColor(0x00aaff);
      await user.send({ embeds: [guideEmbed] });

      await prisma.user.update({
        where: { discordId: newWallet.id },
        data: { seedDelivered: true },
      });
    } catch (error) {
      // Failed to DM key
    }
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

  let tokenSymbol = parsedAmount.token || 'SOL';
  let tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS] || TOKEN_MINTS.SOL;
  let amountToken: number;
  let usdValue: number = 0;

  // Smart detection: If withdrawing "all" without specifying token, check balances
  if (parsedAmount.type === 'max' && !parsedAmount.token) {
    const balances = await balanceService.getBalances(sender.walletPubkey);
    // If SOL is too low for fees/rent (using 0.00002 as safe buffer), try other tokens
    if (balances.sol < PREFIX_FEE_BUFFER) {
      if (balances.usdc > 0) tokenSymbol = 'USDC';
      else if (balances.usdt > 0) tokenSymbol = 'USDT';

      tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS] || TOKEN_MINTS.SOL;
    }
  }

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
  } else if (parsedAmount.type === 'max') {
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = PREFIX_FEE_BUFFER;

    if (tokenSymbol === 'SOL') {
      // For MAX withdrawal, we allow closing the account by transferring everything minus fixed fee.
      // We will skip priority fees for this closing transaction to ensure exact math.
      // Fixed fee = 0.000005 SOL (5000 lamports)
      const CLOSING_FEE = 0.000005;
      amountToken = Math.max(0, balances.sol - CLOSING_FEE);
    } else if (tokenSymbol === 'USDC') {
      amountToken = balances.usdc;
    } else {
      amountToken = balances.usdt;
    }

    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? amountToken * price.price : 0;
  } else {
    amountToken = parsedAmount.value;
    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? amountToken * price.price : 0;
  }

  if (amountToken <= 0) {
    await message.reply('❌ Amount too small!');
    return;
  }

  // Check balance (skip for 'max' since we calculated based on actual balance)
  if (parsedAmount.type !== 'max') {
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const required =
      tokenSymbol === 'SOL' ? amountToken + PREFIX_FEE_BUFFER + MIN_RENT_EXEMPTION : amountToken;
    const available =
      tokenSymbol === 'SOL' ? balances.sol : tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;

    if (available < required) {
      await message.reply(
        `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol} (incl. rent exemption), have ${available.toFixed(4)}`
      );
      return;
    }
  }

  // Send processing message
  const processingMsg = await message.reply('⏳ Processing transaction...');

  // Add to Queue
  await transactionQueue.add('withdrawal', {
    type: 'WITHDRAWAL',
    senderDiscordId: sender.discordId,
    toAddress: address,
    amountPerUser: amountToken,
    tokenMint,
    tokenSymbol,
    usdValuePerUser: 0, // Not calculated for withdrawal here
    channelId: message.channel.id,
    messageId: processingMsg.id,
    skipPriorityFee: parsedAmount.type === 'max' && tokenSymbol === 'SOL',
  });
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

  const lines = transactions.map((tx: any) => {
    const isSent = tx.fromId === message.author.id;
    const arrow = isSent ? '📤' : '📥';
    const amount = Number(tx.amountToken).toFixed(4);
    const token =
      tx.tokenMint === TOKEN_MINTS.USDC
        ? 'USDC'
        : tx.tokenMint === TOKEN_MINTS.USDT
          ? 'USDT'
          : 'SOL';

    // Get USD value
    const usdValue = tx.amountUsd ? Number(tx.amountUsd).toFixed(2) : null;
    const usdDisplay = usdValue && usdValue !== '0.00' ? `($${usdValue})` : '';

    // Determine action type
    let actionType = '';
    if (tx.txType === 'TIP') {
      actionType = isSent ? 'Sent tip' : 'Received tip';
    } else if (tx.txType === 'WITHDRAWAL') {
      actionType = 'Withdrawal';
    } else if (tx.txType === 'DEPOSIT') {
      actionType = 'Deposit';
    } else if (tx.txType === 'AIRDROP_CLAIM') {
      actionType = isSent ? 'Airdrop payout' : 'Airdrop win';
    }

    // Get counterparty
    let counterparty = '';
    if (tx.txType === 'TIP') {
      const other = isSent ? tx.toId : tx.fromId;
      counterparty = other ? ` ${isSent ? 'to' : 'from'} <@${other}>` : '';
    } else if (tx.txType === 'WITHDRAWAL') {
      const addr = tx.toAddress || tx.toId;
      counterparty = addr ? ` to \`${addr.slice(0, 6)}...${addr.slice(-4)}\`` : ' to external';
    } else if (tx.txType === 'DEPOSIT') {
      counterparty = tx.fromId && tx.fromId !== 'SYSTEM' ? ` from <@${tx.fromId}>` : '';
    }

    const timeStr = tx.createdAt.toLocaleDateString();

    return `${arrow} **${actionType}**${counterparty}\n> ${amount} ${token} ${usdDisplay} • ${timeStr}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📜 Transaction History')
    .setDescription(lines.join('\n\n'))
    .setColor(0x00aaff)
    .setFooter({ text: 'Last 10 transactions' })
    .setTimestamp();

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
      `Usage: \`${prefix}rain $10 5\` (rain $10 on 5 users) or \`${prefix}rain 0.5 SOL 10\` (rain 0.5 SOL on 5 users)`
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
  const activeUserIds = await activityService.getActiveUsers(message.channel.id, 15);
  const candidates = activeUserIds.filter((id: string) => id !== message.author.id);

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
      const wallet = await walletService.createEncryptedWallet();
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

  // Smart token detection for max
  let tokenSymbol = parsedAmount.token || 'SOL';

  if (parsedAmount.type === 'max' && !parsedAmount.token) {
    // Auto-detect based on available balance
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const feeBuffer = PREFIX_FEE_BUFFER;

    // Check which token has significant balance
    if (balances.sol > feeBuffer) {
      tokenSymbol = 'SOL';
    } else if (balances.usdc > 0) {
      tokenSymbol = 'USDC';
    } else if (balances.usdt > 0) {
      tokenSymbol = 'USDT';
    } else {
      tokenSymbol = 'SOL';
    }
  }

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
    totalAmountToken =
      tokenSymbol === 'SOL'
        ? Math.max(0, balances.sol - PREFIX_FEE_BUFFER - MIN_RENT_EXEMPTION)
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

  // Check balance (skip for 'max' since we calculated based on actual balance)
  if (parsedAmount.type !== 'max') {
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const required =
      tokenSymbol === 'SOL'
        ? totalAmountToken + PREFIX_FEE_BUFFER + MIN_RENT_EXEMPTION
        : totalAmountToken;
    const available =
      tokenSymbol === 'SOL' ? balances.sol : tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;

    if (available < required) {
      await message.reply(
        `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol} (incl. rent exemption), have ${available.toFixed(4)}`
      );
      return;
    }
  }

  // Send processing message
  const processingMsg = await message.reply('⏳ Making it rain...');

  // Add to Queue
  await transactionQueue.add('rain', {
    type: 'RAIN',
    senderDiscordId: sender.discordId,
    senderUsername: message.author.username,
    recipientDiscordIds: recipientWallets.map((r) => r.discordId),
    amountPerUser,
    tokenMint,
    tokenSymbol,
    usdValuePerUser: usdPerUser,
    channelId: message.channel.id,
    messageId: processingMsg.id,
  });

  // Handle New Wallets (Send Keys immediately)
  for (const newWallet of newWallets) {
    try {
      const user = await client.users.fetch(newWallet.id);
      const msg =
        `🎉 **You're about to get rained on!**\n` +
        `You have a pending tip of **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** coming!\n\n` +
        `**🔐 Your Private Key:**\n\`\`\`\n${newWallet.key}\n\`\`\`\n*Self-destructs in 15m.*`;

      const sentMsg = await user.send(msg);
      setTimeout(async () => {
        try {
          await sentMsg.edit('🔒 **Key removed for security.**');
        } catch {}
      }, 900000);

      // Send Guide
      const guideEmbed = new EmbedBuilder()
        .setTitle('🚀 Getting Started')
        .setDescription('You just received crypto! Use `/balance` to check it.')
        .setColor(0x00aaff);
      await user.send({ embeds: [guideEmbed] });

      await prisma.user.update({
        where: { discordId: newWallet.id },
        data: { seedDelivered: true },
      });
    } catch (error) {
      // Failed to DM key
    }
  }
}

// ============ AIRDROP ============
async function handleAirdrop(message: Message, args: string[], client: Client, prefix: string) {
  if (!message.guild) {
    await message.reply('❌ Airdrop can only be used in a server.');
    return;
  }

  // Parse: %airdrop $10 10m or %airdrop 0.5 SOL 1h 10 or %airdrop $10 10s
  if (args.length < 2) {
    await message.reply(
      `Usage: \`${prefix}airdrop $10 10s\` or \`${prefix}airdrop 0.5 SOL 1h 10\` (amount, duration, optional max winners)`
    );
    return;
  }

  const amountArg = args[0];
  const durationArg = args.find((a) => /^\d+[smhdw]$/i.test(a)) || args[1];
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
  if (!durationMs || durationMs < 10000) {
    await message.reply(
      '❌ Invalid duration. Must be at least 10 seconds (e.g., `10s`, `10m`, `1h`).'
    );
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

  // Smart token detection for max
  let tokenSymbol = parsedAmount.token || 'SOL';

  if (parsedAmount.type === 'max' && !parsedAmount.token) {
    // Auto-detect based on available balance
    const balances = await balanceService.getBalances(sender.walletPubkey);
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

  const tokenMint = TOKEN_MINTS[tokenSymbol as keyof typeof TOKEN_MINTS] || TOKEN_MINTS.SOL;
  let amountToken: number;
  let usdValue: number;

  if (parsedAmount.type === 'max') {
    // Calculate max amount
    const balances = await balanceService.getBalances(sender.walletPubkey);
    const gasBuffer = 0.003;

    if (tokenSymbol === 'SOL') {
      amountToken = Math.max(0, balances.sol - gasBuffer);
    } else if (tokenSymbol === 'USDC') {
      amountToken = balances.usdc;
    } else {
      amountToken = balances.usdt;
    }

    // Estimate USD
    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? amountToken * price.price : 0;
  } else if (parsedAmount.type === 'usd') {
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
    amountToken = parsedAmount.value || 0;
    const price = await priceService.getTokenPrice(tokenMint);
    usdValue = price ? amountToken * price.price : 0;
  }

  // Create ephemeral wallet
  const ephemeralWallet = await walletService.createEncryptedWallet();
  const GAS_BUFFER = 0.003;

  // Check balance (skip for max since we calculated based on actual balance)
  if (parsedAmount.type !== 'max') {
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
  }

  // Fund ephemeral wallet
  const senderKeypair = await walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);

  try {
    // For max, amountToken already has gas buffer subtracted, so we don't add it again
    let solToSend = tokenSymbol === 'SOL' ? amountToken + GAS_BUFFER : GAS_BUFFER;
    if (parsedAmount.type === 'max' && tokenSymbol === 'SOL') {
      solToSend = amountToken;
    }

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
  const match = str.match(/^(\d+)([smhdw])$/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return val * 1000;
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
