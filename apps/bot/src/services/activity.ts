import { redisActivityService } from 'fattips-shared';

export class ActivityService {
  // Fallback in-memory cache for when Redis is unavailable
  private memoryCache: Map<string, Map<string, number>> = new Map();

  /**
   * Record a user's activity in a channel
   * Writes to both Redis (primary) and memory cache (fallback)
   */
  async recordActivity(userId: string, channelId: string): Promise<void> {
    // Update memory cache as fallback
    if (!this.memoryCache.has(channelId)) {
      this.memoryCache.set(channelId, new Map());
    }
    this.memoryCache.get(channelId)!.set(userId, Date.now());

    // Try to write to Redis for cross-instance sharing
    try {
      await redisActivityService.recordActivity(userId, channelId);
    } catch (error) {
      console.warn('Redis activity write failed, using memory cache only');
    }
  }

  /**
   * Get users active in the last X minutes
   * Tries Redis first, falls back to memory cache
   */
  async getActiveUsers(channelId: string, minutes: number = 15): Promise<string[]> {
    // Try Redis first for cross-instance data
    try {
      const redisUsers = await redisActivityService.getActiveUsers(channelId, minutes);
      if (redisUsers.length > 0) {
        return redisUsers;
      }
    } catch (error) {
      console.warn('Redis activity read failed, using memory cache');
    }

    // Fallback to memory cache
    const channelMap = this.memoryCache.get(channelId);
    if (!channelMap) return [];

    const cutoff = Date.now() - minutes * 60 * 1000;
    const activeUsers: string[] = [];

    for (const [userId, lastActive] of channelMap.entries()) {
      if (lastActive >= cutoff) {
        activeUsers.push(userId);
      }
    }

    return activeUsers;
  }

  /**
   * Cleanup old entries (primarily for memory cache)
   */
  async cleanup(): Promise<void> {
    const cutoff = Date.now() - 60 * 60 * 1000; // Keep 1 hour

    for (const [channelId, userMap] of this.memoryCache.entries()) {
      for (const [userId, lastActive] of userMap.entries()) {
        if (lastActive < cutoff) {
          userMap.delete(userId);
        }
      }
      if (userMap.size === 0) {
        this.memoryCache.delete(channelId);
      }
    }

    // Also cleanup Redis
    try {
      await redisActivityService.cleanup(60);
    } catch (error) {
      console.warn('Redis cleanup failed:', error);
    }
  }
}

export const activityService = new ActivityService();

// Start periodic cleanup (every 5 minutes)
setInterval(() => activityService.cleanup(), 5 * 60 * 1000);
