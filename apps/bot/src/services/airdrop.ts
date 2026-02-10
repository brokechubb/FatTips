import { ButtonInteraction, EmbedBuilder, Client, TextChannel } from 'discord.js';
import * as Sentry from '@sentry/node';
import { prisma } from 'fattips-database';
import { logger, logTransaction } from '../utils/logger';
import { TransactionService, WalletService, BalanceService, TOKEN_MINTS } from 'fattips-solana';

// Solana constants
const MIN_RENT_EXEMPTION = 0.00089088; // SOL - minimum to keep account active
const FEE_BUFFERS = {
  TINY: 0.00001, // SOL - for single transactions
  STANDARD: 0.00002, // SOL - for most operations
  BATCH: 0.000005, // SOL - per transaction in batch
  AIRDROP_GAS: 0.003, // SOL - for ephemeral wallets
};
const RENT_RESERVES = {
  STANDARD: MIN_RENT_EXEMPTION,
  SAFETY: 0.001, // SOL - old value for compatibility
};

// Discord error codes
const DISCORD_ERRORS = {
  CANNOT_DM_USER: 50007,
  MISSING_ACCESS: 50001,
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_MESSAGE: 10008,
} as const;

export class AirdropService {
  private transactionService: TransactionService;
  private walletService: WalletService;
  private balanceService: BalanceService;

