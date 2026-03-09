import { prisma } from './index';

/**
 * Execute a database operation with retry logic
 * @param operation - The database operation to execute
 * @param maxRetries - Maximum number of retry attempts
 * @param delayMs - Delay between retries in milliseconds
 * @returns The result of the operation
 */
export async function withDatabaseRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delayMs = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // If it's a Prisma connection error (P1001), retry
      if (
        lastError.message.includes('P1001') ||
        lastError.message.includes("Can't reach database")
      ) {
        console.warn(
          `Database connection error (attempt ${attempt}/${maxRetries + 1}):`,
          lastError.message
        );

        // Don't retry on the last attempt
        if (attempt <= maxRetries) {
          // Exponential backoff
          const backoffDelay = delayMs * Math.pow(2, attempt - 1);
          console.log(`Retrying in ${backoffDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          continue;
        }
      }

      // For other errors, don't retry
      break;
    }
  }

  throw lastError!;
}

/**
 * Test database connection
 * @returns True if connection is successful, false otherwise
 */
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('Database connection test failed:', error);
    return false;
  }
}
