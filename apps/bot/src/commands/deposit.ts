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
      .setTitle('Your Deposit Address')
      .setImage('attachment://deposit-qr.png')
      .addFields({
        name: 'Address',
        value: `\`\`\`\n${user.walletPubkey}\n\`\`\``,
      })
      .setDescription('Scan with your wallet app or copy the address above to deposit.')
      .setColor(0x00aaff)
      .setTimestamp();

    await interaction.editReply({
      embeds: [embed],
      files: [attachment],
    });
  } catch (error) {
    console.error('Error fetching deposit address:', error);
    await interaction.editReply({
      content: 'Failed to fetch deposit address. Please try again later.',
    });
  }
}
