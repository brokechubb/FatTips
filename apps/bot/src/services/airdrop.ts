import { ButtonInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from 'fattips-database';
import { logTransaction } from '../utils/logger';
import { TransactionService, WalletService, BalanceService, TOKEN_MINTS } from 'fattips-solana';

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

      // 2. Check if user already claimed
      const existing = await prisma.airdropParticipant.findUnique({
        where: {
          airdropId_userId: {
            airdropId,
            userId: interaction.user.id,
          },
        },
      });

      if (existing) {
        await interaction.editReply({ content: '❌ You already joined this airdrop!' });
        return;
      }

      // 3. Register Participant
      // We don't verify wallet existence here to reduce friction.
      // We'll create it during settlement if needed.
      await prisma.airdropParticipant.create({
        data: {
          airdropId,
          userId: interaction.user.id,
          status: 'PENDING',
          shareAmount: 0, // Calculated at settlement
        },
      });

      // Update participant count and get updated airdrop
      const updatedAirdrop = await prisma.airdrop.update({
        where: { id: airdropId },
        data: { participantCount: { increment: 1 } },
        include: { participants: true, creator: true },
      });

      await interaction.editReply({
        content: '✅ You have successfully joined the airdrop! Good luck! 🍀',
      });

      // Check if max participants reached
      if (
        updatedAirdrop.maxParticipants &&
        updatedAirdrop.participantCount >= updatedAirdrop.maxParticipants
      ) {
        // Trigger settlement immediately
        console.log(`Airdrop ${airdropId} reached max participants. Settling...`);
        // Use setImmediate to not block the reply
        setImmediate(() => this.settleAirdrop(updatedAirdrop, interaction.client));
      }
    } catch (error) {
      console.error('Error claiming airdrop:', error);
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
      console.error('Error settling airdrops:', error);
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
      const walletKeypair = this.walletService.getKeypair(
        airdrop.encryptedPrivkey,
        airdrop.keySalt
      );
      const tokenMint = airdrop.tokenMint;

      let tokenSymbol = 'SOL';
      if (tokenMint === TOKEN_MINTS.USDC) tokenSymbol = 'USDC';
      if (tokenMint === TOKEN_MINTS.USDT) tokenSymbol = 'USDT';

      if (winnerCount === 0) {
        // No winners: Refund creator completely
        try {
          const balances = await this.balanceService.getBalances(
            walletKeypair.publicKey.toBase58()
          );
          const feeBuffer = 0.00001;

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

          this.notifyChannel(
            client,
            airdrop.channelId,
            `🛑 Airdrop ended with no participants. Funds refunded to creator.`
          );
          return;
        } catch (refundError) {
          console.error('Failed to refund creator:', refundError);
        }
      }

      // Calculate share
      // Simple logic: Equal split
      // TODO: Handle maxWinners limit (Raffle)
      // If maxWinners set and count > max, pick random winners.

      let winners = participants;
      if (airdrop.maxParticipants && winnerCount > airdrop.maxParticipants) {
        // Shuffle and pick N
        const shuffled = participants.sort(() => 0.5 - Math.random());
        winners = shuffled.slice(0, airdrop.maxParticipants);
        // Mark losers?
      }

      const share = totalAmount / winners.length;

      // 2. Distribute Funds (walletKeypair already initialized above)
      let successCount = 0;

      for (const winner of winners) {
        try {
          // Get or Create Winner Wallet
          let user = await prisma.user.findUnique({ where: { discordId: winner.userId } });

          if (!user) {
            // Create wallet for winner
            const newWallet = this.walletService.createEncryptedWallet();
            user = await prisma.user.create({
              data: {
                discordId: winner.userId,
                walletPubkey: newWallet.publicKey,
                encryptedPrivkey: newWallet.encryptedPrivateKey,
                keySalt: newWallet.keySalt,
                encryptedMnemonic: newWallet.encryptedMnemonic,
                mnemonicSalt: newWallet.mnemonicSalt,
                seedDelivered: false,
              },
            });

            // Try to DM seed phrase (fire and forget)
            try {
              const u = await client.users.fetch(winner.userId);
              u.send(
                `🎉 You won an airdrop! A wallet was created for you. Seed: ||${newWallet.mnemonic}|| (Delete after saving!)`
              ).catch(() => {});
            } catch {}
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
              fromId: 'AIRDROP_BOT', // Special ID
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
          console.error(`Failed to pay winner ${winner.userId}:`, txError);
        }
      }

      // 3. Update Status
      await prisma.airdrop.update({
        where: { id: airdrop.id },
        data: {
          status: 'SETTLED',
          amountClaimed: share * successCount,
          settledAt: new Date(),
        },
      });

      // 4. Notify
      this.notifyChannel(
        client,
        airdrop.channelId,
        `🎉 **Airdrop Settled!**\n` +
          `**${successCount} winners** received **${share.toFixed(4)} ${tokenSymbol}** each.`
      );
    } catch (error) {
      console.error('Settlement critical error:', error);
    }
  }

  private async notifyChannel(client: any, channelId: string, content: string) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await channel.send(content);
      }
    } catch {
      // Channel might be deleted
    }
  }
}
