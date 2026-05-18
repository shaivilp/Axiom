import { PrismaClient } from '@prisma/client';
import { config, isDev } from '../config.js';
import { logger } from '../logger.js';

export const prisma = new PrismaClient({
  datasources: { db: { url: config.DATABASE_URL } },
  log: isDev ? ['warn', 'error'] : ['error'],
});

// Surface Prisma's initial-connection failure mode through our structured
// logger. Beyond connect-time, query errors propagate to callers.
prisma.$connect().catch((err: unknown) => {
  logger.error({ err }, 'prisma: initial connect failed');
});

export async function closeDb(): Promise<void> {
  await prisma.$disconnect();
}
