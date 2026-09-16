import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
} from 'discord.js';
import { getGateSettings, setGateRole, Feature } from '../services/guild-gate';

export const data = new SlashCommandBuilder()
  .setName('config')
  .setDescription('Configure FatTips per-server settings (admins only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
  .setContexts([InteractionContextType.Guild])
  .addSubcommand((sub) =>
    sub
      .setName('role')
      .setDescription('Set or clear the role required to create/receive a feature')
      .addStringOption((opt) =>
        opt
          .setName('feature')
          .setDescription('Which feature to gate')
          .setRequired(true)
          .addChoices(
            { name: 'Airdrop', value: 'airdrop' },
            { name: 'Rain', value: 'rain' }
          )
      )
      .addRoleOption((opt) =>
        opt
          .setName('role')
          .setDescription('Role to require (omit to clear / disable gating)')
          .setRequired(false)
      )
  )
  .addSubcommand((sub) => sub.setName('view').setDescription('Show current FatTips settings'));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
    return;
  }

  // Belt-and-suspenders permission check (command is already admin-gated)
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: '❌ Only administrators can configure FatTips.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'view') {
    await showSettings(interaction);
    return;
  }

  if (sub === 'role') {
    await setRole(interaction);
    return;
  }
}

async function setRole(interaction: ChatInputCommandInteraction) {
  const feature = interaction.options.getString('feature', true) as Feature;
  const role = interaction.options.getRole('role');

  // @everyone cannot be used as a gate (it would gate nobody)
  if (role && role.id === interaction.guild!.id) {
    await interaction.reply({
      content: '❌ Cannot use @everyone as a gating role.',
      ephemeral: true,
    });
    return;
  }

  await setGateRole(interaction.guildId!, feature, role ? role.id : null);

  if (role) {
    await interaction.reply({
      content:
        `✅ **${feature.charAt(0).toUpperCase() + feature.slice(1)} gating enabled.**\n` +
        `Only members with ${role} (and server admins) can create or receive ${feature}s in this server.`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: `✅ **${feature.charAt(0).toUpperCase() + feature.slice(1)} gating cleared.** Anyone in this server can now create or receive ${feature}s.`,
      ephemeral: true,
    });
  }
}

async function showSettings(interaction: ChatInputCommandInteraction) {
  const settings = await getGateSettings(interaction.guildId!);

  const fmt = (id: string | null) => (id ? `<@&${id}>` : '*Anyone (unrestricted)*');

  const embed = new EmbedBuilder()
    .setTitle('⚙️ FatTips Server Settings')
    .setColor(0x5865f2)
    .addFields(
      { name: '🎁 Airdrop Role', value: fmt(settings.airdropRoleId), inline: true },
      { name: '🌧️ Rain Role', value: fmt(settings.rainRoleId), inline: true }
    )
    .setFooter({ text: 'Use /config role to change these settings.' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}