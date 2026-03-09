import IORedis from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');

class EventBus {
  private publisher: IORedis;
  private subscriber: IORedis;
  private handlers: Map<string, ((data: any) => void)[]> = new Map();
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
      console.log('EventBus subscriber ready');
    });

    this.subscriber.on('message', (channel: string, message: string) => {
      const handlers = this.handlers.get(channel) || [];
      try {
        const data = JSON.parse(message);
        handlers.forEach((handler) => {
          try {
            handler(data);
          } catch (err) {
            console.error('Error in event handler:', err);
          }
        });
      } catch (err) {
        console.error('Error parsing event message:', err);
      }
    });
  }

  async publish(channel: string, data: any): Promise<void> {
    try {
      await this.publisher.publish(channel, JSON.stringify(data));
    } catch (error) {
      console.error('Error publishing event:', error);
    }
  }

  async subscribe(channel: string, handler: (data: any) => void): Promise<void> {
    const handlers = this.handlers.get(channel) || [];
    handlers.push(handler);
    this.handlers.set(channel, handlers);
    await this.subscriber.subscribe(channel);
  }

  getIsReady(): boolean {
    return this.isReady;
  }
}

export const eventBus = new EventBus();

export const EVENTS = {
  AIRDROP_CREATED: 'airdrop:created',
  TRANSACTION_COMPLETED: 'transaction:completed',
} as const;
