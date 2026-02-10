import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const REDIS_CONNECTION_OPTS = {
  host: process.env.REDIS_HOST || 'redis', // Default to docker service name
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

// Create a reusable Redis connection for BullMQ
const connection = new IORedis({
  ...REDIS_CONNECTION_OPTS,
  maxRetriesPerRequest: null,
});

export interface TransferJobData {
  type: 'TIP' | 'RAIN' | 'WITHDRAWAL';
  senderDiscordId: string;
  senderUsername?: string; // For notifications
  recipientDiscordIds?: string[]; // For tips/rain
  toAddress?: string; // For withdrawals (external address)
  amountPerUser: number;
  tokenMint: string;
  tokenSymbol: string;
  usdValuePerUser: number; // For logging/display

  // Context for reply
  channelId?: string;
  messageId?: string; // Original message to reply to/edit
  replyToUserId?: string; // DM fallback
  skipPriorityFee?: boolean; // For closing accounts (exact math)
}

export const transactionQueue = new Queue<TransferJobData>('transactions', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 1000, // Keep last 1000 failed jobs for debugging
  },
});
