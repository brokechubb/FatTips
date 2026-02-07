export class ActivityService {
  // Map<channelId, Map<userId, timestamp>>
  private channelActivity: Map<string, Map<string, number>> = new Map();

  // Clean up old entries every 5 minutes
  constructor() {
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Record a user's activity in a channel
   */
  recordActivity(userId: string, channelId: string) {
    if (!this.channelActivity.has(channelId)) {
      this.channelActivity.set(channelId, new Map());
    }

    const channelMap = this.channelActivity.get(channelId)!;
    channelMap.set(userId, Date.now());
  }

  /**
   * Get users active in the last X minutes
   */
  getActiveUsers(channelId: string, minutes: number = 15): string[] {
    const channelMap = this.channelActivity.get(channelId);
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
   * Remove old data to prevent memory leaks
   */
  private cleanup() {
    const cutoff = Date.now() - 60 * 60 * 1000; // Keep 1 hour of history max

    for (const [channelId, userMap] of this.channelActivity.entries()) {
      for (const [userId, lastActive] of userMap.entries()) {
        if (lastActive < cutoff) {
          userMap.delete(userId);
        }
      }

      // Remove empty channels
      if (userMap.size === 0) {
        this.channelActivity.delete(channelId);
      }
    }
  }
}

export const activityService = new ActivityService();
