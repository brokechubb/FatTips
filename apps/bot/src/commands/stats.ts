import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  InteractionContextType,
} from 'discord.js';
import { prisma } from 'fattips-database';

export const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('View tipping stats for yourself or another user')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .addUserOption((option) =>
    option
      .setName('user')
      .setDescription('User to view stats for (default: yourself)')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser('user') || interaction.user;

  try {
    const user = await prisma.user.findUnique({
      where: { discordId: targetUser.id },
    });

    if (!user) {
      await interaction.editReply({
        content:
          targetUser.id === interaction.user.id
            ? "You don't have a wallet yet! Use `/wallet create` to get started."
            : `<@${targetUser.id}> doesn't have a wallet yet.`,
      });
      return;
    }

    const sentTips = await prisma.transaction.aggregate({
      where: {
        fromId: targetUser.id,
        txType: 'TIP',
        status: 'CONFIRMED',
      },
      _sum: { amountUsd: true },
      _count: { id: true },
    });

    const receivedTips = await prisma.transaction.aggregate({
      where: {
        toId: targetUser.id,
        txType: 'TIP',
        status: 'CONFIRMED',
      },
      _sum: { amountUsd: true },
      _count: { id: true },
    });

    const airdropsCreated = await prisma.airdrop.aggregate({
      where: {
        creatorId: targetUser.id,
        status: 'SETTLED',
      },
      _sum: { amountClaimed: true },
      _count: { id: true },
    });

    const airdropsWon = await prisma.airdropParticipant.count({
      where: {
        userId: targetUser.id,
      },
    });

    const sentTotal = sentTips._sum.amountUsd ? Number(sentTips._sum.amountUsd).toFixed(2) : '0.00';
    const receivedTotal = receivedTips._sum.amountUsd
      ? Number(receivedTips._sum.amountUsd).toFixed(2)
      : '0.00';
    const airdropTotal = airdropsCreated._sum.amountClaimed
      ? Number(airdropsCreated._sum.amountClaimed).toFixed(2)
      : '0.00';

    const isSelf = targetUser.id === interaction.user.id;
    const title = isSelf ? '📊 Your Stats' : `📊 ${targetUser.username}'s Stats`;

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

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching stats:', error);
    await interaction.editReply({
      content: 'Failed to fetch stats. Please try again later.',
    });
  }
}
