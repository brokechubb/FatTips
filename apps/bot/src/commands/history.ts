import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { prisma } from 'fattips-database';

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription('View your transaction history')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .addIntegerOption((option) =>
    option.setName('limit').setDescription('Number of transactions to show (default: 5, max: 10)')
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const limit = Math.min(interaction.options.getInteger('limit') || 5, 10);

  try {
    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content: "You don't have a wallet yet! Use `/wallet create` to get started.",
      });
      return;
    }

    // Fetch last N transactions where user is sender OR recipient
    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [{ fromId: user.discordId }, { toId: user.discordId }],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        from: true,
        to: true,
      },
    });

    if (transactions.length === 0) {
      await interaction.editReply({
        content: 'No transactions found.',
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📜 Transaction History')
      .setColor(0x00aaff)
      .setTimestamp();

    let description = '';

    for (const tx of transactions) {
      const isSender = tx.fromId === user.discordId;
      const typeEmoji = isSender ? '📤' : '📥';
      const amount = Number(tx.amountToken).toFixed(4);
      // Determine token symbol roughly from mint (simplified)
      let symbol = 'SOL';
      if (tx.tokenMint.startsWith('EPj')) symbol = 'USDC';
      if (tx.tokenMint.startsWith('Es9')) symbol = 'USDT';

      const date = tx.createdAt.toLocaleDateString();
      const time = tx.createdAt.toLocaleTimeString();

      let action = '';
      if (tx.txType === 'TIP') {
        action = isSender ? `Sent tip to <@${tx.toId}>` : `Received tip from <@${tx.fromId}>`;
      } else if (tx.txType === 'WITHDRAWAL') {
        const toAddr = (tx as any).toAddress;
        action = `Withdrawal to \`${toAddr?.slice(0, 4)}...${toAddr?.slice(-4)}\``;
      } else if (tx.txType === 'DEPOSIT') {
        action = 'Deposit';
      }

      description +=
        `${typeEmoji} **${action}**\n` +
        `> **${amount} ${symbol}** (~$${Number(tx.amountUsd).toFixed(2)})\n` +
        `> [Solscan](https://solscan.io/tx/${tx.signature}) • ${date} ${time}\n\n`;
    }

    embed.setDescription(description);

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching history:', error);
    await interaction.editReply({
      content: 'Failed to fetch history. Please try again later.',
    });
  }
}
