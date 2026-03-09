import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import crypto from 'crypto';

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
    attempts: 1, // Fix: Disable automatic retries to prevent double-spending on timeouts
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 1000, // Keep last 1000 failed jobs for debugging
  },
});

/**
 * Generate an idempotency key for deduplicating transactions.
 * Prevents double-submission within a 30-second window.
 */
export function generateJobId(
  type: string,
  senderDiscordId: string,
  amountPerUser: number,
  tokenSymbol: string
): string {
  // Round to 30-second windows to prevent rapid duplicate submissions
  const timeWindow = Math.floor(Date.now() / 30000);
  const raw = `${type}:${senderDiscordId}:${amountPerUser}:${tokenSymbol}:${timeWindow}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}
