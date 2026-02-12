import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  InteractionContextType,
} from 'discord.js';
import { prisma } from 'fattips-database';

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

    await interaction.editReply({
      content: `**Your Deposit Address:**\n\`\`\`\n${user.walletPubkey}\n\`\`\`\n<https://solscan.io/account/${user.walletPubkey}>\n\nSend SOL, USDC, or USDT to this address to fund your wallet.`,
    });
  } catch (error) {
    console.error('Error fetching deposit address:', error);
    await interaction.editReply({
      content: 'Failed to fetch deposit address. Please try again later.',
    });
  }
}
