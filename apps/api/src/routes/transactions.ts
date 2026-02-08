import { Router } from 'express';
import { prisma } from 'fattips-database';

const router: Router = Router();

// Get transaction by ID or Signature
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const tx = await prisma.transaction.findFirst({
      where: {
        OR: [{ id: id }, { signature: id }],
      },
    });

    if (!tx) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    res.json(tx);
  } catch (error) {
    console.error('Error fetching transaction:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get recent transactions for a user
router.get('/user/:discordId', async (req, res) => {
  const { discordId } = req.params;
  const limit = parseInt(req.query.limit as string) || 10;
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [{ fromId: discordId }, { toId: discordId }],
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 50), // Cap at 50
      skip: offset,
    });

    res.json(transactions);
  } catch (error) {
    console.error('Error fetching user transactions:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
