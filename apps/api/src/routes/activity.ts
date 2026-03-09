import { Router, Request, Response } from 'express';
import { redisActivityService } from 'fattips-shared';

const router: Router = Router();

interface ActiveUsersRequest {
  channelId: string;
  minutes?: number;
}

/**
 * GET /api/activity/active-users
 * Get list of active users in a Discord channel
 *
 * Query params:
 * - channelId: Discord channel ID (required)
 * - minutes: Time window (default: 15, max: 60)
 */
router.get('/active-users', async (req: Request, res: Response) => {
  const { channelId, minutes } = req.query;

  if (!channelId || typeof channelId !== 'string') {
    res.status(400).json({ error: 'channelId is required' });
    return;
  }

  // Validate channelId is a valid Discord snowflake
  if (!/^\d{17,19}$/.test(channelId)) {
    res.status(400).json({ error: 'Invalid channelId format' });
    return;
  }

  const minutesNum = Math.min(parseInt(minutes as string) || 15, 60);

  try {
    const activeUsers = await redisActivityService.getActiveUsers(channelId, minutesNum);

    res.json({
      channelId,
      minutes: minutesNum,
      count: activeUsers.length,
      users: activeUsers,
    });
  } catch (error) {
    console.error('Error getting active users:', error);
    res.status(500).json({ error: 'Failed to get active users' });
  }
});

/**
 * GET /api/activity/count
 * Get count of active users in a Discord channel
 *
 * Query params:
 * - channelId: Discord channel ID (required)
 * - minutes: Time window (default: 15, max: 60)
 */
router.get('/count', async (req: Request, res: Response) => {
  const { channelId, minutes } = req.query;

  if (!channelId || typeof channelId !== 'string') {
    res.status(400).json({ error: 'channelId is required' });
    return;
  }

  if (!/^\d{17,19}$/.test(channelId)) {
    res.status(400).json({ error: 'Invalid channelId format' });
    return;
  }

  const minutesNum = Math.min(parseInt(minutes as string) || 15, 60);

  try {
    const count = await redisActivityService.getActivityCount(channelId, minutesNum);

    res.json({
      channelId,
      minutes: minutesNum,
      count,
    });
  } catch (error) {
    console.error('Error getting activity count:', error);
    res.status(500).json({ error: 'Failed to get activity count' });
  }
});

export default router;
