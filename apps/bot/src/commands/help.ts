import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} from 'discord.js';
import { getGuildPrefix } from '../handlers/prefixCommands';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show available commands and how to use them')
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ]);

export async function execute(interaction: ChatInputCommandInteraction) {
  // Check if this is a guild or DM context
  const isGuild = !!interaction.guild;
  const prefix = await getGuildPrefix(interaction.guildId);

  const embed = new EmbedBuilder()
    .setTitle('🤖 FatTips Help')
    .setDescription(
      'FatTips is a non-custodial Solana tipping bot. NO transaction fees. You own your keys. The way it should be!\n\n' +
        (isGuild
          ? `**Prefix Commands:** Use \`${prefix}\` prefix (recommended for guilds)\n` +
            `**Slash Commands:** Also available with \`/\` prefix\n\n` +
            `💡 **Pro Tip:** Reply to any message with \`${prefix}tip $5\` to tip the author!`
          : '**Commands:** Use `/` slash commands or direct messages without prefix')
    )
    .setColor(0x00aaff);

  if (isGuild) {
    // Guild install - show prefix commands as primary
    embed.addFields(
      {
        name: '💰 Balance & Wallet',
        value:
          `\`${prefix}balance\` - View your SOL/USDC/USDT balance and public address.\n` +
          `\`${prefix}deposit\` - Show your wallet address for deposits.\n` +
          `\`${prefix}wallet create\` - Create a new wallet (if you don't have one).\n` +
          `\`${prefix}wallet export-key\` - Reveal your private key (DM only).\n` +
          `*Slash:* \`/balance\`, \`/deposit\`, \`/wallet action:create\`, \`/wallet action:export-key\``,
      },
      {
        name: '💸 Tipping & Sending',
        value:
          `\`${prefix}tip @user $5\` - Tip $5 USD in SOL to a user.\n` +
          `\`${prefix}tip @user 1 USDC\` - Tip 1 USDC directly.\n` +
          `\`${prefix}tip @user all\` - Tip your entire balance.\n` +
          `\`${prefix}tip $5\` (as reply) - Tip message author.\n` +
          '*If the user has no wallet, one is created automatically!*',
      },
      {
        name: '📤 Withdrawals & Swaps',
        value:
          `\`${prefix}send <address> $10\` - Send funds to an external Solana wallet.\n` +
          `\`${prefix}withdraw <address> all\` - Withdraw your entire balance (minus reserve).\n` +
          `\`${prefix}swap 1 SOL USDC\` - Swap tokens instantly (supports gasless!).\n` +
          `*Slash:* \`/send\`, \`/withdraw\`, \`/swap\`\n` +
          'ℹ️ *Note: A minimum reserve of ~0.0009 SOL is kept to keep your wallet active.*',
      },
      {
        name: '🎁 Community',
        value:
          `\`${prefix}rain $10 5\` - Rain on 5 random active users.\n` +
          `\`${prefix}airdrop $20 10s\` - Create a 10-second airdrop pot.\n` +
          `*Slash:* \`/airdrop amount:$20 duration:10s max-winners:5\`\n` +
          'ℹ️ *On-chain network fees are automatically deducted from the total pot.*',
      },
      {
        name: '📜 History & Settings',
        value:
          `\`${prefix}history\` - View your last 5 transactions.\n` +
          `\`${prefix}setprefix <new>\` - Change server prefix (Admin only).\n` +
          `*Slash:* \`/history\``,
      },
      {
        name: '🆘 Support',
        value: 'Need help? Join **CTRL-ALT-DEGEN** on Discord: https://discord.gg/9wArQgz6cB',
      }
    );
  } else {
    // DM or private channel - show slash commands
    embed.addFields(
      {
        name: '💰 Balance & Wallet',
        value:
          '`/balance` - View your SOL/USDC/USDT balance and public address.\n' +
          '`/deposit` - Show your wallet address for deposits.\n' +
          "`/wallet action:create` - Create a new wallet (if you don't have one).\n" +
          '`/wallet action:export-key` - Reveal your private key (DM only).\n' +
          '`/wallet action:clear-dms` - Delete bot messages from your DMs.',
      },
      {
        name: '💸 Tipping & Sending',
        value:
          '`/tip user:@user amount:$5` - Tip $5 USD in SOL to a user.\n' +
          '`/tip user:@user amount:1 token:USDC` - Tip 1 USDC directly.\n' +
          '`/tip user:@user amount:all` - Tip your entire balance.\n' +
          '*If the user has no wallet, one is created automatically!*',
      },
      {
        name: '📤 Withdrawals & Swaps',
        value:
          '`/send address:<address> amount:$10` - Send funds to an external Solana wallet.\n' +
          '`/withdraw address:<address> amount:all` - Withdraw your entire balance.\n' +
          '`/swap amount:1 from:SOL to:USDC` - Swap tokens instantly.\n' +
          'ℹ️ *Note: A minimum reserve of ~0.0009 SOL is kept to keep your wallet active.*',
      },
      {
        name: '📜 History',
        value: '`/history` - View your last 5 transactions.',
      },
      {
        name: '🆘 Support',
        value: 'Need help? Join **CTRL-ALT-DEGEN** on Discord: https://discord.gg/9wArQgz6cB',
      }
    );
  }

  embed.setFooter({
    text: 'Not your keys, not your coins (but here, they ARE your keys!) • Support: discord.gg/9wArQgz6cB',
  });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
