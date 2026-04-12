import { Router } from 'express';
import { prisma } from 'fattips-database';

const router: Router = Router();

// Top Airdrop Creators (by distributed amount)
router.get('/top-airdrop-creators', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
  const guildId = req.query.guildId as string | undefined;
  const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
  const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;
  const status = (req.query.status as string) || 'SETTLED';

  if (fromDate && isNaN(fromDate.getTime())) {
    res.status(400).json({ error: 'Invalid fromDate. Use ISO 8601 format (e.g. 2026-03-01).' });
    return;
  }
  if (toDate && isNaN(toDate.getTime())) {
    res.status(400).json({ error: 'Invalid toDate. Use ISO 8601 format (e.g. 2026-04-01).' });
    return;
  }

  const validStatuses = ['ACTIVE', 'SETTLING', 'SETTLED', 'FAILED', 'RECLAIMED'];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  try {
    const topCreators = await prisma.airdrop.groupBy({
      by: ['creatorId'],
      _sum: {
        amountTotal: true,
        amountClaimed: true,
      },
      _count: {
        id: true,
      },
      orderBy: {
        _sum: {
          amountClaimed: 'desc',
        },
      },
      take: limit,
      where: {
        status: status as any,
        ...(guildId ? { guildId } : {}),
        ...(fromDate || toDate
          ? {
              createdAt: {
                ...(fromDate ? { gte: fromDate } : {}),
                ...(toDate ? { lte: toDate } : {}),
              },
            }
          : {}),
      },
    });

    const userIds = topCreators.map((t) => t.creatorId).filter((id): id is string => id !== null);

    if (userIds.length === 0) {
      res.json([]);
      return;
    }

    const users = await prisma.user.findMany({
      where: { discordId: { in: userIds } },
      select: { discordId: true, walletPubkey: true },
    });

    const result = topCreators
      .map((t, index) => {
        if (!t.creatorId) return null;
        const user = users.find((u) => u.discordId === t.creatorId);
        if (!user) return null;

        const totalDistributed = t._sum.amountClaimed
          ? Number(t._sum.amountClaimed).toFixed(2)
          : '0.00';
        const totalAllocated = t._sum.amountTotal ? Number(t._sum.amountTotal).toFixed(2) : '0.00';

        return {
          rank: index + 1,
          discordId: t.creatorId,
          wallet: user.walletPubkey,
          airdropCount: t._count.id,
          totalAllocated,
          totalDistributed,
        };
      })
      .filter((r) => r !== null);

    res.json(result);
  } catch (error) {
    console.error('Error fetching top airdrop creators:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Top Rain/Tips Senders (by volume)
router.get('/top-rain-senders', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
  const guildId = req.query.guildId as string | undefined;
  const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
  const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;

  if (fromDate && isNaN(fromDate.getTime())) {
    res.status(400).json({ error: 'Invalid fromDate. Use ISO 8601 format (e.g. 2026-03-01).' });
    return;
  }
  if (toDate && isNaN(toDate.getTime())) {
    res.status(400).json({ error: 'Invalid toDate. Use ISO 8601 format (e.g. 2026-04-01).' });
    return;
  }

  try {
    const topSenders = await prisma.transaction.groupBy({
      by: ['fromId'],
      _sum: {
        amountUsd: true,
      },
      _count: {
        id: true,
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
        fromId: { not: null },
        ...(guildId ? { guildId } : {}),
        ...(fromDate || toDate
          ? {
              createdAt: {
                ...(fromDate ? { gte: fromDate } : {}),
                ...(toDate ? { lte: toDate } : {}),
              },
            }
          : {}),
      },
    });

    const userIds = topSenders.map((t) => t.fromId).filter((id): id is string => id !== null);

    if (userIds.length === 0) {
      res.json([]);
      return;
    }

    const users = await prisma.user.findMany({
      where: { discordId: { in: userIds } },
      select: { discordId: true, walletPubkey: true },
    });

    const result = topSenders
      .map((t, index) => {
        if (!t.fromId) return null;
        const user = users.find((u) => u.discordId === t.fromId);
        if (!user) return null;

        const totalUsd = t._sum.amountUsd ? Number(t._sum.amountUsd).toFixed(2) : '0.00';

        return {
          rank: index + 1,
          discordId: t.fromId,
          wallet: user.walletPubkey,
          tipCount: t._count.id,
          totalUsd,
        };
      })
      .filter((r) => r !== null);

    res.json(result);
  } catch (error) {
    console.error('Error fetching top rain senders:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Guild Stats
router.get('/guild-stats', async (req, res) => {
  const guildId = req.query.guildId as string;

  if (!guildId) {
    res.status(400).json({ error: 'guildId is required' });
    return;
  }

  const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
  const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;

  if (fromDate && isNaN(fromDate.getTime())) {
    res.status(400).json({ error: 'Invalid fromDate. Use ISO 8601 format (e.g. 2026-03-01).' });
    return;
  }
  if (toDate && isNaN(toDate.getTime())) {
    res.status(400).json({ error: 'Invalid toDate. Use ISO 8601 format (e.g. 2026-04-01).' });
    return;
  }

  const dateFilter =
    fromDate || toDate
      ? {
          createdAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {};

  try {
    const tipStats = await prisma.transaction.aggregate({
      where: {
        txType: 'TIP',
        status: 'CONFIRMED',
        guildId: guildId,
        ...dateFilter,
      },
      _sum: {
        amountUsd: true,
      },
      _count: {
        id: true,
      },
    });

    const airdropStats = await prisma.airdrop.aggregate({
      where: {
        guildId: guildId,
        status: 'SETTLED',
        ...dateFilter,
      },
      _sum: {
        amountClaimed: true,
      },
      _count: {
        id: true,
      },
    });

    const uniqueTippers = await prisma.transaction.findMany({
      where: {
        txType: 'TIP',
        status: 'CONFIRMED',
        guildId: guildId,
        ...dateFilter,
      },
      select: { fromId: true },
      distinct: ['fromId'],
    });

    const uniqueReceivers = await prisma.transaction.findMany({
      where: {
        txType: 'TIP',
        status: 'CONFIRMED',
        guildId: guildId,
        toId: { not: null },
        ...dateFilter,
      },
      select: { toId: true },
      distinct: ['toId'],
    });

    res.json({
      guildId,
      tips: {
        count: tipStats._count.id,
        totalVolumeUsd: tipStats._sum.amountUsd
          ? Number(tipStats._sum.amountUsd).toFixed(2)
          : '0.00',
        uniqueSenders: uniqueTippers.length,
        uniqueReceivers: uniqueReceivers.length,
      },
      airdrops: {
        count: airdropStats._count.id,
        totalDistributed: airdropStats._sum.amountClaimed
          ? Number(airdropStats._sum.amountClaimed).toFixed(2)
          : '0.00',
      },
    });
  } catch (error) {
    console.error('Error fetching guild stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// User Stats
router.get('/user-stats', async (req, res) => {
  const discordId = req.query.discordId as string;

  if (!discordId) {
    res.status(400).json({ error: 'discordId is required' });
    return;
  }

  const guildId = req.query.guildId as string | undefined;
  const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
  const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;

  if (fromDate && isNaN(fromDate.getTime())) {
    res.status(400).json({ error: 'Invalid fromDate. Use ISO 8601 format (e.g. 2026-03-01).' });
    return;
  }
  if (toDate && isNaN(toDate.getTime())) {
    res.status(400).json({ error: 'Invalid toDate. Use ISO 8601 format (e.g. 2026-04-01).' });
    return;
  }

  const dateFilter =
    fromDate || toDate
      ? {
          createdAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {};

  try {
    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const sentTips = await prisma.transaction.aggregate({
      where: {
        fromId: discordId,
        txType: 'TIP',
        status: 'CONFIRMED',
        ...(guildId ? { guildId } : {}),
        ...dateFilter,
      },
      _sum: { amountUsd: true },
      _count: { id: true },
    });

    const receivedTips = await prisma.transaction.aggregate({
      where: {
        toId: discordId,
        txType: 'TIP',
        status: 'CONFIRMED',
        ...(guildId ? { guildId } : {}),
        ...dateFilter,
      },
      _sum: { amountUsd: true },
      _count: { id: true },
    });

    const airdropsCreated = await prisma.airdrop.aggregate({
      where: {
        creatorId: discordId,
        status: 'SETTLED',
        ...(guildId ? { guildId } : {}),
        ...dateFilter,
      },
      _sum: { amountClaimed: true },
      _count: { id: true },
    });

    const airdropsWon = await prisma.airdropParticipant.count({
      where: {
        userId: discordId,
      },
    });

    res.json({
      discordId,
      tipsSent: {
        count: sentTips._count.id,
        totalUsd: sentTips._sum.amountUsd ? Number(sentTips._sum.amountUsd).toFixed(2) : '0.00',
      },
      tipsReceived: {
        count: receivedTips._count.id,
        totalUsd: receivedTips._sum.amountUsd
          ? Number(receivedTips._sum.amountUsd).toFixed(2)
          : '0.00',
      },
      airdropsCreated: {
        count: airdropsCreated._count.id,
        totalDistributed: airdropsCreated._sum.amountClaimed
          ? Number(airdropsCreated._sum.amountClaimed).toFixed(2)
          : '0.00',
      },
      airdropsWon,
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Transaction Report — filterable list of transactions
router.get('/transactions', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const guildId = req.query.guildId as string | undefined;
  const fromId = req.query.fromId as string | undefined;
  const toId = req.query.toId as string | undefined;
  const txType = req.query.txType as string | undefined;
  const status = req.query.status as string | undefined;
  const tokenMint = req.query.tokenMint as string | undefined;
  const minAmountUsd = req.query.minAmountUsd
    ? parseFloat(req.query.minAmountUsd as string)
    : undefined;
  const maxAmountUsd = req.query.maxAmountUsd
    ? parseFloat(req.query.maxAmountUsd as string)
    : undefined;
  const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
  const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;
  const sortBy = (req.query.sortBy as string) || 'createdAt';
  const sortOrder = (req.query.sortOrder as string) || 'desc';

  if (fromDate && isNaN(fromDate.getTime())) {
    res.status(400).json({ error: 'Invalid fromDate. Use ISO 8601 format (e.g. 2026-03-01).' });
    return;
  }
  if (toDate && isNaN(toDate.getTime())) {
    res.status(400).json({ error: 'Invalid toDate. Use ISO 8601 format (e.g. 2026-04-01).' });
    return;
  }

  const validTxTypes = ['TIP', 'DEPOSIT', 'WITHDRAWAL', 'AIRDROP_CLAIM'];
  if (txType && !validTxTypes.includes(txType)) {
    res.status(400).json({ error: `Invalid txType. Must be one of: ${validTxTypes.join(', ')}` });
    return;
  }

  const validStatuses = ['PENDING', 'CONFIRMED', 'FAILED'];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  const validSortFields = ['createdAt', 'amountUsd', 'amountToken'];
  if (!validSortFields.includes(sortBy)) {
    res
      .status(400)
      .json({ error: `Invalid sortBy. Must be one of: ${validSortFields.join(', ')}` });
    return;
  }

  const validSortOrders = ['asc', 'desc'];
  if (!validSortOrders.includes(sortOrder)) {
    res.status(400).json({ error: 'Invalid sortOrder. Must be asc or desc.' });
    return;
  }

  try {
    const where: any = {
      ...(guildId ? { guildId } : {}),
      ...(fromId ? { fromId } : {}),
      ...(toId ? { toId } : {}),
      ...(txType ? { txType } : {}),
      ...(status ? { status } : {}),
      ...(tokenMint ? { tokenMint } : {}),
      ...(fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    if (minAmountUsd !== undefined || maxAmountUsd !== undefined) {
      where.amountUsd = {
        ...(minAmountUsd !== undefined ? { gte: minAmountUsd } : {}),
        ...(maxAmountUsd !== undefined ? { lte: maxAmountUsd } : {}),
      };
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        take: limit,
        skip: offset,
        select: {
          id: true,
          signature: true,
          fromId: true,
          toId: true,
          fromAddress: true,
          toAddress: true,
          amountUsd: true,
          amountToken: true,
          tokenMint: true,
          txType: true,
          status: true,
          guildId: true,
          createdAt: true,
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      total,
      offset,
      limit,
      data: transactions.map((tx) => ({
        id: tx.id,
        signature: tx.signature,
        fromId: tx.fromId,
        toId: tx.toId,
        fromAddress: tx.fromAddress,
        toAddress: tx.toAddress,
        amountUsd: tx.amountUsd ? Number(tx.amountUsd).toFixed(2) : null,
        amountToken: tx.amountToken ? Number(tx.amountToken).toFixed(9) : null,
        tokenMint: tx.tokenMint,
        txType: tx.txType,
        status: tx.status,
        guildId: tx.guildId,
        createdAt: tx.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Error fetching transaction report:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Airdrop Report — filterable list of airdrops
router.get('/airdrops', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;
  const guildId = req.query.guildId as string | undefined;
  const creatorId = req.query.creatorId as string | undefined;
  const status = req.query.status as string | undefined;
  const tokenMint = req.query.tokenMint as string | undefined;
  const minAmountTotal = req.query.minAmountTotal
    ? parseFloat(req.query.minAmountTotal as string)
    : undefined;
  const maxAmountTotal = req.query.maxAmountTotal
    ? parseFloat(req.query.maxAmountTotal as string)
    : undefined;
  const fromDate = req.query.fromDate ? new Date(req.query.fromDate as string) : undefined;
  const toDate = req.query.toDate ? new Date(req.query.toDate as string) : undefined;
  const sortBy = (req.query.sortBy as string) || 'createdAt';
  const sortOrder = (req.query.sortOrder as string) || 'desc';

  if (fromDate && isNaN(fromDate.getTime())) {
    res.status(400).json({ error: 'Invalid fromDate. Use ISO 8601 format (e.g. 2026-03-01).' });
    return;
  }
  if (toDate && isNaN(toDate.getTime())) {
    res.status(400).json({ error: 'Invalid toDate. Use ISO 8601 format (e.g. 2026-04-01).' });
    return;
  }

  const validStatuses = ['ACTIVE', 'SETTLING', 'SETTLED', 'FAILED', 'RECLAIMED'];
  if (status && !validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  const validSortFields = ['createdAt', 'amountTotal', 'amountClaimed', 'participantCount'];
  if (!validSortFields.includes(sortBy)) {
    res
      .status(400)
      .json({ error: `Invalid sortBy. Must be one of: ${validSortFields.join(', ')}` });
    return;
  }

  try {
    const where: any = {
      ...(guildId ? { guildId } : {}),
      ...(creatorId ? { creatorId } : {}),
      ...(status ? { status } : {}),
      ...(tokenMint ? { tokenMint } : {}),
      ...(fromDate || toDate
        ? {
            createdAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    };

    if (minAmountTotal !== undefined || maxAmountTotal !== undefined) {
      where.amountTotal = {
        ...(minAmountTotal !== undefined ? { gte: minAmountTotal } : {}),
        ...(maxAmountTotal !== undefined ? { lte: maxAmountTotal } : {}),
      };
    }

    const [airdrops, total] = await Promise.all([
      prisma.airdrop.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        take: limit,
        skip: offset,
        select: {
          id: true,
          creatorId: true,
          amountTotal: true,
          amountClaimed: true,
          tokenMint: true,
          maxParticipants: true,
          participantCount: true,
          status: true,
          guildId: true,
          channelId: true,
          createdAt: true,
          expiresAt: true,
          settledAt: true,
        },
      }),
      prisma.airdrop.count({ where }),
    ]);

    res.json({
      total,
      offset,
      limit,
      data: airdrops.map((a) => ({
        id: a.id,
        creatorId: a.creatorId,
        amountTotal: a.amountTotal ? Number(a.amountTotal).toFixed(9) : null,
        amountClaimed: a.amountClaimed ? Number(a.amountClaimed).toFixed(9) : null,
        tokenMint: a.tokenMint,
        maxParticipants: a.maxParticipants,
        participantCount: a.participantCount,
        status: a.status,
        guildId: a.guildId,
        channelId: a.channelId,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
        settledAt: a.settledAt?.toISOString() || null,
      })),
    });
  } catch (error) {
    console.error('Error fetching airdrop report:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
