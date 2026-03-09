import { Router } from 'express';
import { prisma } from 'fattips-database';
import { BalanceService } from 'fattips-solana';
import { requireAuth, requireOwnership } from '../middleware/auth';

const router: Router = Router();
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);

router.use(requireAuth);
router.use(requireOwnership);

router.get('/:discordId', async (req, res) => {
  const { discordId } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const balances = await balanceService.getBalances(user.walletPubkey);

    res.json({
      discordId,
      walletPubkey: user.walletPubkey,
      balances: {
        sol: balances.sol,
        usdc: balances.usdc,
        usdt: balances.usdt,
      },
    });
  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

export default router;
