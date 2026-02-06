import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { BalanceService, PriceService, TOKEN_MINTS } from 'fattips-solana';

const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);
const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);

export const data = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('Check your wallet balance and address')
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ]);

export async function execute(interaction: ChatInputCommandInteraction) {
  // Defer immediately
  const deferPromise = interaction.deferReply({ ephemeral: true });

  try {
    await deferPromise;

    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content: "You don't have a wallet yet. Use `/wallet action:create` to create one!",
      });
      return;
    }

    // Fetch balances from Solana with timeout
    let balances = { sol: 0, usdc: 0, usdt: 0 };
    try {
      const balancePromise = balanceService.getBalances(user.walletPubkey);
      const timeoutPromise = new Promise<typeof balances>((_, reject) =>
        setTimeout(() => reject(new Error('Balance fetch timeout')), 10000)
      );
      balances = await Promise.race([balancePromise, timeoutPromise]);
    } catch (error) {
      console.error('Error fetching balances from Solana:', error);
      // Continue with zero balances
    }

    // Fetch SOL price for USD calculation
    let solUsdValue = 0;
    let showUsdValues = false;
    try {
      const solPrice = await priceService.getTokenPrice(TOKEN_MINTS.SOL);
      if (solPrice) {
        solUsdValue = balances.sol * solPrice.price;
        showUsdValues = true;
      }
    } catch {
      console.log('Price API unavailable, showing balances without USD values');
    }

    // Format balances
    const solFormatted = BalanceService.formatBalance(balances.sol);
    const usdcFormatted = BalanceService.formatBalance(balances.usdc);
    const usdtFormatted = BalanceService.formatBalance(balances.usdt);

    // Calculate total USD value
    const totalUsd = solUsdValue + balances.usdc + balances.usdt;

    // Build description
    let description = `**Public Address:**\n\`\`\`\n${user.walletPubkey}\n\`\`\``;
    if (showUsdValues) {
      description += `\n\n**Total Value:** $${totalUsd.toFixed(2)} USD`;
    }

    const embed = new EmbedBuilder()
      .setTitle('💰 Your Wallet Balance')
      .setDescription(description)
      .setColor(0x00aaff)
      .addFields(
        {
          name: '☀️ SOL',
          value: showUsdValues ? `${solFormatted} ($${solUsdValue.toFixed(2)})` : solFormatted,
          inline: true,
        },
        { name: '💵 USDC', value: usdcFormatted, inline: true },
        { name: '💶 USDT', value: usdtFormatted, inline: true }
      )
      .setTimestamp();

    // Add tips
    const hasBalance = balances.sol > 0 || balances.usdc > 0 || balances.usdt > 0;
    if (hasBalance) {
      embed.addFields({
        name: '💡 Tip',
        value: 'Send `/tip @user $5` to tip someone!',
        inline: false,
      });
    } else {
      embed.addFields({
        name: '💡 Getting Started',
        value: 'Send SOL, USDC, or USDT to your address above to fund your wallet.',
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching balance:', error);
    try {
      await interaction.editReply({
        content: 'Failed to fetch balance. Please try again later.',
      });
    } catch {
      // Ignore reply errors
    }
  }
}
