import { Router } from 'express';
import { prisma } from 'fattips-database';

const router: Router = Router();

// Top Tippers (by volume)
router.get('/top-tippers', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 10;

  try {
    const topTippers = await prisma.transaction.groupBy({
      by: ['fromId'],
      _sum: {
        amountUsd: true,
      },
      orderBy: {
        _sum: {
          amountUsd: 'desc',
        },
      },
      take: limit,
      where: {
        txType: 'TIP', // Only count tips, not withdrawals/sends
        status: 'CONFIRMED',
      },
    });

    // Fetch user details for these IDs
    const userIds = topTippers.map((t) => t.fromId).filter((id): id is string => id !== null);
    const users = await prisma.user.findMany({
      where: { discordId: { in: userIds } },
      select: { discordId: true, walletPubkey: true }, // Add username if stored in DB later
    });

    const result = topTippers
      .map((t) => {
        if (!t.fromId) return null;
        const user = users.find((u) => u.discordId === t.fromId);
        return {
          discordId: t.fromId,
          wallet: user?.walletPubkey,
          totalTippedUsd: t._sum.amountUsd,
        };
      })
      .filter((r) => r !== null);

    res.json(result);
  } catch (error) {
    console.error('Error fetching top tippers:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Top Receivers (by volume)
router.get('/top-receivers', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 10;

  try {
    const topReceivers = await prisma.transaction.groupBy({
      by: ['toId'],
      _sum: {
        amountUsd: true,
      },
      orderBy: {
        _sum: {
          amountUsd: 'desc',
        },
      },
      take: limit,
      where: {
        txType: 'TIP',
        status: 'CONFIRMED',
        toId: { not: null }, // Exclude external sends
      },
    });

    const userIds = topReceivers.map((t) => t.toId).filter((id): id is string => id !== null);
    const users = await prisma.user.findMany({
      where: { discordId: { in: userIds } },
      select: { discordId: true, walletPubkey: true },
    });

    const result = topReceivers
      .map((t) => {
        if (!t.toId) return null;
        const user = users.find((u) => u.discordId === t.toId);
        return {
          discordId: t.toId,
          wallet: user?.walletPubkey,
          totalReceivedUsd: t._sum.amountUsd,
        };
      })
      .filter((r) => r !== null);

    res.json(result);
  } catch (error) {
    console.error('Error fetching top receivers:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
