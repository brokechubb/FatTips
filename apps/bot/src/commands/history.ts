import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  InteractionContextType,
} from 'discord.js';
import { prisma } from 'fattips-database';

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription('View your transaction history')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
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

      // Determine token symbol
      let symbol = 'SOL';
      if (tx.tokenMint?.startsWith('EPj')) symbol = 'USDC';
      else if (tx.tokenMint?.startsWith('Es9')) symbol = 'USDT';

      const date = tx.createdAt.toLocaleDateString();
      const time = tx.createdAt.toLocaleTimeString();

      // Get USD value (handle null/undefined)
      const usdValue = tx.amountUsd ? Number(tx.amountUsd).toFixed(2) : null;
      const usdDisplay = usdValue && usdValue !== '0.00' ? `($${usdValue})` : '';

      // Determine action and counterparty
      let action = '';
      let counterparty = '';

      if (tx.txType === 'TIP') {
        if (isSender) {
          action = 'Sent tip';
          counterparty = tx.toId ? `to <@${tx.toId}>` : 'to external';
        } else {
          action = 'Received tip';
          counterparty = tx.fromId ? `from <@${tx.fromId}>` : 'from external';
        }
      } else if (tx.txType === 'WITHDRAWAL') {
        action = 'Withdrew';
        const toAddr = (tx as any).toAddress || tx.toId;
        counterparty = toAddr
          ? `to \`${toAddr.slice(0, 6)}...${toAddr.slice(-4)}\``
          : 'to external';
      } else if (tx.txType === 'DEPOSIT') {
        action = 'Deposited';
        counterparty = tx.fromId && tx.fromId !== 'SYSTEM' ? `from <@${tx.fromId}>` : '';
      } else if (tx.txType === 'AIRDROP_CLAIM') {
        action = isSender ? 'Airdrop payout' : 'Airdrop win';
        counterparty = '';
      }

      // Build the transaction line
      const txLine = `${typeEmoji} **${action}** ${counterparty}`.trim();
      const amountLine = `${amount} ${symbol} ${usdDisplay}`.trim();
      const linkLine = tx.signature
        ? `[View on Solscan](https://solscan.io/tx/${tx.signature})`
        : '';
      const timeLine = `${date} at ${time}`;

      description += `${txLine}\n> ${amountLine}\n> ${linkLine} • ${timeLine}\n\n`;
    }

    embed.setDescription(description || 'No transactions to display.');

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching history:', error);
    await interaction.editReply({
      content: 'Failed to fetch history. Please try again later.',
    });
  }
}
