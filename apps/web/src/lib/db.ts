import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '@/generated/prisma/client';
import { getServerEnv } from '@/lib/env';

// Prisma's generated client (Prisma 7's `prisma-client` generator) requires
// an explicit driver adapter rather than resolving a connection string on
// its own — see apps/web/prisma/schema.prisma and the generated client's
// own usage comment.
//
// Reuse a single PrismaClient/adapter across hot reloads in development;
// otherwise every module reload would open a new connection pool. This is
// the standard Next.js + Prisma singleton pattern.
declare global {
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getServerEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma = globalThis.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}
