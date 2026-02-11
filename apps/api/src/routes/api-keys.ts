import { Router } from 'express';
import { prisma } from 'fattips-database';
import crypto from 'crypto';

const router: Router = Router();

function generateApiKey(): string {
  return 'ft_' + crypto.randomBytes(32).toString('hex');
}

router.post('/create', async (req, res) => {
  const { discordId, name } = req.body;

  try {
    if (!discordId) {
      res.status(400).json({ error: 'discordId is required' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { discordId },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found. Create a wallet first.' });
      return;
    }

    const existingKey = await prisma.apiKey.findFirst({
      where: { discordId, name: name || 'Default' },
    });

    if (existingKey) {
      res.json({
        success: true,
        apiKey: existingKey.key,
        discordId: existingKey.discordId,
        name: existingKey.name,
        createdAt: existingKey.createdAt,
      });
      return;
    }

    const apiKey = await prisma.apiKey.create({
      data: {
        key: generateApiKey(),
        discordId,
        name: name || 'Default',
      },
    });

    res.json({
      success: true,
      apiKey: apiKey.key,
      discordId: apiKey.discordId,
      name: apiKey.name,
      createdAt: apiKey.createdAt,
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

router.get('/', async (req, res) => {
  const { discordId } = req.query;

  try {
    if (!discordId) {
      res.status(400).json({ error: 'discordId is required' });
      return;
    }

    const keys = await prisma.apiKey.findMany({
      where: { discordId: discordId as string },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      keys: keys.map((k: any) => ({
        id: k.id,
        key: k.key,
        name: k.name,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        createdAt: k.createdAt,
        isExpired: k.expiresAt && new Date() > k.expiresAt,
      })),
    });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

router.delete('/:key', async (req, res) => {
  const { key } = req.params;

  try {
    await prisma.apiKey.delete({
      where: { key },
    });

    res.json({ success: true, message: 'API key revoked' });
  } catch (error) {
    console.error('Error revoking API key:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

export default router;
