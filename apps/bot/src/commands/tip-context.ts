import {
  ContextMenuCommandBuilder,
  UserContextMenuCommandInteraction,
  ApplicationCommandType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';

export const data = new ContextMenuCommandBuilder()
  .setName('Tip User')
  .setType(ApplicationCommandType.User);

export async function execute(interaction: UserContextMenuCommandInteraction) {
  const targetUser = interaction.targetUser;

  if (targetUser.id === interaction.user.id) {
    await interaction.reply({
      content: '❌ You cannot tip yourself!',
      ephemeral: true,
    });
    return;
  }

  if (targetUser.bot) {
    await interaction.reply({
      content: '❌ You cannot tip bots!',
      ephemeral: true,
    });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tip_token_${targetUser.id}`)
    .setPlaceholder('Select a token to tip')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('SOL')
        .setDescription('Solana native token')
        .setValue('SOL')
        .setEmoji('💎'),
      new StringSelectMenuOptionBuilder()
        .setLabel('USDC')
        .setDescription('USD Coin')
        .setValue('USDC')
        .setEmoji('💵'),
      new StringSelectMenuOptionBuilder()
        .setLabel('USDT')
        .setDescription('Tether USD')
        .setValue('USDT')
        .setEmoji('💸')
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  await interaction.reply({
    content: `💸 How would you like to tip ${targetUser}?`,
    components: [row],
    ephemeral: true,
  });
}
