import {
  Client,
  TextChannel,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import IORedis from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');

const EVENTS = {
  AIRDROP_CREATED: 'airdrop:created',
} as const;

interface AirdropCreatedEvent {
  airdropId: string;
  channelId: string;
  creatorId: string;
  creatorUsername: string;
  potSize: number;
  token: string;
  totalUsd: number;
  expiresAt: string;
  maxWinners: number | null;
}

export class AirdropEventHandler {
  private client: Client;
  private subscriber: IORedis;
  private isListening = false;

  constructor(client: Client) {
    this.client = client;
    this.subscriber = new IORedis({
      host: redisHost,
      port: redisPort,
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
    });

    this.subscriber.on('ready', () => {
      console.log('Airdrop event handler ready');
      this.subscribe();
    });

    this.subscriber.on('error', (err: Error) => {
      console.error('Redis subscriber error:', err.message);
    });
  }

  private async subscribe(): Promise<void> {
    if (this.isListening) return;

    await this.subscriber.subscribe(EVENTS.AIRDROP_CREATED);
    this.isListening = true;

    this.subscriber.on('message', async (channel: string, message: string) => {
      if (channel === EVENTS.AIRDROP_CREATED) {
        try {
          const data: AirdropCreatedEvent = JSON.parse(message);
          await this.handleAirdropCreated(data);
        } catch (error) {
          console.error('Error handling airdrop created event:', error);
        }
      }
    });
  }

  private async handleAirdropCreated(event: AirdropCreatedEvent): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(event.channelId);
      if (!channel || !channel.isTextBased()) {
        console.error('Channel not found or not text-based:', event.channelId);
        return;
      }

      const textChannel = channel as TextChannel;
      const endTimestamp = Math.floor(new Date(event.expiresAt).getTime() / 1000);

      const embed = new EmbedBuilder()
        .setTitle('🎉 Solana Airdrop!')
        .setDescription(
          `**A pot of ${event.potSize.toFixed(2)} ${event.token}** (~$${event.totalUsd.toFixed(2)}) has been dropped!\n\n` +
            `Click **Claim** to enter.\n` +
            `⏳ Ends: <t:${endTimestamp}:R>`
        )
        .setColor(0x00ff00)
        .addFields(
          { name: 'Pot Size', value: `${event.potSize.toFixed(2)} ${event.token}`, inline: true },
          {
            name: 'Max Winners',
            value: event.maxWinners ? `${event.maxWinners}` : 'Unlimited',
            inline: true,
          }
        )
        .setFooter({ text: 'Funds are held securely in a temporary wallet.' })
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`claim_airdrop_${event.airdropId}`)
          .setLabel('💰 Claim')
          .setStyle(ButtonStyle.Success)
      );

      const message = await textChannel.send({ embeds: [embed], components: [row] });

      // Update the airdrop with the message ID
      const { prisma } = await import('fattips-database');
      await prisma.airdrop.update({
        where: { id: event.airdropId },
        data: { messageId: message.id },
      });

      console.log(`Airdrop message posted to ${event.channelId}: ${message.id}`);
    } catch (error) {
      console.error('Error posting airdrop message to Discord:', error);
    }
  }

  async close(): Promise<void> {
    await this.subscriber.quit();
  }
}
