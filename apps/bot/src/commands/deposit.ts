import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  InteractionContextType,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { generateDepositQR } from '../utils/qr';

export const data = new SlashCommandBuilder()
  .setName('deposit')
  .setDescription('Get your wallet address for deposits')
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ]);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content: "You don't have a wallet yet. Use `/wallet action:create` to create one!",
      });
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

    await interaction.editReply({
      embeds: [embed],
      files: [attachment],
    });

    try {
      await interaction.user.send(
        `Your FatTips Solana deposit address:\n\`\`\`\n${user.walletPubkey}\n\`\`\`\nKeep this message for easy copying. Only send SOL, USDC, or USDT on the Solana network to this address.`
      );
    } catch {
      // DMs disabled — user already has the ephemeral response
    }
  } catch (error) {
    console.error('Error fetching deposit address:', error);
    await interaction.editReply({
      content: 'Failed to fetch deposit address. Please try again later.',
    });
  }
}
