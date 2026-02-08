import { Router } from 'express';
import { prisma } from 'fattips-database';

const router: Router = Router();

router.get('/:discordId', async (req, res) => {
  const { discordId } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { discordId },
      include: {
        _count: {
          select: {
            sentTips: true,
            receivedTips: true,
            airdropsCreated: true,
            participations: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Exclude sensitive data
    // @ts-ignore - dynamic destructuring
    const { encryptedPrivkey, keySalt, encryptedMnemonic, mnemonicSalt, ...safeUser } = user;

    res.json(safeUser);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
