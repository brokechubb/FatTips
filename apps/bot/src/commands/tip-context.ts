import {
  ContextMenuCommandBuilder,
  UserContextMenuCommandInteraction,
  ApplicationCommandType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
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

  const modal = new ModalBuilder()
    .setCustomId(`tip_modal_${targetUser.id}`)
    .setTitle(`Tip ${targetUser.username}`);

  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('Amount')
    .setPlaceholder('Enter amount (e.g., $5, 0.5 SOL, 10 USDC)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const firstActionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput);
  modal.addComponents(firstActionRow);

  await interaction.showModal(modal);
}
