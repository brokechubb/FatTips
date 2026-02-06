import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/users/:discordId', (req, res) => {
  res.json({ message: 'User endpoint' });
});

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});
