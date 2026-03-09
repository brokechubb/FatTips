import { Client, Message } from 'discord.js';
import { logger } from './logger';

// Duration before private key messages are redacted (15 minutes)
const KEY_REDACT_DELAY_MS = 15 * 60 * 1000;

// In-memory registry of pending key redactions
// If the bot crashes, these are lost — but we also store in Redis for recovery
const pendingRedactions: Map<string, NodeJS.Timeout> = new Map();

/**
 * Send a private key message that self-destructs after 15 minutes.
 * Centralizes the key-sending pattern to ensure consistent cleanup.
 */
export async function sendPrivateKeyDM(
  client: Client,
  discordUserId: string,
  content: string,
  redactedText = '🔒 **Private key removed for security.**'
): Promise<{ sent: boolean; messageId?: string }> {
  try {
    const user = await client.users.fetch(discordUserId);
    const sentMsg = await user.send(content);

    scheduleKeyRedaction(sentMsg, redactedText);

    return { sent: true, messageId: sentMsg.id };
  } catch (error: any) {
    if (error.code === 50007) {
      // Cannot send messages to this user (DMs disabled)
      return { sent: false };
    }
    logger.error(`Failed to send private key DM to ${discordUserId}:`, error);
    return { sent: false };
  }
}

/**
 * Schedule a message to be redacted after KEY_REDACT_DELAY_MS.
 * Uses the message object directly for immediate scheduling.
 */
export function scheduleKeyRedaction(
  message: Message,
  redactedText = '🔒 **Private key removed for security.**'
): void {
  const key = `${message.channelId}:${message.id}`;

  // Clear any existing timer for this message
  const existing = pendingRedactions.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    pendingRedactions.delete(key);
    try {
      await message.edit(redactedText);
    } catch (error) {
      // Message may have been deleted or bot lost access
      logger.warn(`Failed to redact key message ${key}:`, error);
    }
  }, KEY_REDACT_DELAY_MS);

  // Don't keep the process alive just for this timer
  timer.unref();

  pendingRedactions.set(key, timer);
}

/**
 * Returns the number of pending key redactions (for monitoring/debugging).
 */
export function getPendingRedactionCount(): number {
  return pendingRedactions.size;
}
