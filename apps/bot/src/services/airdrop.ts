import { ButtonInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from 'fattips-database';
import { TransactionService, WalletService, TOKEN_MINTS } from 'fattips-solana';

const transactionService = new TransactionService(process.env.SOLANA_RPC_URL!);
const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);

export class AirdropService {
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

      // Update participant count
      await prisma.airdrop.update({
        where: { id: airdropId },
        data: { participantCount: { increment: 1 } },
      });

      await interaction.editReply({
        content: '✅ You have successfully joined the airdrop! Good luck! 🍀',
      });
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
   * Settle a single airdrop
   */
  private async settleAirdrop(airdrop: any, client: any) {
    console.log(`Settling airdrop ${airdrop.id}...`);

    try {
      // 1. Mark as SETTLED (to prevent double processing)
      // Actually, keep as PROCESSING or immediately settled?
      // Let's mark settled first to be safe, or use a status like SETTLING.
      // For now, we'll assume the script runs serially.

      const participants = airdrop.participants;
      const totalAmount = Number(airdrop.amountTotal);
      const winnerCount = participants.length;

      if (winnerCount === 0) {
        // No winners: Refund creator or forfeit to treasury
        // For simplicity: Forfeit to treasury (bot keeps it) or just leave in wallet for now.
        // We'll mark as EXPIRED.
        await prisma.airdrop.update({
          where: { id: airdrop.id },
          data: { status: 'EXPIRED' },
        });

        // Notify channel
        this.notifyChannel(client, airdrop.channelId, `🛑 Airdrop ended with no participants.`);
        return;
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

      // 2. Distribute Funds
      const walletKeypair = walletService.getKeypair(airdrop.encryptedPrivkey, airdrop.keySalt);
      const tokenMint = airdrop.tokenMint;

      let successCount = 0;

      for (const winner of winners) {
        try {
          // Get or Create Winner Wallet
          let user = await prisma.user.findUnique({ where: { discordId: winner.userId } });

          if (!user) {
            // Create wallet for winner
            const newWallet = walletService.createEncryptedWallet();
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
          const signature = await transactionService.transfer(
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
      let tokenSymbol = 'SOL'; // Lookup based on mint
      if (tokenMint === TOKEN_MINTS.USDC) tokenSymbol = 'USDC';
      if (tokenMint === TOKEN_MINTS.USDT) tokenSymbol = 'USDT';

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
