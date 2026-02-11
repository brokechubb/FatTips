import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API keys management (no auth - for initial setup)
app.use('/api/keys', apiKeyRoutes);

// Authenticated Routes
app.use('/api/users', requireAuth, userRoutes);
app.use('/api/wallet', walletRoutes); // Auth handled internally (create is open, others require auth)
app.use('/api/balance', requireAuth, balanceRoutes);
app.use('/api/send', requireAuth, sendRoutes);
app.use('/api/transactions', requireAuth, transactionRoutes);
app.use('/api/airdrops', requireAuth, airdropRoutes);
app.use('/api/swap', requireAuth, swapRoutes);
app.use('/api/rain', requireAuth, rainRoutes);
app.use('/api/leaderboard', requireAuth, leaderboardRoutes);
app.use('/api/activity', activityRoutes);

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});
