import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

// Ensure logs directory exists
const logDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
  return `${timestamp} [${level}]: ${message} ${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp(), logFormat),
  transports: [
    // Console log (for Docker logs)
    new winston.transports.Console({
      format: combine(colorize(), timestamp(), logFormat),
    }),
    // File log for all logs
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Separate file for transactions only (cleaner audit)
    new winston.transports.File({
      filename: path.join(logDir, 'transactions.log'),
      level: 'info',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

// Helper for transaction logging
export function logTransaction(
  type: 'TIP' | 'SEND' | 'AIRDROP' | 'WALLET',
  data: {
    fromId?: string;
    toId?: string;
    amount?: number;
    token?: string;
    signature?: string;
    status: 'SUCCESS' | 'FAILED';
    error?: string;
  }
) {
  logger.info(`[${type}] ${data.status} - ${data.amount || 0} ${data.token || ''}`, data);
}
