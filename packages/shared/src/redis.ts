import IORedis, { Redis, RedisOptions } from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');

class RedisPubSub {
  private publisher!: Redis;
  private subscriber!: Redis;
  private isReady = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 30; // Maximum reconnect attempts before giving up

  constructor() {
    this.initializeConnections();
  }

  private initializeConnections(): void {
    // Close existing connections if they exist
    if (this.publisher) {
      this.publisher.disconnect();
    }
    if (this.subscriber) {
      this.subscriber.disconnect();
    }

    // Configure connection options with improved retry strategy
    const connectionOptions: RedisOptions = {
      host: redisHost,
      port: redisPort,
      retryStrategy: (times: number) => {
        this.reconnectAttempts = times;

        // If we've exceeded max attempts, give up
        if (times > this.maxReconnectAttempts) {
          console.error(
            'Redis: Giving up after',
            this.maxReconnectAttempts,
            'reconnection attempts'
          );
          return null; // Stop retrying
        }

        // Exponential backoff with max delay of 5 seconds
        const delay = Math.min(Math.pow(2, times) * 100, 5000);
        console.log(
          `Redis: Attempting to reconnect (${times}/${this.maxReconnectAttempts}) in ${delay}ms`
        );
        return delay;
      },
      connectTimeout: 10000, // 10 second connection timeout
      lazyConnect: true, // Don't connect immediately
    };

    this.publisher = new IORedis(connectionOptions);
    this.subscriber = new IORedis(connectionOptions);

    // Event handlers for publisher
    this.publisher.on('ready', () => {
      console.log('Redis publisher ready');
    });

    this.publisher.on('connect', () => {
      console.log('Redis publisher connected');
    });

    this.publisher.on('error', (err: Error) => {
      console.error('Redis publisher error:', err.message);
    });

    this.publisher.on('close', () => {
      console.log('Redis publisher connection closed');
    });

    // Event handlers for subscriber
    this.subscriber.on('ready', () => {
      this.isReady = true;
      this.reconnectAttempts = 0; // Reset on successful connection
      console.log('Redis subscriber ready');
    });

    this.subscriber.on('connect', () => {
      console.log('Redis subscriber connected');
    });

    this.subscriber.on('error', (err: Error) => {
      console.error('Redis subscriber error:', err.message);

      // If it's a DNS error, we might need to reinitialize connections
      if (err.message.includes('ENOTFOUND') || err.message.includes('EAI_AGAIN')) {
        console.log('DNS resolution failed, will retry connection...');
      }
    });

    this.subscriber.on('close', () => {
      console.log('Redis subscriber connection closed');
      this.isReady = false;
    });

    // Connect lazily
    this.publisher.connect().catch((err: unknown) => {
      const error = err as Error;
      console.error('Initial publisher connection failed:', error.message);
    });

    this.subscriber.connect().catch((err: unknown) => {
      const error = err as Error;
      console.error('Initial subscriber connection failed:', error.message);
    });
  }

  async publish(channel: string, message: object): Promise<void> {
    try {
      // Wait for publisher to be ready if it's not already
      if (!this.publisher.status || this.publisher.status !== 'ready') {
        await this.waitForConnection(this.publisher);
      }

      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (error) {
      const err = error as Error;
      console.error('Error publishing to Redis:', err.message);
      // Reinitialize connections on persistent failure
      if (this.reconnectAttempts > 5) {
        console.log('Reinitializing Redis connections due to persistent failures');
        this.initializeConnections();
      }
    }
  }

  async subscribe(channel: string, callback: (message: object) => void): Promise<void> {
    try {
      // Wait for subscriber to be ready if it's not already
      if (!this.subscriber.status || this.subscriber.status !== 'ready') {
        await this.waitForConnection(this.subscriber);
      }

      await this.subscriber.subscribe(channel);
      this.subscriber.on('message', (ch: string, message: string) => {
        if (ch === channel) {
          try {
            callback(JSON.parse(message));
          } catch (error) {
            const err = error as Error;
            console.error('Error parsing Redis message:', err.message);
          }
        }
      });
    } catch (error) {
      const err = error as Error;
      console.error('Error subscribing to Redis channel:', err.message);
      // Reinitialize connections on persistent failure
      if (this.reconnectAttempts > 5) {
        console.log('Reinitializing Redis connections due to persistent failures');
        this.initializeConnections();
      }
    }
  }

  private async waitForConnection(client: Redis): Promise<void> {
    const maxWaitTime = 30000; // 30 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      if (client.status === 'ready') {
        return;
      }

      // If connection is closed or end, try to reconnect
      if (client.status === 'close' || client.status === 'end') {
        try {
          await client.connect();
        } catch (err) {
          const error = err as Error;
          console.error('Failed to reconnect Redis client:', error.message);
        }
      }

      // Wait 100ms before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error('Redis connection timeout');
  }

  getIsReady(): boolean {
    return this.isReady;
  }

  async close(): Promise<void> {
    try {
      await this.publisher.quit();
    } catch (err) {
      const error = err as Error;
      console.error('Error closing Redis publisher:', error.message);
    }

    try {
      await this.subscriber.quit();
    } catch (err) {
      const error = err as Error;
      console.error('Error closing Redis subscriber:', error.message);
    }
  }
}

export const redisPubSub = new RedisPubSub();

export const REDIS_CHANNELS = {
  AIRDROP_CREATED: 'airdrop:created',
  TRANSACTION_COMPLETED: 'transaction:completed',
} as const;
