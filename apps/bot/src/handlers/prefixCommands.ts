import {
  Message,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  AttachmentBuilder,
} from 'discord.js';
import { Connection } from '@solana/web3.js';
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
import { AirdropPoolService } from 'fattips-shared';
import { activityService } from '../services/activity';
import { transactionQueue, generateJobId } from '../queues/transaction.queue';
import { networkMonitor } from '../index';
import { sendPrivateKeyDM, scheduleKeyRedaction } from '../utils/keyCleanup';
import { generateDepositQR } from '../utils/qr';

const poolService = new AirdropPoolService();

export const DEFAULT_PREFIX = 'f';

const MIN_RENT_EXEMPTION = 0.00089088;
const PREFIX_FEE_BUFFER = 0.001;
const MIN_SOL_FOR_GAS = 0.001;

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

  const usdMatch =
    trimmed.match(/^\$(\d+(?:\.\d+)?|\.\d+)\s*([a-zA-Z]*)?$/i) ||
    trimmed.match(/^(\d+(?:\.\d+)?|\.\d+)\$\s*([a-zA-Z]*)?$/i);
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
      case 'leaderboard':
      case 'lb':
        await handleLeaderboard(message, args, prefix);
        break;
      case 'stats':
        await handleStats(message);
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
    const isUsd = amountStr.startsWith('$') || amountStr.endsWith('$');
    if (isUsd) {
      const value = parseFloat(amountStr.replace(/\$/g, ''));
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
          content: '🔄 Processing swap on Solana... (this may take up to 60s)',
          embeds: [],
          components: [],
        });

        try {
          const userKeypair = await walletService.getKeypair(user.encryptedPrivkey, user.keySalt);
          let signature: string;
          let usedGasless = useGasless;

          if (useGasless) {
            const requestId = (quote as any).requestId;
            signature = await swapService.executeGaslessSwap(
              userKeypair,
              (quote as any).transaction,
              requestId
            );
          } else {
            try {
              const swapTransactionBase64 = await swapService.getSwapTransaction(
                quote,
                user.walletPubkey
              );
              signature = await swapService.executeSwap(userKeypair, quote, swapTransactionBase64);
            } catch (stdError: unknown) {
              const errMsg = stdError instanceof Error ? stdError.message : String(stdError);
              const isInsufficientLamports =
                errMsg.includes('insufficient lamports') ||
                errMsg.includes('custom program error: 0x1') ||
                errMsg.includes('Custom":1');

              if (!isInsufficientLamports) throw stdError;

              // Fallback to gasless swap
              logger.info(
                `Standard swap failed (insufficient lamports), retrying gasless (prefix) (${user.discordId})`
              );
              await confirmation.editReply({
                content: '🔄 Not enough SOL for gas, retrying with gasless swap...',
                embeds: [],
                components: [],
              });

              const gaslessResult = await swapService.getGaslessSwap(
                inputMint,
                outputMint,
                amount,
                user.walletPubkey
              );
              const requestId = gaslessResult.quote.requestId;
              signature = await swapService.executeGaslessSwap(
                userKeypair,
                gaslessResult.quote.transaction,
                requestId
              );
              usedGasless = true;
            }
          }

          const successEmbed = new EmbedBuilder()
            .setTitle('✅ Swap Successful!')
            .setColor(0x00ff00)
            .setDescription(
              `Swapped **${amount} ${fromToken}** to **${toToken}**${usedGasless && !useGasless ? ' (gasless fallback)' : ''}\n\n[View on Solscan](https://solscan.io/tx/${signature})`
            )
            .setTimestamp();

          await confirmation.editReply({ content: '', embeds: [successEmbed], components: [] });

          logger.info(
            `Swap success (prefix)${usedGasless && !useGasless ? ' (gasless fallback)' : ''}: ${signature} (${user.discordId})`
          );
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
    } catch {
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
      `Send Solana tips instantly on Discord!\n` +
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
          `\`${p}rain @role $10\` (Role members)\n` +
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
        name: '📊 Stats & Leaderboard',
        value:
          `\`${p}stats\` - Your tipping stats\n` +
          `\`${p}lb airdrops\` - Top airdrop creators\n` +
          `\`${p}lb rain\` - Top rain senders\n` +
          `\`${p}lb guild\` - Server stats`,
      },
      {
        name: '⚙️ Info',
        value:
          `\`${p}help\` • \`${p}setprefix <new>\`\n` + `*Slash commands available for all actions*`,
      },
      {
        name: '🆘 Support',
        value: 'Need help? Join **CTRL-ALT-DEGEN** on Discord: https://discord.gg/9wArQgz6cB',
      }
    )
    .setFooter({
      text: '⚡ Prefix commands recommended for guilds',
    });

  await message.reply({ embeds: [embed] });
}

// ============ BALANCE ============
async function handleBalance(message: Message, _prefix: string) {
  await message.reply(
    `🔒 Use the \`/balance\` slash command to check your balance — it's private and only visible to you.`
  );
}

