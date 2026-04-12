import { Worker, Job } from 'bullmq';
import { Client, TextChannel, EmbedBuilder } from 'discord.js';
import { prisma } from 'fattips-database';
import { TransactionService, WalletService, BalanceService, TOKEN_MINTS } from 'fattips-solana';
import IORedis from 'ioredis';
import { REDIS_CONNECTION_OPTS, TransferJobData } from '../queues/transaction.queue';

const connection = new IORedis({
  ...REDIS_CONNECTION_OPTS,
  maxRetriesPerRequest: null,
});

// Services
const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

export function initTransactionWorker(client: Client) {
  const worker = new Worker<TransferJobData>(
    'transactions',
    async (job: Job<TransferJobData>) => {
      const {
        type,
        senderDiscordId,
        senderUsername,
        recipientDiscordIds,
        toAddress,
        amountPerUser,
        tokenMint,
        tokenSymbol,
        usdValuePerUser,
        channelId,
        messageId,
        guildId,
      } = job.data;

      console.log(`[Worker] Processing job ${job.id}: ${type} from ${senderDiscordId}`);

      try {
        // 1. Get Sender Wallet
        const sender = await prisma.user.findUnique({
          where: { discordId: senderDiscordId },
        });

        if (!sender) {
          throw new Error('Sender wallet not found');
        }

        // 2. Prepare Recipients or Target Address
        const recipientWallets = [];
        let targetPubkey = '';

        if (type === 'WITHDRAWAL') {
          if (!toAddress) throw new Error('Withdrawal job missing toAddress');
          targetPubkey = toAddress;
        } else {
          // TIP or RAIN
          if (!recipientDiscordIds || recipientDiscordIds.length === 0) {
            throw new Error('No recipients provided');
          }

          for (const recipientId of recipientDiscordIds) {
            const recipient = await prisma.user.findUnique({
              where: { discordId: recipientId },
            });
            if (recipient) {
              recipientWallets.push(recipient);
            }
          }

          if (recipientWallets.length === 0) {
            throw new Error('No valid internal recipients found');
          }
        }

        // 3. Execute Transfer
        const senderKeypair = await walletService.getKeypair(
          sender.encryptedPrivkey,
          sender.keySalt
        );

        // Re-verify balance just before execution to prevent TOCTOU race conditions
        const balances = await balanceService.getBalances(sender.walletPubkey);
        const totalAmount =
          type === 'WITHDRAWAL' ? amountPerUser : amountPerUser * (recipientWallets.length || 1);

        const MIN_RENT_EXEMPTION = 0.00089088;
        const FEE_BUFFER = 0.001;

        if (tokenMint === TOKEN_MINTS.SOL) {
          // For withdrawals, the command handler already subtracted fees from the amount,
          // so only check that we have enough for the transfer itself
          const required =
            type === 'WITHDRAWAL' ? totalAmount : totalAmount + FEE_BUFFER + MIN_RENT_EXEMPTION;
          if (balances.sol < required) {
            throw new Error(
              `Insufficient SOL at execution time. Need ${required.toFixed(6)}, have ${balances.sol.toFixed(6)}. ` +
                `Balance may have changed since the command was issued.`
            );
          }
        } else {
          const tokenBal = tokenMint === TOKEN_MINTS.USDC ? balances.usdc : balances.usdt;
          if (tokenBal < totalAmount) {
            throw new Error(
              `Insufficient ${tokenSymbol} at execution time. Need ${totalAmount.toFixed(6)}, have ${tokenBal.toFixed(6)}. ` +
                `Balance may have changed since the command was issued.`
            );
          }
          if (balances.sol < FEE_BUFFER) {
            throw new Error('Insufficient SOL for gas fees at execution time.');
          }
        }

        // Helper: edit the "Processing..." message to show a congestion warning on retry
        const onRetry = async (_attempt: number) => {
          if (!channelId || !messageId) return;
          try {
            const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
            if (!channel) return;
            const msg = await channel.messages.fetch(messageId);
            if (msg.author.id === client.user?.id) {
              await msg.edit(
                `⏳ Still processing... The Solana network is experiencing congestion right now. Your transaction is being retried with a higher priority fee — hang tight.`
              );
            }
          } catch {
            // Non-critical — ignore if message is gone or inaccessible
          }
        };

        let signature: string;

        if (type === 'WITHDRAWAL') {
          // Withdrawal to external address
          signature = await transactionService.transfer(
            senderKeypair,
            targetPubkey,
            amountPerUser,
            tokenMint,
            { priorityFee: !job.data.skipPriorityFee, onRetry }
          );
        } else if (recipientWallets.length === 1 && type !== 'RAIN') {
          // Single internal transfer
          signature = await transactionService.transfer(
            senderKeypair,
            recipientWallets[0].walletPubkey,
            amountPerUser,
            tokenMint,
            { onRetry }
          );
        } else {
          // Batch transfer (Rain or Multi-tip)
          const transfers = recipientWallets.map((r) => ({
            recipient: r.walletPubkey,
            amount: amountPerUser,
          }));
          signature = await transactionService.batchTransfer(senderKeypair, transfers, tokenMint, {
            onRetry,
          });
        }

        // 4. Log Transactions
        if (type === 'WITHDRAWAL') {
          await prisma.transaction.create({
            data: {
              signature,
              fromId: sender.discordId,
              toAddress: targetPubkey,
              amountUsd: usdValuePerUser,
              amountToken: amountPerUser,
              tokenMint,
              usdRate: usdValuePerUser > 0 ? usdValuePerUser / amountPerUser : 0,
              txType: 'WITHDRAWAL',
              status: 'CONFIRMED',
              guildId: guildId,
            },
          });
        } else {
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
                txType: type === 'RAIN' ? 'TIP' : type,
                status: 'CONFIRMED',
                guildId: guildId,
              },
            });
          }
        }

        // 5. Notify Discord
        // For withdrawals: send DM to user
        // For tips/rain: edit/reply in channel
        if (type === 'WITHDRAWAL' && senderDiscordId) {
          try {
            const user = await client.users.fetch(senderDiscordId);
            const embed = new EmbedBuilder()
              .setTitle('📤 Withdrawal Successful')
              .setDescription(
                `Sent **${amountPerUser.toFixed(4)} ${tokenSymbol}** (~$${usdValuePerUser.toFixed(2)}) to:\n\`${targetPubkey}\`\n\n[View on Solscan](https://solscan.io/tx/${signature})`
              )
              .setColor(0x00ff00)
              .setTimestamp();
            await user.send({ embeds: [embed] });
          } catch (discordError: any) {
            // 50001: Missing Access, 50007: Cannot DM
            if (discordError.code === 50001 || discordError.code === 50007) {
              console.warn(
                `[Worker] Could not DM user ${senderDiscordId}: User likely blocked bot or closed DMs`
              );
            } else {
              console.error(
                `[Worker] Failed to send withdrawal DM to user ${senderDiscordId}:`,
                discordError
              );
            }
          }
        } else if (channelId && messageId) {
          // Only for tips/rain - edit/reply in channel
          const userMentions = recipientWallets.map((r) => `<@${r.discordId}>`).join(', ');
          const title = type === 'RAIN' ? '🌧️ Making it Rain!' : '💸 Tip Sent!';
          const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(
              `**<@${senderDiscordId}>** sent ${userMentions}\n\n` +
                `**Amount:** ${amountPerUser.toFixed(4)} ${tokenSymbol} (~$${usdValuePerUser.toFixed(2)}) each\n` +
                `[View on Solscan](https://solscan.io/tx/${signature})`
            )
            .setColor(0x00ff00)
            .setTimestamp();

          let notified = false;
          try {
            const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
            if (channel) {
              try {
                const originalMsg = await channel.messages.fetch(messageId);
                // If it was a "Processing..." message, edit it. Otherwise reply.
                if (originalMsg.author.id === client.user?.id) {
                  await originalMsg.edit({ content: '', embeds: [embed] });
                } else {
                  await originalMsg.reply({ embeds: [embed] });
                }
                notified = true;
              } catch (msgError: any) {
                // 10008: Unknown Message (already deleted) — no cleanup needed, just send fresh
                // Other codes: original message may still exist; delete it to avoid orphan
                console.warn(
                  `[Worker] Could not edit original message for job ${job.id} (code ${msgError.code}): falling back to channel.send`
                );
                await channel.send({ content: `<@${senderDiscordId}>`, embeds: [embed] });
                notified = true;
                if (msgError.code !== 10008) {
                  // Best-effort delete of the stuck "Processing..." message
                  try {
                    const stuckMsg = await channel.messages.fetch(messageId!);
                    await stuckMsg.delete();
                  } catch {
                    // Already gone or no permission — ignore
                  }
                }
              }
            } else {
              console.warn(`[Worker] Channel ${channelId} not found for job ${job.id}`);
            }
          } catch (discordError: any) {
            // 50001: Missing Access
            console.warn(
              `[Worker] Could not post to channel ${channelId} for job ${job.id} (code ${discordError.code}): ${discordError.message}`
            );
          }

          // Last-resort fallback: DM the sender so they know it went through
          if (!notified) {
            try {
              const sender = await client.users.fetch(senderDiscordId);
              await sender.send({ embeds: [embed] });
            } catch (dmError: any) {
              console.error(
                `[Worker] Could not DM sender ${senderDiscordId} as fallback for job ${job.id}:`,
                dmError
              );
            }
          }
        }

        // 6. Notify Recipients (DM) - Only for internal transfers
        if (type !== 'WITHDRAWAL') {
          for (const recipient of recipientWallets) {
            try {
              const user = await client.users.fetch(recipient.discordId);
              const msg = `💸 You received **${amountPerUser.toFixed(4)} ${tokenSymbol}** (~$${usdValuePerUser.toFixed(2)}) from ${senderUsername || 'a user'}!`;
              await user.send(msg);
            } catch (e) {
              console.error(`Failed to DM user ${recipient.discordId}`);
            }
          }
        }
      } catch (error: any) {
        console.error(`Job ${job.id} failed:`, error);

        // Provide user-friendly error messages for common Solana errors
        let userErrorMessage = error.message;

        // Check for "no record of a prior credit" error - means 0 SOL balance
        if (error.message?.includes('no record of a prior credit')) {
          userErrorMessage =
            'Insufficient SOL for transaction fees. Please deposit SOL to your wallet to pay for gas.';
        }

        // Check for insufficient funds errors
        if (
          error.message?.includes('insufficient funds') ||
          error.message?.includes('InsufficientFunds')
        ) {
          userErrorMessage = 'Insufficient token balance for this transaction.';
        }

        // Check for network congestion / block height exceeded errors
        if (
          error.message?.includes('block height exceeded') ||
          error.message?.includes('Blockhash not found') ||
          error.message?.includes('currently congested')
        ) {
          userErrorMessage =
            'The Solana network is currently congested and could not process this transaction in time. Please try again in a moment.';
        }

        // Notify failure
        let failureNotified = false;
        if (channelId && messageId) {
          try {
            const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
            if (channel) {
              try {
                const originalMsg = await channel.messages.fetch(messageId);
                if (originalMsg.author.id === client.user?.id) {
                  await originalMsg.edit(
                    `❌ Transaction failed for <@${senderDiscordId}>: ${userErrorMessage}`
                  );
                } else {
                  await originalMsg.reply(`❌ Transaction failed: ${userErrorMessage}`);
                }
              } catch (msgError: any) {
                console.warn(
                  `[Worker] Could not edit failure message for job ${job.id} (code ${msgError.code}): falling back to channel.send`
                );
                await channel.send(
                  `❌ Transaction failed for <@${senderDiscordId}>: ${userErrorMessage}`
                );
                if (msgError.code !== 10008) {
                  // Best-effort delete of the stuck "Processing..." message
                  try {
                    const stuckMsg = await channel.messages.fetch(messageId!);
                    await stuckMsg.delete();
                  } catch {
                    // Already gone or no permission — ignore
                  }
                }
              }
              failureNotified = true;
            } else {
              console.warn(
                `[Worker] Channel ${channelId} not found for failure notification, job ${job.id}`
              );
            }
          } catch (discordError: any) {
            console.warn(
              `[Worker] Could not post failure to channel ${channelId} for job ${job.id} (code ${discordError.code}): ${discordError.message}`
            );
          }
        }

        // Last-resort fallback: DM sender with failure
        if (!failureNotified) {
          try {
            const sender = await client.users.fetch(senderDiscordId);
            await sender.send(`❌ Transaction failed: ${userErrorMessage}`);
          } catch (dmError: any) {
            console.error(
              `[Worker] Could not DM sender ${senderDiscordId} as failure fallback for job ${job.id}:`,
              dmError
            );
          }
        }

        throw error;
      }
    },
    { connection }
  );

  worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} completed!`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
