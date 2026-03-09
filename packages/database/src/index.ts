import { PrismaClient } from '@prisma/client';

// Configure Prisma client with enhanced connection handling
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  // Enable query logging in development
  log:
    process.env.NODE_ENV === 'development'
      ? [
          { level: 'query', emit: 'event' },
          { level: 'error', emit: 'event' },
        ]
      : [{ level: 'error', emit: 'event' }],
});

// Handle Prisma query events
if (process.env.NODE_ENV === 'development') {
  prisma.$on('query' as any, (e: any) => {
    console.log('Prisma Query:', e.query);
  });
}

// Handle Prisma error events
prisma.$on('error' as any, (e: any) => {
  console.error('Prisma Error:', e.message);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

export { prisma };
export * from '@prisma/client';
