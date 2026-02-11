import IORedis from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');

/**
 * Redis-based activity tracking service
 * Shares activity data between bot and API via Redis
 */
export class RedisActivityService {
  private redis: IORedis;
  private readonly KEY_PREFIX = 'activity:channel:';
  private readonly DEFAULT_EXPIRY = 60 * 60; // 1 hour in seconds

  constructor() {
    this.redis = new IORedis({
      host: redisHost,
      port: redisPort,
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
    });

    this.redis.on('error', (err: Error) => {
      console.error('Redis activity service error:', err.message);
    });
  }

  /**
   * Record a user's activity in a channel
   * Uses Redis sorted set with timestamp as score for efficient time-based queries
   */
  async recordActivity(userId: string, channelId: string): Promise<void> {
    const key = `${this.KEY_PREFIX}${channelId}`;
    const timestamp = Date.now();

    try {
      // Add user to sorted set with timestamp as score
      await this.redis.zadd(key, timestamp, userId);
      // Set expiry on the key to auto-cleanup old data
      await this.redis.expire(key, this.DEFAULT_EXPIRY);
    } catch (error) {
      console.error('Error recording activity to Redis:', error);
    }
  }

  /**
   * Get users active in the last X minutes
   * Returns user IDs sorted by most recent activity first
   */
  async getActiveUsers(channelId: string, minutes: number = 15): Promise<string[]> {
    const key = `${this.KEY_PREFIX}${channelId}`;
    const cutoff = Date.now() - minutes * 60 * 1000;

    try {
      // Get all users with score (timestamp) >= cutoff
      // Sorted set returns by score ascending, so we reverse for most recent first
      const users = await this.redis.zrevrangebyscore(key, '+inf', cutoff);
      return users;
    } catch (error) {
      console.error('Error getting active users from Redis:', error);
      return [];
    }
  }

  /**
   * Get activity count for a channel
   */
  async getActivityCount(channelId: string, minutes: number = 15): Promise<number> {
    const key = `${this.KEY_PREFIX}${channelId}`;
    const cutoff = Date.now() - minutes * 60 * 1000;

    try {
      return await this.redis.zcount(key, cutoff, '+inf');
    } catch (error) {
      console.error('Error getting activity count from Redis:', error);
      return 0;
    }
  }

  /**
   * Clean up old entries manually (Redis expiry handles most cleanup)
   */
  async cleanup(maxAgeMinutes: number = 60): Promise<void> {
    const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
    const pattern = `${this.KEY_PREFIX}*`;

    try {
      const keys = await this.redis.keys(pattern);
      for (const key of keys) {
        await this.redis.zremrangebyscore(key, '-inf', cutoff);
      }
    } catch (error) {
      console.error('Error cleaning up activity data:', error);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// Singleton instance
export const redisActivityService = new RedisActivityService();
