import IORedis from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');

class RedisPubSub {
  private publisher: IORedis;
  private subscriber: IORedis;
  private isReady = false;

  constructor() {
    this.publisher = new IORedis({
      host: redisHost,
      port: redisPort,
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
    });

    this.subscriber = new IORedis({
      host: redisHost,
      port: redisPort,
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
    });

    this.subscriber.on('ready', () => {
      this.isReady = true;
      console.log('Redis subscriber ready');
    });

    this.publisher.on('error', (err: Error) => {
      console.error('Redis publisher error:', err.message);
    });

    this.subscriber.on('error', (err: Error) => {
      console.error('Redis subscriber error:', err.message);
    });
  }

  async publish(channel: string, message: object): Promise<void> {
    try {
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (error) {
      console.error('Error publishing to Redis:', error);
    }
  }

  async subscribe(channel: string, callback: (message: object) => void): Promise<void> {
    await this.subscriber.subscribe(channel);
    this.subscriber.on('message', (ch: string, message: string) => {
      if (ch === channel) {
        try {
          callback(JSON.parse(message));
        } catch (error) {
          console.error('Error parsing Redis message:', error);
        }
      }
    });
  }

  getIsReady(): boolean {
    return this.isReady;
  }

  async close(): Promise<void> {
    await this.publisher.quit();
    await this.subscriber.quit();
  }
}

export const redisPubSub = new RedisPubSub();

export const REDIS_CHANNELS = {
  AIRDROP_CREATED: 'airdrop:created',
  TRANSACTION_COMPLETED: 'transaction:completed',
} as const;
