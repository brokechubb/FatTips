import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import * as dotenv from 'dotenv';
import { requireAuth } from './middleware/auth';
import userRoutes from './routes/users';
import transactionRoutes from './routes/transactions';
import leaderboardRoutes from './routes/leaderboard';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Authenticated Routes
app.use('/api/users', requireAuth, userRoutes);
app.use('/api/transactions', requireAuth, transactionRoutes);
app.use('/api/leaderboard', requireAuth, leaderboardRoutes);

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});
