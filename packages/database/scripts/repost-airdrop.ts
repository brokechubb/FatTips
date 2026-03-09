import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const AIRDROP_ID = '8dc5016c-6c66-4f70-86e6-b19ae50f97b8';

async function main() {
  console.log(`🚀 Recovering airdrop ${AIRDROP_ID}...`);

  const airdrop = await prisma.airdrop.findUnique({
    where: { id: AIRDROP_ID },
    include: { creator: true }
  });

  if (!airdrop) {
    console.error('❌ Airdrop not found in DB.');
    process.exit(1);
  }

  if (airdrop.status !== 'ACTIVE') {
    console.error(`❌ Airdrop is in status ${airdrop.status}, not ACTIVE.`);
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user?.tag}`);

    try {
      const channel = await client.channels.fetch(airdrop.channelId) as TextChannel;
      if (!channel) throw new Error('Channel not found');

      const amountToken = Number(airdrop.amountTotal);
      const tokenSymbol = airdrop.tokenMint.includes('EPjFW') ? 'USDC' : (airdrop.tokenMint.includes('Es9vM') ? 'USDT' : 'SOL');
      
      // Estimate USD (rough estimate for recovery message)
      const usdValue = 0; // We don't need exact USD for the repost

      const endTimestamp = Math.floor(airdrop.expiresAt.getTime() / 1000);
      const embed = new EmbedBuilder()
        .setTitle('🎉 Solana Airdrop!')
        .setDescription(
          `**<@${airdrop.creatorId}>** dropped a pot of **${amountToken.toFixed(2)} ${tokenSymbol}**!

` +
            `Click **Claim** to enter.
` +
            `⏳ Ends: <t:${endTimestamp}:R>`
        )
        .setColor(0x00ff00)
        .addFields(
          { name: 'Pot Size', value: `${amountToken.toFixed(2)} ${tokenSymbol}`, inline: true },
          { name: 'Max Winners', value: airdrop.maxParticipants ? `${airdrop.maxParticipants}` : 'Unlimited', inline: true }
        )
        .setFooter({ text: 'Funds are held securely in a temporary wallet. (Recovered)' });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`claim_airdrop_${airdrop.id}`)
          .setLabel('💰 Claim')
          .setStyle(ButtonStyle.Success)
      );

      const message = await channel.send({ 
        content: `⚠️ **Airdrop Restored:** Due to a network glitch, this airdrop was delayed. It is now active!`,
        embeds: [embed], 
        components: [row] 
      });

      console.log(`✅ Message sent! ID: ${message.id}`);

      await prisma.airdrop.update({
        where: { id: airdrop.id },
        data: { messageId: message.id }
      });

      console.log('✅ DB Updated with messageId.');
      process.exit(0);
    } catch (error) {
      console.error('❌ Failed to repost:', error);
      process.exit(1);
    }
  });

  client.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch(console.error);
