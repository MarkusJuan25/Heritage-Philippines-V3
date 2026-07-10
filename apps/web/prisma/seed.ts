import { randomUUID } from 'node:crypto';

import { hashPassword } from 'better-auth/crypto';

import { prisma } from '../src/lib/db';
import { getServerEnv } from '../src/lib/env';
import { ROLES, type AppRole } from '../src/lib/auth/roles';

// Never run against production — this creates known, fixed-password
// accounts, which must only ever exist in local/disposable environments
// (docs/HERITAGE_V3_ENVIRONMENT_CONFIGURATION.md Section 3).
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run the development seed script against a production environment.');
}

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * A second, independent safeguard alongside the NODE_ENV check above:
 * `pnpm db:seed` runs outside Next.js (via tsx), so NODE_ENV is whatever
 * the invoking shell happens to have — it does not reliably reflect a
 * staging/remote target. This checks the actual DATABASE_URL host instead
 * and refuses anything non-local unless explicitly opted into, so a
 * developer who accidentally points DATABASE_URL at a shared database
 * cannot silently create six known-fixed-password accounts there.
 *
 * Only the hostname is ever inspected or logged — never the full
 * connection string, which may contain a username and password.
 */
function assertLocalDatabaseUnlessOptedIn(databaseUrl: string): void {
  const host = new URL(databaseUrl).hostname;
  const isLocal = LOCAL_DATABASE_HOSTS.has(host);
  const optedIntoRemote = process.env.SEED_ALLOW_REMOTE_DATABASE === 'true';

  if (isLocal || optedIntoRemote) {
    return;
  }

  throw new Error(
    [
      `Refusing to seed a non-local database host ("${host}").`,
      'This script creates known, fixed-password accounts for all six roles and must only run against',
      'a disposable local database by default.',
      'If you deliberately intend to seed a remote development/staging database, set',
      'SEED_ALLOW_REMOTE_DATABASE=true and re-run — see apps/web/.env.example.',
    ].join(' '),
  );
}

// Override via `SEED_USER_PASSWORD` if you want a different local password;
// never a real credential, and never committed.
const SEED_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'ChangeMe123!Dev';

type SeedUser = {
  role: AppRole;
  email: string;
  name: string;
};

// One seed account per blueprint-approved role (blueprint Section 4), so
// every role's login and role-guard behavior can be exercised locally.
const SEED_USERS: SeedUser[] = ROLES.map((role) => ({
  role,
  email: `${role.toLowerCase().replace(/_/g, '.')}@example.test`,
  name: `${role} (seed)`,
}));

async function main() {
  const env = getServerEnv();
  assertLocalDatabaseUnlessOptedIn(env.DATABASE_URL);

  // Created directly via Prisma (bypassing the public sign-up API, which
  // is intentionally disabled per blueprint Section 7 — see
  // src/lib/auth/auth.ts) using Better Auth's own password hashing so the
  // resulting credential is verifiable through the normal sign-in flow.
  const hashedPassword = await hashPassword(SEED_PASSWORD);

  for (const seedUser of SEED_USERS) {
    const existing = await prisma.user.findUnique({ where: { email: seedUser.email } });
    if (existing) {
      console.log(`Skipping ${seedUser.email} — already seeded.`);
      continue;
    }

    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: seedUser.email,
        name: seedUser.name,
        emailVerified: true,
        role: seedUser.role,
        accounts: {
          create: {
            id: randomUUID(),
            accountId: userId,
            providerId: 'credential',
            password: hashedPassword,
          },
        },
      },
    });
    console.log(`Seeded ${seedUser.role} -> ${seedUser.email}`);
  }

  console.log(
    `\nDev seed complete. Sign in with any seeded email above and password: ${SEED_PASSWORD}`,
  );
  console.log('Override the password via the SEED_USER_PASSWORD environment variable.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
