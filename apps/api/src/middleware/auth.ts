import { Request, Response, NextFunction } from 'express';
import { prisma } from 'fattips-database';

interface AuthenticatedRequest extends Request {
  discordId?: string;
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    res.status(401).json({ error: 'X-API-Key header required' });
    return;
  }

  try {
    const keyRecord = await prisma.apiKey.findUnique({
      where: { key: apiKey as string },
    });

    if (!keyRecord) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    if (keyRecord.expiresAt && new Date() > keyRecord.expiresAt) {
      res.status(401).json({ error: 'API key expired' });
      return;
    }

    // Update last used timestamp
    await prisma.apiKey.update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() },
    });

    req.discordId = keyRecord.discordId;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// Middleware to verify the user being accessed matches the API key owner
export function requireOwnership(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const targetDiscordId = req.params.discordId || req.body.discordId;

  if (targetDiscordId && targetDiscordId !== req.discordId) {
    res.status(403).json({
      error: 'This API key can only access its own wallet',
      yourDiscordId: req.discordId,
    });
    return;
  }

  next();
}
