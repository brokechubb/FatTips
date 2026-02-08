import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];
  const validKey = process.env.API_KEY;

  if (!validKey) {
    console.error('API_KEY not set in environment variables');
    res.status(500).json({ error: 'Internal Server Error' });
    return;
  }

  if (!apiKey || apiKey !== validKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
