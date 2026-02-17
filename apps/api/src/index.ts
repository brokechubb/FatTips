import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import * as dotenv from 'dotenv';
import { requireAuth } from './middleware/auth';
import userRoutes from './routes/users';
import walletRoutes from './routes/wallet';
import balanceRoutes from './routes/balance';
import sendRoutes from './routes/send';
import transactionRoutes from './routes/transactions';
import airdropRoutes from './routes/airdrops';
import swapRoutes from './routes/swap';
import rainRoutes from './routes/rain';
import leaderboardRoutes from './routes/leaderboard';
import apiKeyRoutes from './routes/api-keys';
import activityRoutes from './routes/activity';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json());
const logFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(logFormat));

// Global rate limit: 60 requests per minute per API key
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-api-key'] as string || req.ip || 'unknown',
  message: { error: 'Too many requests. Please try again later.' },
});

// Strict rate limit for financial endpoints: 10 requests per minute per API key
const financialLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-api-key'] as string || req.ip || 'unknown',
  message: { error: 'Too many financial requests. Please slow down.' },
});

app.use(globalLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API keys management (no auth - for initial setup)
app.use('/api/keys', apiKeyRoutes);

// Authenticated Routes
app.use('/api/users', requireAuth, userRoutes);
app.use('/api/wallet', walletRoutes); // Auth handled internally (create is open, others require auth)
app.use('/api/balance', requireAuth, balanceRoutes);
app.use('/api/send', requireAuth, financialLimiter, sendRoutes);
app.use('/api/transactions', requireAuth, transactionRoutes);
app.use('/api/airdrops', requireAuth, financialLimiter, airdropRoutes);
app.use('/api/swap', requireAuth, financialLimiter, swapRoutes);
app.use('/api/rain', requireAuth, financialLimiter, rainRoutes);
app.use('/api/leaderboard', requireAuth, leaderboardRoutes);
app.use('/api/activity', activityRoutes);

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});
