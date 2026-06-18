import { Request, Response, NextFunction } from 'express';
import { prisma } from 'fattips-database';

interface AppWallet {
  pubkey: string;
  encryptedPrivkey: string;
  keySalt: string;
}

interface AuthenticatedRequest extends Request {
  discordId?: string;
  appWallet?: AppWallet;
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

    if (keyRecord.revokedAt) {
      res.status(401).json({ error: 'API key has been revoked' });
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

    req.discordId = keyRecord.discordId ?? undefined;

    if (keyRecord.appWalletPubkey) {
      req.appWallet = {
        pubkey: keyRecord.appWalletPubkey,
        encryptedPrivkey: keyRecord.appEncryptedPrivkey!,
        keySalt: keyRecord.appKeySalt!,
      };
    }

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

export { AppWallet, AuthenticatedRequest };
