import { Router } from 'express';
import { prisma } from 'fattips-database';
import { WalletService } from 'fattips-solana';
import { requireAuth, requireOwnership } from '../middleware/auth';

const router: Router = Router();

const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);

// Wallet creation - no auth required (used for initial setup)
router.post('/create', async (req, res) => {
  const { discordId } = req.body as { discordId: string };

  try {
    if (!discordId) {
      res.status(400).json({ error: 'discordId is required' });
      return;
    }

    const existingUser = await prisma.user.findUnique({
      where: { discordId },
    });

    if (existingUser) {
      res.status(400).json({ error: 'User already has a wallet' });
      return;
    }

    const wallet = await walletService.createEncryptedWallet();

    const user = await prisma.user.create({
      data: {
        discordId,
        walletPubkey: wallet.publicKey,
        encryptedPrivkey: wallet.encryptedPrivateKey,
        keySalt: wallet.keySalt,
        encryptedMnemonic: wallet.encryptedMnemonic,
        mnemonicSalt: wallet.mnemonicSalt,
        seedDelivered: false,
      },
    });

    res.json({
      success: true,
      discordId,
      walletPubkey: wallet.publicKey,
      privateKey: wallet.privateKeyBase58,
      mnemonic: wallet.mnemonic,
    });
  } catch (error) {
    console.error('Error creating wallet:', error);
    res.status(500).json({ error: 'Failed to create wallet' });
  }
});

// Get wallet - requires auth and ownership
router.get('/:discordId', requireAuth, requireOwnership, async (req, res) => {
  const { discordId } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    if (!user) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    res.json({
      discordId: user.discordId,
      walletPubkey: user.walletPubkey,
      hasMnemonic: !!user.encryptedMnemonic,
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error('Error fetching wallet:', error);
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

router.delete('/:discordId', requireAuth, requireOwnership, async (req, res) => {
  const { discordId } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    if (!user) {
      res.status(404).json({ error: 'Wallet not found' });
      return;
    }

    await prisma.user.delete({
      where: { discordId },
    });

    res.json({
      success: true,
      message: 'Wallet deleted',
      discordId,
    });
  } catch (error) {
    console.error('Error deleting wallet:', error);
    res.status(500).json({ error: 'Failed to delete wallet' });
  }
});

export default router;
