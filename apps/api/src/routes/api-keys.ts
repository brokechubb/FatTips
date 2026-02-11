import { Router, Request, Response } from 'express';
import { prisma } from 'fattips-database';
import crypto from 'crypto';

const router: Router = Router();

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

function generateApiKey(): string {
  return 'ft_' + crypto.randomBytes(32).toString('hex');
}

function requireAdmin(req: Request, res: Response, next: () => void) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    res.status(401).json({ error: 'Admin API key required' });
    return;
  }

  if (apiKey !== ADMIN_API_KEY) {
    res.status(403).json({ error: 'Invalid admin API key' });
    return;
  }

  next();
}

router.post('/create', requireAdmin, async (req: Request, res: Response) => {
  const { discordId, name } = req.body as { discordId: string; name?: string };

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

router.get('/', requireAdmin, async (req: Request, res: Response) => {
  const { discordId } = req.query;

  try {
    const keys = await prisma.apiKey.findMany({
      where: discordId ? { discordId: discordId as string } : undefined,
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

router.delete('/:key', requireAdmin, async (req: Request, res: Response) => {
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
