import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show available commands and how to use them')
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ]);

export async function execute(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('🤖 FatTips Help')
    .setDescription(
      'FatTips is a non-custodial Solana tipping bot. You own your keys, we just make it easy to tip!'
    )
    .setColor(0x00aaff)
    .addFields(
      {
        name: '💰 Balance & Wallet',
        value:
          '`/balance` - View your SOL/USDC/USDT balance and public address.\n' +
          "`/wallet action:create` - Create a new wallet (if you don't have one).\n" +
          '`/wallet action:export` - Reveal your seed phrase (DM only).\n' +
          '`/wallet action:clear-dms` - Delete bot messages from your DMs.',
      },
      {
        name: '💸 Tipping & Sending',
        value:
          '`/tip @user $5` - Tip $5 USD in SOL to a user.\n' +
          '`/tip @user 1 USDC` - Tip 1 USDC directly.\n' +
          '`/tip @user all` - Tip your entire balance.\n' +
          '*If the user has no wallet, one is created automatically!*',
      },
      {
        name: '📤 Withdrawals',
        value:
          '`/send <address> $10` - Send funds to an external Solana wallet.\n' +
          '`/send <address> all` - Drain your wallet completely (empties balance).\n' +
          '*Alias:* `/withdraw` works the same as `/send`.',
      },
      {
        name: '🪂 Airdrops',
        value:
          '`/airdrop amount:$10 duration:1h` - Create a pot for others to claim.\n' +
          '`/airdrop amount:1 SOL duration:30m max-winners:5` - Limited winners drop.\n' +
          '*Funds are distributed when time expires or max winners reached.*',
      },
      {
        name: '📜 History',
        value: '`/history` - View your last 5 transactions.',
      }
    )
    .setFooter({ text: 'Not your keys, not your coins (but here, they ARE your keys!)' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
