import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  InteractionContextType,
} from 'discord.js';
import { prisma } from 'fattips-database';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('View server leaderboards for airdrops and rain')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([InteractionContextType.Guild])
  .addStringOption((option) =>
    option
      .setName('type')
      .setDescription('Which leaderboard to view')
      .setRequired(false)
      .addChoices(
        { name: 'Top Airdrop Creators', value: 'airdrops' },
        { name: 'Top Rain Senders', value: 'rain' },
        { name: 'Server Stats', value: 'guild' }
      )
  )
  .addIntegerOption((option) =>
    option
      .setName('limit')
      .setDescription('Number of users to show (default: 10, max: 20)')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const type = interaction.options.getString('type') || 'airdrops';
  const limit = Math.min(interaction.options.getInteger('limit') || 10, 20);
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.editReply({ content: 'Leaderboards are only available in servers.' });
    return;
  }

  try {
    switch (type) {
      case 'airdrops':
        await showTopAirdropCreators(interaction, guildId, limit);
        break;
      case 'rain':
        await showTopRainSenders(interaction, guildId, limit);
        break;
      case 'guild':
        await showGuildStats(interaction, guildId);
        break;
      default:
        await showTopAirdropCreators(interaction, guildId, limit);
    }
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    await interaction.editReply({
      content: 'Failed to fetch leaderboard. Please try again later.',
    });
  }
}

async function showTopAirdropCreators(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  limit: number
) {
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
    await interaction.editReply({ content: 'No settled airdrops in this server yet.' });
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

  await interaction.editReply({ embeds: [embed] });
}

async function showTopRainSenders(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  limit: number
) {
  const topRainSenders = await prisma.transaction.groupBy({
    by: ['fromId'],
    _sum: {
      amountUsd: true,
    },
    _count: {
      id: true,
    },
    orderBy: {
      _sum: {
        amountUsd: 'desc',
      },
    },
    take: limit,
    where: {
      txType: 'TIP',
      status: 'CONFIRMED',
      guildId: guildId,
      fromId: { not: null },
    },
  });

  if (topRainSenders.length === 0) {
    await interaction.editReply({ content: 'No tips sent in this server yet.' });
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

  await interaction.editReply({ embeds: [embed] });
}

async function showGuildStats(interaction: ChatInputCommandInteraction, guildId: string) {
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
    .setTitle(`📊 ${interaction.guild?.name || 'Server'} Stats`)
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

  await interaction.editReply({ embeds: [embed] });
}