  constructor() {
    this.transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
    this.walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
    this.balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);
  }

  /**
   * Safely send a DM to a user. If DM fails, optionally notify in a fallback channel.
   * IMPORTANT: Never send private keys to public channels!
   */
  private async safeSendDM(
    client: Client,
    userId: string,
    message: string,
    options?: {
      fallbackChannelId?: string;
      fallbackMessage?: string; // Safe message for public channel (no sensitive data)
      onSuccess?: (msg: any) => void;
    }
  ): Promise<boolean> {
    try {
      const user = await client.users.fetch(userId);
      const sentMsg = await user.send(message);
      if (options?.onSuccess) {
        options.onSuccess(sentMsg);
      }
      return true;
    } catch (error: any) {
      // Only log at debug level for expected DM failures
      if (error.code === DISCORD_ERRORS.CANNOT_DM_USER) {
        logger.debug(`Cannot DM user ${userId} - DMs disabled`);

        // Send fallback message to channel if provided
        if (options?.fallbackChannelId && options?.fallbackMessage) {
          try {
            const channel = await client.channels.fetch(options.fallbackChannelId);
            if (channel?.isTextBased()) {
              await (channel as TextChannel).send(options.fallbackMessage);
            }
          } catch {
            // Channel also inaccessible, silently fail
          }
        }
        return false;
      }

      // Log unexpected errors
      logger.warn(`Failed to DM user ${userId}:`, { code: error.code, message: error.message });
      return false;
    }
  }

  /**
   * Safely notify the creator about airdrop events via DM
   */
  private async notifyCreator(
    client: Client,
    creatorId: string,
    message: string
  ): Promise<boolean> {
    return this.safeSendDM(client, creatorId, message);
  }

  /**
   * Handle user claiming an airdrop
   */
  async handleClaim(interaction: ButtonInteraction, airdropId: string) {
    await interaction.deferReply({ ephemeral: true });

    try {
      // 1. Get Airdrop
      const airdrop = await prisma.airdrop.findUnique({
        where: { id: airdropId },
      });

      if (!airdrop) {
        await interaction.editReply({ content: '❌ Airdrop not found.' });
        return;
      }

      if (airdrop.status !== 'ACTIVE') {
        await interaction.editReply({ content: '❌ This airdrop has ended.' });
        return;
      }

      if (new Date() > airdrop.expiresAt) {
        await interaction.editReply({ content: '❌ This airdrop has expired.' });
        return;
      }

      if (airdrop.maxParticipants && airdrop.participantCount >= airdrop.maxParticipants) {
        await interaction.editReply({ content: '❌ This airdrop is already full!' });
        return;
      }

      // 2. Check/Create user FIRST (before participant record)
      let user = await prisma.user.findUnique({
        where: { discordId: interaction.user.id },
      });

      let newWalletCreated = false;
      if (!user) {
        try {
          const newWallet = await this.walletService.createEncryptedWallet();
          user = await prisma.user.create({
            data: {
              discordId: interaction.user.id,
              walletPubkey: newWallet.publicKey,
              encryptedPrivkey: newWallet.encryptedPrivateKey,
              keySalt: newWallet.keySalt,
              seedDelivered: false,
            },
          });
          newWalletCreated = true;

          // Try to send DM with private key
          const dmSent = await this.safeSendDM(
            interaction.client as Client,
            interaction.user.id,
            `🎉 **Welcome to FatTips!**\n\n` +
              `You claimed an airdrop, so I created a secure Solana wallet for you.\n\n` +
              `**Private Key:** \`\`\`${newWallet.privateKeyBase58}\`\`\`\n` +
              `⚠️ **Save this key! This message self-destructs in 15m.**\n\n` +
              `Use \`/balance\` to check your funds.`,
            {
              onSuccess: (dmMsg) => {
                // Auto-delete sensitive DM after 15 minutes
                setTimeout(async () => {
                  try {
                    await dmMsg.edit(
                      '🔒 **Private Key removed for security.** Use `/wallet action:export-key` to view it again.'
                    );
                  } catch {}
                }, 900000);
              },
            }
          );

          if (dmSent) {
            await prisma.user.update({
              where: { discordId: interaction.user.id },
              data: { seedDelivered: true },
            });
          }
        } catch (walletError: any) {
          logger.error('Failed to create wallet for airdrop claim:', {
            userId: interaction.user.id,
            error: walletError.message,
          });
          await interaction.editReply({
            content: '❌ Failed to create wallet. Please try again.',
          });
          return;
        }
      }

      // 3. Now create participant record (user exists at this point)
      try {
        await prisma.airdropParticipant.create({
          data: {
            airdropId,
            userId: interaction.user.id,
            status: 'PENDING',
            shareAmount: 0, // Calculated at settlement
          },
        });
      } catch (error: any) {
        if (error.code === 'P2002') {
          // Unique constraint violation - user already claimed
          await interaction.editReply({ content: '❌ You already joined this airdrop!' });
          return;
        }
        throw error;
      }

      // 4. Update participant count and get updated airdrop
      const updatedAirdrop = await prisma.airdrop.update({
        where: { id: airdropId },
        data: { participantCount: { increment: 1 } },
        include: { participants: true, creator: true },
      });

      console.log(
        `[AIRDROP CLAIM] User ${interaction.user.tag} (${interaction.user.id}) joined airdrop ${airdropId}`
      );

      // Customize reply based on whether wallet was created and DM status
      let replyContent = '✅ You have successfully joined the airdrop! Good luck! 🍀';
      if (newWalletCreated) {
        const userRecord = await prisma.user.findUnique({
          where: { discordId: interaction.user.id },
        });
        if (!userRecord?.seedDelivered) {
          replyContent =
            '✅ Joined the airdrop! 🍀\n\n' +
            "⚠️ **Important:** I created a wallet for you but couldn't send your private key via DM.\n" +
            'Please enable DMs from server members, then use `/wallet action:export-key` to get your key.';
        }
      }

      await interaction.editReply({ content: replyContent });

      // Check if max participants reached
      if (
        updatedAirdrop.maxParticipants &&
        updatedAirdrop.participantCount >= updatedAirdrop.maxParticipants
      ) {
        // Trigger settlement immediately
        logger.info(`Airdrop ${airdropId} reached max participants. Settling...`);
        // Use setImmediate to not block the reply
        setImmediate(() => this.settleAirdrop(updatedAirdrop, interaction.client));
      }
    } catch (error) {
      logger.error('Error claiming airdrop:', error);
      Sentry.captureException(error, {
        tags: {
          airdropId,
          userId: interaction.user.id,
          action: 'claim',
        },
      });
      await interaction.editReply({ content: '❌ Failed to claim. Please try again.' });
    }
  }

  /**
   * Settle all expired airdrops
   */
  async settleExpiredAirdrops(client: any) {
    try {
      const expiredAirdrops = await prisma.airdrop.findMany({
        where: {
          status: 'ACTIVE',
          expiresAt: { lt: new Date() },
        },
        include: {
          participants: true,
          creator: true,
        },
      });

      for (const airdrop of expiredAirdrops) {
        await this.settleAirdrop(airdrop, client);
      }
    } catch (error) {
      logger.error('Error settling airdrops:', error);
      Sentry.captureException(error, {
        tags: {
          action: 'settleExpiredAirdrops',
        },
      });
    }
  }

  /**
   * Settle a single airdrop by ID
   */
  async settleAirdropById(airdropId: string, client: any) {
    const airdrop = await prisma.airdrop.findUnique({
      where: { id: airdropId },
      include: { participants: true, creator: true },
    });

    if (airdrop && airdrop.status === 'ACTIVE') {
      await this.settleAirdrop(airdrop, client);
    }
  }

  /**
   * Settle a single airdrop
   */
  private async settleAirdrop(airdrop: any, client: any) {
    // Double check status transactionally or optimistic
    // Just simple check here since node is single threaded usually
    if (airdrop.status !== 'ACTIVE') return;

    console.log(`Settling airdrop ${airdrop.id}...`);

    try {
      // 1. Mark as SETTLED (to prevent double processing)
      // We do this via updateMany to be atomic
      const { count } = await prisma.airdrop.updateMany({
        where: { id: airdrop.id, status: 'ACTIVE' },
        data: { status: 'SETTLED', settledAt: new Date() }, // Mark settled immediately
      });

      if (count === 0) return; // Already settled by another process

      const participants = airdrop.participants;
      const totalAmount = Number(airdrop.amountTotal);
      const winnerCount = participants.length;

      // 2. Distribute Funds
      const walletKeypair = await this.walletService.getKeypair(
        airdrop.encryptedPrivkey,
        airdrop.keySalt
      );
      const tokenMint = airdrop.tokenMint;
      const feePerTx = FEE_BUFFERS.BATCH; // Standard Solana fee per transaction
      const rentBuffer = MIN_RENT_EXEMPTION; // Safety margin for rent exemption

      let tokenSymbol = 'SOL';
      if (tokenMint === TOKEN_MINTS.USDC) tokenSymbol = 'USDC';
      if (tokenMint === TOKEN_MINTS.USDT) tokenSymbol = 'USDT';

      if (winnerCount === 0) {
        // No winners: Refund creator completely
        try {
          const balances = await this.balanceService.getBalances(
            walletKeypair.publicKey.toBase58()
          );
          const feeBuffer = MIN_RENT_EXEMPTION; // Ensure rent exemption

          // Refund Logic
          if (tokenMint === TOKEN_MINTS.SOL) {
            const amount = Math.max(0, balances.sol - feeBuffer);
            if (amount > 0) {
              const signature = await this.transactionService.transfer(
                walletKeypair,
                airdrop.creator.walletPubkey,
                amount,
                tokenMint
              );
              logTransaction('AIRDROP', {
                fromId: 'BOT',
                toId: airdrop.creatorId,
                amount,
                token: 'SOL',
                signature,
                status: 'SUCCESS',
              });
            }
          } else {
            // Refund Token
            const tokenBal = tokenMint === TOKEN_MINTS.USDC ? balances.usdc : balances.usdt;
            if (tokenBal > 0) {
              const signature = await this.transactionService.transfer(
                walletKeypair,
                airdrop.creator.walletPubkey,
                tokenBal,
                tokenMint
              );
              logTransaction('AIRDROP', {
                fromId: 'BOT',
                toId: airdrop.creatorId,
                amount: tokenBal,
                token: tokenSymbol,
                signature,
                status: 'SUCCESS',
              });
            }
            // Refund SOL dust (gas money)
            const solAmount = Math.max(0, balances.sol - feeBuffer);
            if (solAmount > 0) {
              const signature = await this.transactionService.transfer(
                walletKeypair,
                airdrop.creator.walletPubkey,
                solAmount,
                TOKEN_MINTS.SOL
              );
              logTransaction('AIRDROP', {
                fromId: 'BOT',
                toId: airdrop.creatorId,
                amount: solAmount,
                token: 'SOL',
                signature,
                status: 'SUCCESS',
              });
            }
          }

          await prisma.airdrop.update({
            where: { id: airdrop.id },
            data: { status: 'EXPIRED' },
          });

          // Update original message only
          await this.endAirdropMessage(client, airdrop, 0, 0, tokenSymbol);
          return;
        } catch (refundError) {
          console.error('Failed to refund creator:', refundError);
        }
      }

      // Calculate share
      // Logic: First-Come-First-Served if max winners set
      let winners = participants;
      if (airdrop.maxParticipants && winnerCount > airdrop.maxParticipants) {
        // Sort by claim time (FCFS)
        winners = participants
          .sort(
            (a: any, b: any) => new Date(a.claimedAt).getTime() - new Date(b.claimedAt).getTime()
          )
          .slice(0, airdrop.maxParticipants);
      }

      // --- DYNAMIC FEE ADJUSTMENT ---
      let distributableAmount = totalAmount;
      const totalEstimatedFees = winners.length * feePerTx;

      // Check actual wallet balance to be safe
      try {
        const balances = await this.balanceService.getBalances(walletKeypair.publicKey.toBase58());

        if (tokenMint === TOKEN_MINTS.SOL) {
          // For SOL: We must subtract fees + rent buffer from the total pot
          const maxAvailable = Math.max(0, balances.sol - totalEstimatedFees - rentBuffer);

          // Use the smaller of: What was promised (totalAmount) OR what's actually safe to send
          distributableAmount = Math.min(totalAmount, maxAvailable);

          if (distributableAmount < totalAmount) {
            console.warn(
              `[AIRDROP] Adjusting payout due to fees. Promised: ${totalAmount}, Available: ${maxAvailable}`
            );
          }
        } else {
          // For Tokens: We distribute the token amount, but we must check if we have SOL for gas
          if (balances.sol < totalEstimatedFees) {
            console.error(
              `[AIRDROP] CRITICAL: Not enough SOL for gas fees! Need ${totalEstimatedFees}, Have ${balances.sol}. Aborting settlement.`
            );
            // Abort settlement if we can't pay gas
            // We'll mark it as SETTLED but with 0 success to prevent infinite retries
            await prisma.airdrop.update({
              where: { id: airdrop.id },
              data: {
                status: 'SETTLED',
                amountClaimed: 0,
                settledAt: new Date(),
              },
            });

            // Notify about failure
            await this.endAirdropMessage(
              client,
              airdrop,
              0,
              0,
              tokenSymbol,
              [],
              'Settlement failed: Insufficient SOL for gas fees.'
            );
            return;
          }
          // For tokens, we usually distribute exactly what was promised or what's in the wallet
          const tokenBal = tokenMint === TOKEN_MINTS.USDC ? balances.usdc : balances.usdt;
          distributableAmount = Math.min(totalAmount, tokenBal);
        }
      } catch (err) {
        console.error('Failed to fetch realtime balance for settlement, using DB value', err);
      }

      // Safety check: If distributable amount is 0, abort
      if (distributableAmount <= 0) {
        console.warn(`[AIRDROP] No funds to distribute for ${airdrop.id}. Marking settled.`);
        await prisma.airdrop.update({
          where: { id: airdrop.id },
          data: {
            status: 'SETTLED',
            amountClaimed: 0,
            settledAt: new Date(),
          },
        });

        await this.endAirdropMessage(
          client,
          airdrop,
          0,
          0,
          tokenSymbol,
          [],
          'Settlement failed: Airdrop wallet is empty.'
        );
        return;
      }

      const share = distributableAmount / winners.length;

      // 2. Distribute Funds (walletKeypair already initialized above)
      let successCount = 0;

      for (const winner of winners) {
        try {
          // Get or Create Winner Wallet
          let user = await prisma.user.findUnique({ where: { discordId: winner.userId } });

          if (!user) {
            // Create wallet for winner
            const newWallet = await this.walletService.createEncryptedWallet();
            user = await prisma.user.create({
              data: {
                discordId: winner.userId,
                walletPubkey: newWallet.publicKey,
                encryptedPrivkey: newWallet.encryptedPrivateKey,
                keySalt: newWallet.keySalt,
                seedDelivered: false,
              },
            });

            // Try to DM private key using safe method
            const dmSent = await this.safeSendDM(
              client,
              winner.userId,
              `🎉 You won an airdrop! A wallet was created for you.\n` +
                `Private Key: \`\`\`${newWallet.privateKeyBase58}\`\`\`\n` +
                `⚠️ **Save this now! This message self-destructs in 15m.**`,
              {
                onSuccess: (dmMsg) => {
                  setTimeout(async () => {
                    try {
                      await dmMsg.edit(
                        '🔒 **Private Key removed for security.** Use `/wallet action:export-key` to view it again.'
                      );
                    } catch {}
                  }, 900000);
                },
              }
            );

            if (dmSent) {
              await prisma.user.update({
                where: { discordId: winner.userId },
                data: { seedDelivered: true },
              });
            }
          }

          // Transfer
          const signature = await this.transactionService.transfer(
            walletKeypair,
            user.walletPubkey,
            share,
            tokenMint
          );

          // Log transaction
          await prisma.transaction.create({
            data: {
              signature,
              fromId: null as any, // System wallet, no user
              toId: winner.userId,
              amountUsd: 0, // TODO: Fetch price
              amountToken: share,
              tokenMint,
              usdRate: 0,
              txType: 'AIRDROP_CLAIM',
              status: 'CONFIRMED',
            },
          });

          logTransaction('AIRDROP', {
            fromId: 'BOT',
            toId: winner.userId,
            amount: share,
            token: tokenSymbol,
            signature,
            status: 'SUCCESS',
          });

          // Update Participant
          await prisma.airdropParticipant.update({
            where: { id: winner.id },
            data: {
              status: 'TRANSFERRED',
              shareAmount: share,
              txSignature: signature,
            },
          });

          successCount++;
        } catch (txError) {
          logger.error(`Failed to pay winner ${winner.userId}:`, txError);
          Sentry.captureException(txError, {
            tags: {
              airdropId: airdrop.id,
              winnerId: winner.userId,
              action: 'payWinner',
            },
          });
        }
      }

      // 3. Update Status
      await prisma.airdrop.update({
        where: { id: airdrop.id },
        data: {
          status: 'SETTLED',
          amountClaimed: (share * successCount).toFixed(9), // Convert to string for Decimal safety
          settledAt: new Date(),
        },
      });

      // 4. Notify (Updating original message only, no new message)
      // this.notifyChannel(...) // Removed as per request

      // 5. Update Original Message
      await this.endAirdropMessage(client, airdrop, successCount, share, tokenSymbol, winners);
    } catch (error) {
      logger.error('Settlement critical error:', error);
      Sentry.captureException(error, {
        tags: {
          airdropId: airdrop.id,
          action: 'settleAirdrop',
        },
      });
    }
  }

  private async notifyChannel(client: Client, channelId: string, content: string) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send(content);
      }
    } catch {
      // Channel might be deleted or inaccessible
    }
  }

  private async endAirdropMessage(
    client: Client,
    airdrop: any,
    winnerCount: number,
    shareAmount: number,
    tokenSymbol: string,
    winners: any[] = [],
    errorMessage?: string
  ) {
    if (!airdrop.messageId || !airdrop.channelId) {
      // No message to update - notify creator via DM instead
      await this.notifyCreatorOfSettlement(
        client,
        airdrop,
        winnerCount,
        shareAmount,
        tokenSymbol,
        winners,
        errorMessage
      );
      return;
    }

    try {
      const channel = await client.channels.fetch(airdrop.channelId);
      if (!channel?.isTextBased()) {
        throw new Error('Channel not text-based');
      }

      const message = await (channel as TextChannel).messages.fetch(airdrop.messageId);
      if (!message) {
        throw new Error('Message not found');
      }

      const oldEmbed = message.embeds[0];
      if (!oldEmbed) {
        throw new Error('No embed found');
      }

      const isRefund = winnerCount === 0 && !errorMessage && winners.length === 0;
      const isFailure = !!errorMessage;

      let title = '✅ Airdrop Settled';
      if (isRefund) title = '🛑 Airdrop Expired';
      if (isFailure) title = '⚠️ Settlement Failed';

      let description = `**${winnerCount} winners** claimed this airdrop!\nEach received **${shareAmount.toFixed(4)} ${tokenSymbol}**.`;
      if (isRefund) {
        description = `This airdrop ended with no participants.\nFunds have been refunded to the creator.`;
      } else if (isFailure) {
        description = `**Settlement Failed**\n${errorMessage}\n\nPlease contact support if this persists.`;
      }

      let color = 0x000000; // Black for settled
      if (isRefund) color = 0xed4245; // Red for expired
      if (isFailure) color = 0xffaa00; // Orange for failure

      const newEmbed = new EmbedBuilder(oldEmbed.data)
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp(new Date());

      // Add winners list if applicable
      if (!isRefund && !isFailure && winners.length > 0) {
        let winnersText = winners.map((w) => `<@${w.userId}>`).join(', ');

        // Truncate if too long (Discord field limit is 1024)
        if (winnersText.length > 1000) {
          winnersText = winnersText.substring(0, 1000) + '... and more';
        }

        newEmbed.addFields({ name: '🏆 Winners', value: winnersText });
      }

      newEmbed.setFooter({ text: 'This event has ended.' });

      await message.edit({
        embeds: [newEmbed],
        components: [],
      });
    } catch (error: any) {
      // Check if this is an access error
      const isAccessError = [
        DISCORD_ERRORS.MISSING_ACCESS,
        DISCORD_ERRORS.UNKNOWN_CHANNEL,
        DISCORD_ERRORS.UNKNOWN_MESSAGE,
      ].includes(error.code);

      if (isAccessError) {
        // Bot can't access the channel/message - notify creator via DM instead
        logger.info(`Cannot update airdrop message (${error.code}), notifying creator via DM`);
        await this.notifyCreatorOfSettlement(
          client,
          airdrop,
          winnerCount,
          shareAmount,
          tokenSymbol,
          winners,
          errorMessage
        );
      } else {
        logger.warn(`Failed to update airdrop message ${airdrop.messageId}:`, {
          code: error.code,
          message: error.message,
        });
      }
    }
  }

  /**
   * Notify the airdrop creator about settlement when we can't update the original message
   */
  private async notifyCreatorOfSettlement(
    client: Client,
    airdrop: any,
    winnerCount: number,
    shareAmount: number,
    tokenSymbol: string,
    winners: any[] = [],
    errorMessage?: string
  ) {
    const isRefund = winnerCount === 0 && !errorMessage && winners.length === 0;
    const isFailure = !!errorMessage;

    let message: string;
    if (isRefund) {
      message =
        `🛑 **Airdrop Expired**\n\n` +
        `Your airdrop ended with no participants.\n` +
        `Funds have been refunded to your wallet.`;
    } else if (isFailure) {
      message =
        `⚠️ **Airdrop Settlement Failed**\n\n` +
        `Your airdrop could not be settled automatically.\n` +
        `**Reason:** ${errorMessage}\n\n` +
        `Please contact support.`;
    } else {
      const winnerMentions = winners
        .slice(0, 10)
        .map((w) => `<@${w.userId}>`)
        .join(', ');
      const moreText = winners.length > 10 ? ` and ${winners.length - 10} more` : '';

      message =
        `✅ **Airdrop Settled!**\n\n` +
        `**${winnerCount} winners** received **${shareAmount.toFixed(4)} ${tokenSymbol}** each.\n\n` +
        `**Winners:** ${winnerMentions}${moreText}\n\n` +
        `_Note: I couldn't update the original message in the server (bot may have been removed or channel deleted)._`;
    }

    await this.notifyCreator(client, airdrop.creatorId, message);
  }
}