// ============ WALLET ============
async function handleWallet(message: Message, args: string[], prefix: string) {
  const action = args[0]?.toLowerCase();

  if (action === 'create') {
    const existing = await prisma.user.findUnique({
      where: { discordId: message.author.id },
    });

    if (existing) {
      await message.reply(
        `You already have a wallet!\nAddress: \`${existing.walletPubkey}\`\n\n*💡 For privacy, use \`/wallet create\` (slash command) as the preferred way to create your wallet - only you will see the address.*`
      );
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
    const msgContent =
      `🎉 **Wallet Created!**\n\n` +
      `**Address:** \`${wallet.publicKey}\`\n\n` +
      `**Private Key:**\n\`\`\`${wallet.privateKeyBase58}\`\`\`\n` +
      `⚠️ **Save this key! This message self-destructs in 15 minutes.**`;

    const dmResult = await sendPrivateKeyDM(
      message.client,
      message.author.id,
      msgContent,
      `🔒 **Private key removed for security.** Use \`${prefix}wallet export-key\` to view again.`
    );

    if (dmResult.sent) {
      await prisma.user.update({
        where: { discordId: message.author.id },
        data: { seedDelivered: true },
      });

      await message.reply(
        `✅ Wallet created! Check your DMs for the private key.\nAddress: \`${wallet.publicKey}\``
      );
    } else {
      // DM failed
      await message.reply(
        `✅ Wallet created!\nAddress: \`${wallet.publicKey}\`\n\n` +
          `⚠️ I couldn't DM you the private key. Use \`${prefix}wallet export-key\` in DMs to get it.`
      );
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

    const msgContent =
      `🔐 **Your Private Key:**\n\`\`\`${privateKey}\`\`\`\n` +
      `⚠️ This message self-destructs in 15 minutes.`;

    const dmMsg = await message.reply(msgContent);
    // Since we're replying to a DM, we use scheduleKeyRedaction directly on the message
    scheduleKeyRedaction(dmMsg, '🔒 **Private key removed for security.**');
  } else {
    await message.reply(`Usage: \`${prefix}wallet create\` or \`${prefix}wallet export-key\``);
  }
}

// ============ TIP ============
async function handleTip(message: Message, args: string[], client: Client, prefix: string) {
  // Redirect role mentions to rain
  if (message.mentions.roles.size > 0 || message.content.includes('<@&')) {
    await message.reply(
      `To tip an entire role, use \`${prefix}rain @role $5\`.\n` +
        `Example: \`${prefix}rain @CoolPeople $10\` — randomly rains $10 on up to 25 members of @CoolPeople.`
    );
    return;
  }

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

  for (const [recipientId] of targetUsers) {
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

  const MIN_PER_RECIPIENT_TIP = tokenSymbol === 'SOL' ? 0.0001 : 0.01;
  if (amountPerUser < MIN_PER_RECIPIENT_TIP) {
    await message.reply(
      `❌ Per-recipient amount too small! Each user would get ${formatTokenAmount(amountPerUser)} ${tokenSymbol}. Minimum is ${MIN_PER_RECIPIENT_TIP} ${tokenSymbol} per person.`
    );
    return;
  }

  // Check balance (skip for 'max' since we calculated based on actual balance)
  const balances = await balanceService.getBalances(sender.walletPubkey);

  // Check if recipients are new wallets (need rent exemption for SOL or ATA for SPL)
  let newRecipientCount = 0;
  const checkCount = Math.min(recipientWallets.length, 10);
  for (let i = 0; i < checkCount; i++) {
    try {
      const recipientBalances = await balanceService.getBalances(recipientWallets[i].walletPubkey);
      if (
        recipientBalances.sol === 0 &&
        recipientBalances.usdc === 0 &&
        recipientBalances.usdt === 0
      ) {
        newRecipientCount++;
      }
    } catch {
      newRecipientCount++;
    }
  }
  const estimatedNewRecipients =
    newRecipientCount > 0
      ? Math.ceil(newRecipientCount * (recipientWallets.length / checkCount))
      : 0;
  const recipientRentReserve = estimatedNewRecipients * MIN_RENT_EXEMPTION;

  if (parsedAmount.type !== 'max') {
    const recipientRent =
      tokenSymbol === 'SOL' ? recipientRentReserve : estimatedNewRecipients * 0.002; // ATA rent for SPL
    const required =
      tokenSymbol === 'SOL'
        ? amountToken + PREFIX_FEE_BUFFER + MIN_RENT_EXEMPTION + recipientRent
        : amountToken;
    const available =
      tokenSymbol === 'SOL' ? balances.sol : tokenSymbol === 'USDC' ? balances.usdc : balances.usdt;

    if (available < required) {
      if (tokenSymbol === 'SOL') {
        const maxPossible = Math.max(
          0,
          balances.sol - PREFIX_FEE_BUFFER - MIN_RENT_EXEMPTION - recipientRent
        );
        if (maxPossible > 0 && maxPossible < amountToken) {
          const adjustedPerUser = maxPossible / recipientWallets.length;
          const confirmBtn = new ButtonBuilder()
            .setCustomId('confirm_adjusted')
            .setLabel(`Send ${formatTokenAmount(maxPossible)} SOL Instead`)
            .setStyle(ButtonStyle.Success);
          const cancelBtn = new ButtonBuilder()
            .setCustomId('cancel_adjusted')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, cancelBtn);

          const reply = await message.reply({
            content:
              `⚠️ Insufficient balance for requested amount.\n\n` +
              `**Requested:** ${formatTokenAmount(amountToken)} SOL\n` +
              `**Available:** ${formatTokenAmount(maxPossible)} SOL (after fees)\n` +
              `**Each user gets:** ${formatTokenAmount(adjustedPerUser)} SOL\n\n` +
              `Send the adjusted amount instead?`,
            components: [row],
          });

          const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
          });

          const confirmed = await new Promise<boolean>((resolve) => {
            collector.on('collect', async (i) => {
              if (i.user.id !== message.author.id) {
                await i.reply({ content: 'Not your tip!', ephemeral: true });
                return;
              }
              if (i.customId === 'cancel_adjusted') {
                await i.update({ content: '❌ Tip cancelled.', components: [] });
                collector.stop();
                resolve(false);
                return;
              }
              await i.deferUpdate();
              collector.stop();
              resolve(true);
            });
            collector.on('end', (_collected, reason) => {
              if (reason === 'time') {
                reply.edit({ content: '❌ Tip timed out.', components: [] }).catch(() => {});
                resolve(false);
              }
            });
          });

          if (!confirmed) return;

          amountToken = maxPossible;
          usdValue = (await priceService.getTokenPrice(tokenMint))?.price
            ? adjustedPerUser *
              (await priceService.getTokenPrice(tokenMint))!.price *
              recipientWallets.length
            : 0;
        } else {
          const rentInfo =
            estimatedNewRecipients > 0
              ? `\n• +${estimatedNewRecipients} new recipient${estimatedNewRecipients > 1 ? 's need' : ' needs'} rent exemption`
              : '';
          await message.reply(
            `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol} (incl. fees/rent)${rentInfo}, have ${available.toFixed(4)}`
          );
          return;
        }
      } else {
        await message.reply(
          `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol}, have ${available.toFixed(4)}`
        );
        return;
      }
    }
  }

  // Check SOL balance for gas fees (required for all transaction types)
  if (tokenSymbol === 'SOL' && balances.sol < MIN_SOL_FOR_GAS + recipientRentReserve) {
    await message.reply(
      `❌ Insufficient SOL for gas fees!\n` +
        `**Required:** ${(MIN_SOL_FOR_GAS + recipientRentReserve).toFixed(5)} SOL\n` +
        `**Available:** ${balances.sol.toFixed(5)} SOL\n\n` +
        `Deposit SOL to your wallet to pay for transaction fees.`
    );
    return;
  } else if (
    tokenSymbol !== 'SOL' &&
    balances.sol < MIN_SOL_FOR_GAS + estimatedNewRecipients * 0.002
  ) {
    await message.reply(
      `❌ Insufficient SOL for gas & rent!\n` +
        `**Required:** ${(MIN_SOL_FOR_GAS + estimatedNewRecipients * 0.002).toFixed(5)} SOL\n` +
        `**Available:** ${balances.sol.toFixed(5)} SOL\n\n` +
        `Deposit SOL to your wallet to pay for transaction fees.`
    );
    return;
  }

  // Warn if network is degraded/congested
  const networkWarning = networkMonitor.getWarningText();
  if (networkWarning) await message.author.send(networkWarning).catch(() => {});

  // Send processing message
  const processingMsg = await message.reply('⏳ Processing transaction...');

  // Add to Queue
  try {
    const jobId = generateJobId('TIP', sender.discordId, amountPerUser, tokenSymbol);
    await transactionQueue.add(
      'tip',
      {
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
        guildId: message.guild?.id,
      },
      { jobId }
    );
  } catch (queueError) {
    console.error('Failed to queue tip job:', queueError);
    await processingMsg.edit('❌ Failed to queue transaction. Please try again.').catch(() => {});
    return;
  }

  // Handle New Wallets (Send Keys immediately)
  for (const newWallet of newWallets) {
    try {
      const msg =
        `🎉 **You caught some rain! 🌧️**\n` +
        `You have a pending tip of **${formatTokenAmount(amountPerUser)} ${tokenSymbol}**!\n\n` +
        `**🔐 Your Private Key:**\n\`\`\`\n${newWallet.key}\n\`\`\`\n*Self-destructs in 15m.*`;

      const dmResult = await sendPrivateKeyDM(
        client,
        newWallet.id,
        msg,
        '🔒 **Key removed for security.**'
      );

      if (dmResult.sent) {
        // Send Guide only if DM was successful
        const user = await client.users.fetch(newWallet.id);
        const guideEmbed = new EmbedBuilder()
          .setTitle('🚀 Getting Started')
          .setDescription('You just received Solana! Use `/balance` to check it.')
          .setColor(0x00aaff);
        await user.send({ embeds: [guideEmbed] });

        await prisma.user.update({
          where: { discordId: newWallet.id },
          data: { seedDelivered: true },
        });
      }
    } catch (error) {
      logger.error(`Failed to DM key to new user ${newWallet.id}:`, error);
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

  const MIN_SEND_AMOUNT = tokenSymbol === 'SOL' ? 0.0001 : 0.01;
  if (amountToken < MIN_SEND_AMOUNT) {
    await message.reply(`❌ Amount too small! Minimum is ${MIN_SEND_AMOUNT} ${tokenSymbol}.`);
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

  // Warn if network is degraded/congested
  const networkWarning = networkMonitor.getWarningText();
  if (networkWarning) await message.author.send(networkWarning).catch(() => {});

  // Send processing message — worker sends DM on result, so reflect that here
  const processingMsg = await message.reply(
    "⏳ Processing withdrawal... you'll receive a DM when it completes."
  );

  // Add to Queue
  try {
    const jobId = generateJobId('WITHDRAWAL', sender.discordId, amountToken, tokenSymbol);
    await transactionQueue.add(
      'withdrawal',
      {
        type: 'WITHDRAWAL',
        senderDiscordId: sender.discordId,
        toAddress: address,
        amountPerUser: amountToken,
        tokenMint,
        tokenSymbol,
        usdValuePerUser: usdValue,
        channelId: message.channel.id,
        messageId: processingMsg.id,
        skipPriorityFee: parsedAmount.type === 'max' && tokenSymbol === 'SOL',
        guildId: message.guild?.id,
      },
      { jobId }
    );
  } catch (queueError) {
    console.error('Failed to queue withdrawal job:', queueError);
    await processingMsg.edit('❌ Failed to queue withdrawal. Please try again.').catch(() => {});
  }
}

// ============ HISTORY ============
async function handleHistory(message: Message) {
  const transactions = await prisma.transaction.findMany({
    where: {
      OR: [{ fromId: message.author.id }, { toId: message.author.id }],
    },
    orderBy: { createdAt: 'desc' },
    take: 3,
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
    .setTitle('📜 Recent Transactions')
    .setDescription(lines.join('\n\n'))
    .setColor(0x00aaff)
    .setFooter({ text: 'Last 3 transactions • Use /history for full history' })
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

  // Parse: %rain $10 5 or %rain @role $10 5 or %rain 0.5 SOL 10
  if (args.length < 1) {
    await message.reply(
      `Usage: \`${prefix}rain $10 5\` (rain $10 on 5 active users) or \`${prefix}rain @role $10\` (rain on role members)`
    );
    return;
  }

  // Check for role mention: <@&12345>
  const roleMentionRegex = /<@&(\d+)>/;
  const roleArg = args.find((a) => roleMentionRegex.test(a));
  const roleId = roleArg ? roleArg.match(roleMentionRegex)![1] : null;

  let winners: string[];

  if (roleId) {
    // --- Role-based rain ---
    const role = message.guild.roles.cache.get(roleId);
    if (!role) {
      await message.reply('❌ That role could not be found.');
      return;
    }

    if (role.id === message.guild.id) {
      await message.reply('❌ Cannot rain on the @everyone role.');
      return;
    }

    let members;
    try {
      members = await message.guild.members.fetch();
    } catch {
      await message.reply('❌ Failed to fetch guild members. Please try again.');
      return;
    }

    const roleMembers = members.filter(
      (m) => m.roles.cache.has(role.id) && m.id !== message.author.id && !m.user.bot
    );

    if (roleMembers.size === 0) {
      await message.reply(`❌ No eligible members found in <@&${role.id}> (excluding you and bots).`);
      return;
    }

    // Find count in args: non-role, non-token args; first is amount, optional second numeric is count
    const nonMetaArgs = args.filter(
      (a) => a !== roleArg && !/^(SOL|USDC|USDT)$/i.test(a)
    );
    const numericArgs = nonMetaArgs.filter((a) => /^\d+$/.test(a));
    const constCount =
      numericArgs.length >= 2
        ? parseInt(numericArgs[1])
        : Math.min(roleMembers.size, 25);

    const memberIds = [...roleMembers.keys()];
    const shuffled = memberIds.sort(() => 0.5 - Math.random());
    winners = shuffled.slice(0, Math.min(constCount, memberIds.length));
  } else {
    // --- Channel-based rain (original behavior) ---
    const count = parseInt(args[1]) || 5;

    // Get active users
    const activeUserIds = await activityService.getActiveUsers(message.channel.id, 15);
    const candidates = activeUserIds.filter((id: string) => id !== message.author.id);

    if (candidates.length === 0) {
      await message.reply('❌ No active users found to rain on! The channel is dry. 🏜️');
      return;
    }

    // Pick winners
    const shuffled = candidates.sort(() => 0.5 - Math.random());
    winners = shuffled.slice(0, Math.min(count, candidates.length));
  }

  // Parse amount (common to both paths)
  const tokenArg = args.find((a) => /^(SOL|USDC|USDT)$/i.test(a));
  const nonMetaArgs = args.filter(
    (a) =>
      a !== roleArg &&
      a.toLowerCase() !== tokenArg?.toLowerCase() &&
      !(roleId && /^\d+$/.test(a) && a !== args[0]) // exclude count numbers for role rain
  );
  const amountArg = nonMetaArgs[0] || args[0];

  const parsedAmount = parseAmountInput(
    amountArg + (tokenArg && !amountArg.includes(tokenArg) ? ` ${tokenArg}` : '')
  );

  if (!parsedAmount.valid) {
    await message.reply(
      `❌ ${parsedAmount.error}\nUsage: \`${prefix}rain $10 5\` or \`${prefix}rain @role $10\``
    );
    return;
  }

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

  const MIN_PER_RECIPIENT_RAIN = tokenSymbol === 'SOL' ? 0.0001 : 0.01;
  if (amountPerUser < MIN_PER_RECIPIENT_RAIN) {
    await message.reply(
      `❌ Per-recipient amount too small! Each user would get ${formatTokenAmount(amountPerUser)} ${tokenSymbol}. Minimum is ${MIN_PER_RECIPIENT_RAIN} ${tokenSymbol} per person. Try a larger amount or fewer recipients.`
    );
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
      if (tokenSymbol === 'SOL') {
        const maxPossible = Math.max(0, balances.sol - PREFIX_FEE_BUFFER - MIN_RENT_EXEMPTION);
        if (maxPossible > 0 && maxPossible < totalAmountToken) {
          const adjustedPerUser = maxPossible / recipientWallets.length;
          const confirmBtn = new ButtonBuilder()
            .setCustomId('confirm_rain_adjusted')
            .setLabel(`Rain ${formatTokenAmount(maxPossible)} SOL Instead`)
            .setStyle(ButtonStyle.Success);
          const cancelBtn = new ButtonBuilder()
            .setCustomId('cancel_rain_adjusted')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn, cancelBtn);

          const reply = await message.reply({
            content:
              `⚠️ Insufficient balance for requested amount.\n\n` +
              `**Requested:** ${formatTokenAmount(totalAmountToken)} SOL\n` +
              `**Available:** ${formatTokenAmount(maxPossible)} SOL (after fees)\n` +
              `**Each user gets:** ${formatTokenAmount(adjustedPerUser)} SOL\n\n` +
              `Send the adjusted amount instead?`,
            components: [row],
          });

          const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60000,
          });

          const confirmed = await new Promise<boolean>((resolve) => {
            collector.on('collect', async (i) => {
              if (i.user.id !== message.author.id) {
                await i.reply({ content: 'Not your rain!', ephemeral: true });
                return;
              }
              if (i.customId === 'cancel_rain_adjusted') {
                await i.update({ content: '❌ Rain cancelled.', components: [] });
                collector.stop();
                resolve(false);
                return;
              }
              await i.deferUpdate();
              collector.stop();
              resolve(true);
            });
            collector.on('end', (_collected, reason) => {
              if (reason === 'time') {
                reply.edit({ content: '❌ Rain timed out.', components: [] }).catch(() => {});
                resolve(false);
              }
            });
          });

          if (!confirmed) return;

          totalAmountToken = maxPossible;
          usdValue = (await priceService.getTokenPrice(tokenMint))
            ? adjustedPerUser *
              (await priceService.getTokenPrice(tokenMint))!.price *
              recipientWallets.length
            : 0;
        } else {
          await message.reply(
            `❌ Insufficient balance! Need ${required.toFixed(4)} SOL (incl. rent exemption), have ${available.toFixed(4)}`
          );
          return;
        }
      } else {
        await message.reply(
          `❌ Insufficient balance! Need ${required.toFixed(4)} ${tokenSymbol}, have ${available.toFixed(4)}`
        );
        return;
      }
    }
  }

  // Warn if network is degraded/congested
  const networkWarning = networkMonitor.getWarningText();
  if (networkWarning) await message.author.send(networkWarning).catch(() => {});

  // Send processing message
  const processingMsg = await message.reply('⏳ Making it rain...');

  // Add to Queue
  try {
    const jobId = generateJobId('RAIN', sender.discordId, amountPerUser, tokenSymbol);
    await transactionQueue.add(
      'rain',
      {
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
        guildId: message.guild?.id,
      },
      { jobId }
    );
  } catch (queueError) {
    console.error('Failed to queue rain job:', queueError);
    await processingMsg.edit('❌ Failed to queue transaction. Please try again.').catch(() => {});
    return;
  }

  // Handle New Wallets (Send Keys immediately)
  for (const newWallet of newWallets) {
    try {
      const msg =
        `🎉 **You're about to get rained on!**\n` +
        `You have a pending tip of **${formatTokenAmount(amountPerUser)} ${tokenSymbol}** coming!\n\n` +
        `**🔐 Your Private Key:**\n\`\`\`\n${newWallet.key}\n\`\`\`\n*Self-destructs in 15m.*`;

      const dmResult = await sendPrivateKeyDM(
        client,
        newWallet.id,
        msg,
        '🔒 **Key removed for security.**'
      );

      if (dmResult.sent) {
        // Send Guide
        const user = await client.users.fetch(newWallet.id);
        const guideEmbed = new EmbedBuilder()
          .setTitle('🚀 Getting Started')
          .setDescription('You just received Solana! Use `/balance` to check it.')
          .setColor(0x00aaff);
        await user.send({ embeds: [guideEmbed] });

        await prisma.user.update({
          where: { discordId: newWallet.id },
          data: { seedDelivered: true },
        });
      }
    } catch {
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

  // Airdrops are SOL-only
  if (parsedAmount.token && parsedAmount.token !== 'SOL') {
    await message.reply(
      `❌ **Airdrops are SOL-only.**\n\nSwap your ${parsedAmount.token} to SOL first: \`${prefix}swap ${parsedAmount.token} SOL\``
    );
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

  const tokenSymbol = 'SOL';
  const tokenMint = TOKEN_MINTS.SOL;
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

  // Round to token precision to eliminate floating-point epsilon artifacts
  // (e.g. 1.297 + 0.00239 = 1.2993999...998 instead of 1.2994 due to IEEE 754)
  const TOKEN_DECIMALS = tokenSymbol === 'SOL' ? 9 : 6;
  amountToken = Math.round(amountToken * 10 ** TOKEN_DECIMALS) / 10 ** TOKEN_DECIMALS;

  // Validate amount
  if (amountToken <= 0) {
    await message.reply('❌ Amount must be greater than 0.');
    return;
  }

  // Enforce $1 minimum
  if (usdValue <= 0) {
    await message.reply('❌ Unable to determine the USD value of your airdrop. Please try again.');
    return;
  }
  if (usdValue < 1) {
    await message.reply(
      `❌ **Minimum airdrop amount is $1.00.**\n\nYour airdrop is only worth ~$${usdValue.toFixed(2)}.`
    );
    return;
  }

  // Calculate gas buffer for the airdrop wallet.
  // Settlement reserves FEE_BUFFERS.STANDARD (0.001 SOL) per winner for fees + priority fees,
  // plus rent exemption for the pool wallet itself.
  // When max-winners is not set (unlimited), we use a conservative default of 10
  // because the actual gas cost depends on how many users claim — not a fixed 100.
  const winnerCount = maxWinners || 10;
  const RENT_EXEMPTION = 0.00089088; // Rent-exempt minimum for the pool wallet account
  const FEE_PER_WINNER = 0.001; // Matches FEE_BUFFERS.STANDARD used by settlement
  const GAS_BUFFER = RENT_EXEMPTION + winnerCount * FEE_PER_WINNER;

  // Block airdrops where gas would exceed 50% of the total cost (SOL airdrops only)
  if (tokenSymbol === 'SOL' && parsedAmount.type !== 'max') {
    const totalCost = amountToken + GAS_BUFFER;
    const gasPercentage = (GAS_BUFFER / totalCost) * 100;

    if (gasPercentage > 50) {
      const price = await priceService.getTokenPrice(TOKEN_MINTS.SOL);
      const solPrice = price ? price.price : 0;
      const gasUsd = GAS_BUFFER * solPrice;
      const amountUsd = amountToken * solPrice;

      await message.reply(
        `❌ **Gas cost too high — airdrop cancelled**\n\n` +
          `Your **$${amountUsd.toFixed(2)}** SOL airdrop would require **$${gasUsd.toFixed(2)}** in gas ` +
          `(${GAS_BUFFER.toFixed(4)} SOL buffer for ${winnerCount} winner${winnerCount !== 1 ? 's' : ''}).\n` +
          `Gas would be **${gasPercentage.toFixed(0)}%** of the total cost.\n\n` +
          `**Suggestions:**\n` +
          `• Use USDC or USDT instead (much lower gas)\n` +
          `• Increase the airdrop amount\n` +
          `• Set a max-winner count: \`${prefix}airdrop $10 10m 5\``
      );
      return;
    }
  }

  // Get pool wallet (already in database for recovery if verification fails)
  const poolWallet = await poolService.getOrCreateWallet();
  console.log(`[AIRDROP] Using pool wallet: ${poolWallet.address}`);

  // Gas buffer variables already calculated above for validation

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

  // Fund pool wallet
  const senderKeypair = await walletService.getKeypair(sender.encryptedPrivkey, sender.keySalt);
  const fundingSignatures: string[] = [];

  try {
    // For max, amountToken already has gas buffer subtracted, so we don't add it again
    let solToSend = tokenSymbol === 'SOL' ? amountToken + GAS_BUFFER : GAS_BUFFER;
    if (parsedAmount.type === 'max' && tokenSymbol === 'SOL') {
      solToSend = amountToken;
    }

    const solSig = await transactionService.transfer(
      senderKeypair,
      poolWallet.address,
      solToSend,
      TOKEN_MINTS.SOL
    );
    fundingSignatures.push(solSig);

    if (tokenSymbol !== 'SOL') {
      const tokenSig = await transactionService.transfer(
        senderKeypair,
        poolWallet.address,
        amountToken,
        tokenMint
      );
      fundingSignatures.push(tokenSig);
    }
  } catch (error: any) {
    // Release pool wallet back on failure
    try {
      await poolService.releaseWallet(poolWallet.address);
    } catch (releaseError) {
      console.error('Failed to release pool wallet after funding failure:', releaseError);
    }
    await message.reply(`❌ Failed to fund airdrop: ${error.message || 'Unknown error'}`);
    return;
  }

  // Wait for all funding transactions to be confirmed

  try {
    const connection = new Connection(process.env.SOLANA_RPC_URL!);
    for (const sig of fundingSignatures) {
      await connection.confirmTransaction(sig, 'confirmed');
    }
  } catch (confirmError: any) {
    console.error('Transaction confirmation failed:', confirmError);
    // Release the pool wallet back if confirmation failed
    try {
      await poolService.releaseWallet(poolWallet.address);
    } catch (releaseError) {
      console.error('Failed to release pool wallet after confirmation failure:', releaseError);
    }
    const isCongestion =
      confirmError?.message?.includes('block height exceeded') ||
      confirmError?.message?.includes('Blockhash not found');
    await message.reply(
      isCongestion
        ? '❌ The Solana network is currently congested and could not confirm the airdrop funding in time. Please try again in a moment.'
        : '❌ Transaction confirmation failed. Please check your wallet and try again.'
    );
    return;
  }

  // Verify the pool wallet was funded before creating airdrop

  let verified = false;
  let retryCount = 0;
  const maxRetries = 5;

  while (!verified && retryCount < maxRetries) {
    try {
      const walletBalances = await balanceService.getBalances(poolWallet.address);
      if (tokenMint === TOKEN_MINTS.SOL) {
        console.log(
          `[AIRDROP] Balance check attempt ${retryCount + 1}: wallet=${walletBalances.sol} SOL, expected>=${amountToken} SOL`
        );
        if (walletBalances.sol >= amountToken) {
          verified = true;
        } else if (retryCount === maxRetries - 1) {
          console.error(
            `[AIRDROP] Verification failed for pool wallet ${poolWallet.address}. Balance: ${walletBalances.sol}, Expected: ${amountToken}. Funds are recoverable.`
          );
          // Create a FAILED airdrop record so recovery knows who funded this wallet
          await prisma.airdrop.create({
            data: {
              walletPubkey: poolWallet.address,
              encryptedPrivkey: poolWallet.encryptedPrivkey,
              keySalt: poolWallet.keySalt,
              creatorId: sender.discordId,
              amountTotal: amountToken,
              tokenMint,
              maxParticipants: maxWinners ?? 0,
              expiresAt,
              channelId: message.channel.id,
              status: 'FAILED',
              guildId: message.guild?.id,
            },
          });
          await message.reply(
            '❌ Failed to verify SOL in airdrop wallet. The pool wallet has been reserved and funds will be automatically recovered.'
          );
          return;
        }
      } else {
        const tokenBal = tokenMint === TOKEN_MINTS.USDC ? walletBalances.usdc : walletBalances.usdt;
        console.log(
          `[AIRDROP] Balance check attempt ${retryCount + 1}: wallet=${tokenBal} ${tokenSymbol}, expected>=${amountToken} ${tokenSymbol}`
        );
        if (tokenBal >= amountToken) {
          verified = true;
        } else if (retryCount === maxRetries - 1) {
          console.error(
            `[AIRDROP] Verification failed for pool wallet ${poolWallet.address}. Balance: ${tokenBal}, Expected: ${amountToken}. Funds are recoverable.`
          );
          // Create a FAILED airdrop record so recovery knows who funded this wallet
          await prisma.airdrop.create({
            data: {
              walletPubkey: poolWallet.address,
              encryptedPrivkey: poolWallet.encryptedPrivkey,
              keySalt: poolWallet.keySalt,
              creatorId: sender.discordId,
              amountTotal: amountToken,
              tokenMint,
              maxParticipants: maxWinners ?? 0,
              expiresAt,
              channelId: message.channel.id,
              status: 'FAILED',
              guildId: message.guild?.id,
            },
          });
          await message.reply(
            `❌ Failed to verify ${tokenSymbol} in airdrop wallet. The pool wallet has been reserved and funds will be automatically recovered.`
          );
          return;
        }
      }

      if (!verified) {
        retryCount++;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (verifyError) {
      console.error(`Balance verification failed (attempt ${retryCount + 1}):`, verifyError);
      retryCount++;
      if (retryCount >= maxRetries) {
        console.error('Max retries reached for balance verification');
        // Continue anyway - the balance check might fail due to RPC issues
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Create airdrop in DB
  const airdrop = await prisma.airdrop.create({
    data: {
      walletPubkey: poolWallet.address,
      encryptedPrivkey: poolWallet.encryptedPrivkey,
      keySalt: poolWallet.keySalt,
      creatorId: sender.discordId,
      amountTotal: amountToken,
      tokenMint,
      maxParticipants: maxWinners ?? 0,
      expiresAt,
      channelId: message.channel.id,
      guildId: message.guild?.id,
    },
  });

  // Send embed with claim button
  const endTimestamp = Math.floor(expiresAt.getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle('🎉 Solana Airdrop!')
    .setDescription(
      `**${message.author}** dropped a pot of **${amountToken.toFixed(2)} ${tokenSymbol}** (~$${usdValue.toFixed(2)})!\n\n` +
        `Click **Claim** to enter.\n` +
        `⏳ Ends: <t:${endTimestamp}:R>`
    )
    .setColor(0x00ff00)
  .addFields(
    {
      name: 'Pot Size',
      value: `${amountToken.toFixed(2)} ${tokenSymbol} (~$${usdValue.toFixed(2)})`,
      inline: true,
    },
    { name: 'Max Winners', value: maxWinners ? `${maxWinners}` : 'Unlimited', inline: true },
    {
      name: 'Airdrop Wallet',
      value: `[${poolWallet.address.substring(0, 6)}...${poolWallet.address.substring(poolWallet.address.length - 4)}](https://solscan.io/account/${poolWallet.address})`,
      inline: true,
    }
  )
  .setFooter({ text: 'Funds are held securely in a temporary wallet. Residual gas is returned after settlement.' });

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

  const qrBuffer = await generateDepositQR(user.walletPubkey);
  const attachment = new AttachmentBuilder(qrBuffer, { name: 'deposit-qr.png' });

  const embed = new EmbedBuilder()
    .setTitle('Your Solana Deposit Address')
    .setImage('attachment://deposit-qr.png')
    .addFields({
      name: 'Solana Address',
      value: `\`\`\`\n${user.walletPubkey}\n\`\`\``,
    })
    .setDescription('Scan with your Solana wallet app or copy the address above to deposit SOL, USDC, or USDT.')
    .setColor(0x00aaff)
    .setTimestamp();

  await message.reply({
    embeds: [embed],
    files: [attachment],
  });

  try {
    await message.author.send(
      `Your FatTips Solana deposit address:\n\`\`\`\n${user.walletPubkey}\n\`\`\`\nKeep this message for easy copying. Only send SOL, USDC, or USDT on the Solana network to this address.`
    );
    // Send the address alone in plain text for easy copying on mobile
    await message.author.send(user.walletPubkey);
  } catch {
    // DMs disabled — address already shown in channel
  }
}

// ============ LEADERBOARD ============
async function handleLeaderboard(message: Message, args: string[], prefix: string) {
  if (!message.guild) {
    await message.reply('Leaderboards are only available in servers.');
    return;
  }

  const type = args[0]?.toLowerCase() || 'airdrops';
  const limit = Math.min(parseInt(args[1]) || 10, 20);
  const guildId = message.guild.id;

  try {
    switch (type) {
      case 'airdrops':
        await showPrefixTopAirdropCreators(message, guildId, limit);
        break;
      case 'rain':
        await showPrefixTopRainSenders(message, guildId, limit);
        break;
      case 'guild':
        await showPrefixGuildStats(message, guildId);
        break;
      default:
        await message.reply(
          `Usage: \`${prefix}leaderboard [airdrops|rain|guild] [limit]\`\n` +
            `Example: \`${prefix}lb airdrops 10\`, \`${prefix}lb rain\`, \`${prefix}lb guild\``
        );
    }
  } catch (error) {
    logger.error('Error in leaderboard prefix command:', error);
    await message.reply('❌ Failed to fetch leaderboard. Please try again.').catch(() => {});
  }
}

async function showPrefixTopAirdropCreators(message: Message, guildId: string, limit: number) {
  const topCreators = await prisma.airdrop.groupBy({
    by: ['creatorId'],
    _sum: {
      amountClaimed: true,
    },
    _count: {
      id: true,
    },
    orderBy: {
      _sum: {
        amountClaimed: 'desc',
      },
    },
    take: limit,
    where: {
      status: 'SETTLED',
      guildId: guildId,
    },
  });

  if (topCreators.length === 0) {
    await message.reply('No settled airdrops in this server yet.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎁 Top Airdrop Creators')
    .setColor(0xff6b6b)
    .setTimestamp();

  let description = '';
  let rank = 1;

  for (const creator of topCreators) {
    if (!creator.creatorId) continue;

    const totalDistributed = creator._sum.amountClaimed
      ? Number(creator._sum.amountClaimed).toFixed(2)
      : '0.00';
    const airdropCount = creator._count.id;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
    description += `${medal} <@${creator.creatorId}> — **${totalDistributed}** distributed (${airdropCount} airdrop${airdropCount !== 1 ? 's' : ''})\n`;
    rank++;
  }

  embed.setDescription(description || 'No data available.');
  await message.reply({ embeds: [embed] });
}

async function showPrefixTopRainSenders(message: Message, guildId: string, limit: number) {
  const topRainSenders = await prisma.transaction.groupBy({
    by: ['fromId'],
    _sum: { amountUsd: true },
    _count: { id: true },
    orderBy: { _sum: { amountUsd: 'desc' } },
    take: limit,
    where: { txType: 'TIP', status: 'CONFIRMED', guildId: guildId, fromId: { not: null } },
  });

  if (topRainSenders.length === 0) {
    await message.reply('No tips sent in this server yet.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🌧️ Top Rain Senders')
    .setColor(0x00aaff)
    .setTimestamp();

  let description = '';
  let rank = 1;

  for (const sender of topRainSenders) {
    if (!sender.fromId) continue;

    const totalUsd = sender._sum.amountUsd ? Number(sender._sum.amountUsd).toFixed(2) : '0.00';
    const tipCount = sender._count.id;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
    description += `${medal} <@${sender.fromId}> — **$${totalUsd}** (${tipCount} tip${tipCount !== 1 ? 's' : ''})\n`;
    rank++;
  }

  embed.setDescription(description || 'No data available.');
  await message.reply({ embeds: [embed] });
}

async function showPrefixGuildStats(message: Message, guildId: string) {
  const tipStats = await prisma.transaction.aggregate({
    where: {
      txType: 'TIP',
      status: 'CONFIRMED',
      guildId: guildId,
    },
    _sum: {
      amountUsd: true,
    },
    _count: {
      id: true,
    },
  });

  const airdropStats = await prisma.airdrop.aggregate({
    where: {
      guildId: guildId,
      status: 'SETTLED',
    },
    _sum: {
      amountClaimed: true,
    },
    _count: {
      id: true,
    },
  });

  const uniqueTippers = await prisma.transaction.findMany({
    where: {
      txType: 'TIP',
      status: 'CONFIRMED',
      guildId: guildId,
    },
    select: { fromId: true },
    distinct: ['fromId'],
  });

  const uniqueReceivers = await prisma.transaction.findMany({
    where: {
      txType: 'TIP',
      status: 'CONFIRMED',
      guildId: guildId,
      toId: { not: null },
    },
    select: { toId: true },
    distinct: ['toId'],
  });

  const totalTipVolume = tipStats._sum.amountUsd
    ? Number(tipStats._sum.amountUsd).toFixed(2)
    : '0.00';
  const totalAirdropVolume = airdropStats._sum.amountClaimed
    ? Number(airdropStats._sum.amountClaimed).toFixed(2)
    : '0.00';

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${message.guild!.name} Stats`)
    .setColor(0x5865f2)
    .setTimestamp();

  embed.addFields(
    {
      name: '💸 Tips & Rain',
      value: `**${tipStats._count.id}** tips sent\n**$${totalTipVolume}** total volume\n**${uniqueTippers.length}** unique senders\n**${uniqueReceivers.length}** unique receivers`,
      inline: true,
    },
    {
      name: '🎁 Airdrops',
      value: `**${airdropStats._count.id}** airdrops settled\n**${totalAirdropVolume}** total distributed`,
      inline: true,
    }
  );

  await message.reply({ embeds: [embed] });
}

// ============ STATS ============
async function handleStats(message: Message) {
  const mentionedUser = message.mentions.users.first();
  const targetId = mentionedUser?.id || message.author.id;
  const isSelf = targetId === message.author.id;

  const user = await prisma.user.findUnique({
    where: { discordId: targetId },
  });

  if (!user) {
    await message.reply(
      isSelf
        ? "You don't have a wallet yet! Use `f wallet create` to get started."
        : `<@${targetId}> doesn't have a wallet yet.`
    );
    return;
  }

  const sentTips = await prisma.transaction.aggregate({
    where: {
      fromId: targetId,
      txType: 'TIP',
      status: 'CONFIRMED',
    },
    _sum: { amountUsd: true },
    _count: { id: true },
  });

  const receivedTips = await prisma.transaction.aggregate({
    where: {
      toId: targetId,
      txType: 'TIP',
      status: 'CONFIRMED',
    },
    _sum: { amountUsd: true },
    _count: { id: true },
  });

  const airdropsCreated = await prisma.airdrop.aggregate({
    where: {
      creatorId: targetId,
      status: 'SETTLED',
    },
    _sum: { amountClaimed: true },
    _count: { id: true },
  });

  const airdropsWon = await prisma.airdropParticipant.count({
    where: {
      userId: targetId,
    },
  });

  const sentTotal = sentTips._sum.amountUsd ? Number(sentTips._sum.amountUsd).toFixed(2) : '0.00';
  const receivedTotal = receivedTips._sum.amountUsd
    ? Number(receivedTips._sum.amountUsd).toFixed(2)
    : '0.00';
  const airdropTotal = airdropsCreated._sum.amountClaimed
    ? Number(airdropsCreated._sum.amountClaimed).toFixed(2)
    : '0.00';

  const title = isSelf ? '📊 Your Stats' : `📊 ${mentionedUser!.username}'s Stats`;

  const embed = new EmbedBuilder().setTitle(title).setColor(0x5865f2).setTimestamp();

  embed.addFields(
    {
      name: '💸 Tips Sent',
      value: `**${sentTips._count.id}** tips\n**$${sentTotal}** total`,
      inline: true,
    },
    {
      name: '📥 Tips Received',
      value: `**${receivedTips._count.id}** tips\n**$${receivedTotal}** total`,
      inline: true,
    },
    {
      name: '🎁 Airdrops Created',
      value: `**${airdropsCreated._count.id}** airdrops\n**${airdropTotal}** distributed`,
      inline: true,
    },
    {
      name: '🏆 Airdrops Won',
      value: `**${airdropsWon}** claims`,
      inline: true,
    }
  );

  await message.reply({ embeds: [embed] });
}
