import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
  InteractionContextType,
} from 'discord.js';
import { prisma } from 'fattips-database';
import {
  JupiterSwapService,
  WalletService,
  BalanceService,
  TOKEN_MINTS,
  PriceService,
} from 'fattips-solana';
import { logger } from '../utils/logger';

const swapService = new JupiterSwapService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

export const data = new SlashCommandBuilder()
  .setName('swap')
  .setDescription('Swap between SOL, USDC, and USDT')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .addStringOption((option) =>
    option.setName('amount').setDescription('Amount to swap (e.g. 1.5)').setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('from')
      .setDescription('Token to swap FROM')
      .setRequired(true)
      .addChoices(
        { name: 'SOL', value: 'SOL' },
        { name: 'USDC', value: 'USDC' },
        { name: 'USDT', value: 'USDT' }
      )
  )
  .addStringOption((option) =>
    option
      .setName('to')
      .setDescription('Token to swap TO')
      .setRequired(true)
      .addChoices(
        { name: 'SOL', value: 'SOL' },
        { name: 'USDC', value: 'USDC' },
        { name: 'USDT', value: 'USDT' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const amountStr = interaction.options.getString('amount', true);
  const fromToken = interaction.options.getString('from', true);
  const toToken = interaction.options.getString('to', true);

  if (fromToken === toToken) {
    await interaction.reply({
      content: '❌ You cannot swap the same token!',
      ephemeral: true,
    });
    return;
  }

  // Parse amount with support for "max" / "all"
  let amount = 0;
  const isMax = amountStr.toLowerCase() === 'max' || amountStr.toLowerCase() === 'all';

  if (!isMax) {
    if (amountStr.startsWith('$')) {
      const value = parseFloat(amountStr.substring(1));
      if (isNaN(value) || value <= 0) {
        await interaction.reply({
          content: '❌ Invalid USD amount. Please enter a positive number.',
          ephemeral: true,
        });
        return;
      }

      const priceService = new PriceService(
        process.env.JUPITER_API_URL,
        process.env.JUPITER_API_KEY
      );
      const inputMint = TOKEN_MINTS[fromToken as keyof typeof TOKEN_MINTS];
      const conversion = await priceService.convertUsdToToken(value, inputMint, fromToken);

      if (!conversion) {
        await interaction.reply({
          content: '❌ Failed to fetch prices. Try again.',
          ephemeral: true,
        });
        return;
      }
      amount = conversion.amountToken;
    } else {
      amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) {
        await interaction.reply({
          content: '❌ Invalid amount. Please enter a positive number or "max".',
          ephemeral: true,
        });
        return;
      }
    }
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // 1. Get User Wallet
    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content: '❌ You do not have a wallet yet. Use `/wallet create` first.',
      });
      return;
    }

    // 2. Check Balance & Resolve Max
    const balances = await balanceService.getBalances(user.walletPubkey);
    let balance = 0;
    if (fromToken === 'SOL') balance = balances.sol;
    else if (fromToken === 'USDC') balance = balances.usdc;
    else if (fromToken === 'USDT') balance = balances.usdt;

    let useGasless = false;
    const LOW_SOL_THRESHOLD = 0.001; // 0.001 SOL buffer for fees (~$0.15)

    // Decide Gasless FIRST (needed for max calc)
    if (fromToken !== 'SOL' && balances.sol < LOW_SOL_THRESHOLD) {
      useGasless = true;
    }

    if (isMax) {
      if (fromToken === 'SOL') {
        // Standard SOL swap: Reserve buffer
        amount = Math.max(0, balance - LOW_SOL_THRESHOLD);
      } else {
        // Token swap
        if (useGasless) {
          // Gasless: Use full balance (fee is taken from it by API)
          // Actually, API needs input amount.
          // If we say amount = balance, API will take fee from output?
          // Jupiter Ultra API "pay fee in token": Usually deducted from output or input.
          // If 'ExactIn', we send X, receive Y - fee.
          // If we want to drain wallet, we send X (balance).
          amount = balance;
        } else {
          // Standard swap: Use full balance (fee paid in SOL)
          amount = balance;
        }
      }

      if (amount <= 0) {
        await interaction.editReply({
          content: `❌ Insufficient balance to swap (need buffer for fees). Balance: ${balance} ${fromToken}`,
        });
        return;
      }
    }

    if (balance < amount) {
      await interaction.editReply({
        content: `❌ Insufficient ${fromToken} balance. You have ${balance} ${fromToken}.`,
      });
      return;
    }

    // Fee buffer check for SOL (skip if gasless or if input is not SOL)
    // If gasless, the fee is taken from the input amount, so we might need a small buffer or just trust the API.
    // The API will reject if amount + fee > balance.
    if (!useGasless && fromToken === 'SOL' && balance < amount + LOW_SOL_THRESHOLD) {
      await interaction.editReply({
        content: `❌ You need to leave some SOL for gas fees (approx ${LOW_SOL_THRESHOLD} SOL).`,
      });
      return;
    } else if (fromToken !== 'SOL' && !useGasless && balances.sol < LOW_SOL_THRESHOLD) {
      // Should have been caught by gasless check above, but as fallback
      // If we somehow didn't activate gasless (e.g., token not supported), warn.
      // But for now, we assume gasless is attempted.
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
        // Fallback to error message if gasless fails (e.g. token not supported, though we only support main tokens)
        const errorMessage = `❌ Gasless swap unavailable. Your SOL balance is too low (< ${LOW_SOL_THRESHOLD}) to pay for gas, and the amount you are swapping is likely too small to cover the fees in tokens.

**Solution:** Deposit at least 0.01 SOL to your wallet using \`/deposit\`.

*Debug:* ${error.message}`;

        await interaction.editReply({
          content: errorMessage,
        });
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
        await interaction.editReply({ content: `❌ Failed to get quote: ${error.message}` });
        return;
      }
    }

    // 4. Show Confirmation Embed
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
      .setCustomId('confirm_swap')
      .setLabel('Confirm Swap')
      .setStyle(ButtonStyle.Success);

    const cancelButton = new ButtonBuilder()
      .setCustomId('cancel_swap')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

    const reply = await interaction.editReply({
      embeds: [embed],
      components: [row],
    });

    // 5. Handle Confirmation
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000, // 60s timeout
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'Not your swap!', ephemeral: true });
        return;
      }

      if (i.customId === 'cancel_swap') {
        await i.update({ content: '❌ Swap cancelled.', embeds: [], components: [] });
        collector.stop('cancelled');
        return;
      }

      if (i.customId === 'confirm_swap') {
        await i.update({
          content: '🔄 Processing swap on Solana... (this may take up to 30s)',
          embeds: [],
          components: [],
        });

        try {
          // Get Swap Transaction
          let swapTransactionBase64 = '';
          if (useGasless) {
            swapTransactionBase64 = (quote as any).transaction;
          } else {
            swapTransactionBase64 = await swapService.getSwapTransaction(quote, user.walletPubkey);
          }

          // Decrypt User Key
          const userKeypair = await walletService.getKeypair(user.encryptedPrivkey, user.keySalt);

          // Execute
          let signature: string;

          if (useGasless) {
            const requestId = (quote as any).requestId;
            signature = await swapService.executeGaslessSwap(
              userKeypair,
              swapTransactionBase64,
              requestId
            );
          } else {
            signature = await swapService.executeSwap(userKeypair, swapTransactionBase64);
          }

          const successEmbed = new EmbedBuilder()
            .setTitle('✅ Swap Successful!')
            .setColor(0x00ff00)
            .setDescription(
              `Swapped **${amount} ${fromToken}** to **${toToken}**\n\n[View on Solscan](https://solscan.io/tx/${signature})`
            )
            .setTimestamp();

          await interaction.editReply({ content: '', embeds: [successEmbed], components: [] });

          // Log it? (Optional, maybe as 'SWAP' type if schema supports, or generic log)
          logger.info(`Swap success: ${signature} (${user.discordId})`);
        } catch (error) {
          console.error('Swap failed:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await interaction.editReply({
            content: `❌ Swap failed: ${errorMessage}`,
            embeds: [],
            components: [],
          });
        }
        collector.stop('completed');
      }
    });

    collector.on('end', async (collected, reason) => {
      if (reason === 'time') {
        try {
          await interaction.editReply({ content: '❌ Swap timed out.', components: [] });
        } catch (e) {
          // ignore
        }
      }
    });
  } catch (error) {
    logger.error('Error in swap command:', error);
    await interaction.editReply({ content: '❌ An error occurred while preparing the swap.' });
  }
}
