import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/lib/auth/guards';

// Database-backed integration test for D-023 §6's new
// `listEligibleTravelConsultants` read — this feature previously had no
// service.integration.test.ts (only features/leads and features/staff did).
// Every mocked test elsewhere in this feature (service.test.ts,
// repository.test.ts) mocks Prisma entirely and cannot prove the real
// role/isActive filtering and ordering against an actual PostgreSQL
// database. This file proves it for real, against a dedicated, disposable
// PostgreSQL database — never the shared local `heritage_v3_dev` database.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/leads/service.integration.test.ts and
// features/staff/service.integration.test.ts — see either file's own doc
// comment for the full rationale. In short: no `@/lib/db` or `./service`
// static import; everything real is imported dynamically inside
// `beforeAll` only after `TEST_DATABASE_URL` has been validated; the suite
// is `describe.skipIf`-skipped entirely (no import, no connection)
// whenever `TEST_DATABASE_URL` is unset, which is the default for
// `pnpm test` today.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

/**
 * Parses and validates `TEST_DATABASE_URL` without ever interpolating the
 * raw connection string into a thrown message — a deliberate, self-contained
 * copy of features/leads/service.integration.test.ts's
 * `validateTestDatabaseUrl`, matching that file's own precedent of not
 * sharing this safety guard across feature integration suites.
 */
function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the assignments integration suite.',
    );
  }

  if (!ALLOWED_TEST_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `TEST_DATABASE_URL must use the postgresql:// or postgres:// protocol (got "${parsed.protocol}"). Refusing to proceed.`,
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_TEST_HOSTNAMES.has(hostname)) {
    throw new Error(
      `TEST_DATABASE_URL hostname must be localhost, 127.0.0.1, or ::1 (got "${hostname}"). Refusing to run against a non-local host.`,
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName !== REQUIRED_TEST_DATABASE_NAME) {
    throw new Error(
      `TEST_DATABASE_URL must target the "${REQUIRED_TEST_DATABASE_NAME}" database (got "${databaseName || '(empty)'}"). Refusing to run against any other database, including heritage_v3_dev.`,
    );
  }

  if (!parsed.username) {
    throw new Error('TEST_DATABASE_URL must include a non-empty username. Refusing to proceed.');
  }
}

const rawTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasTestDatabaseUrl = typeof rawTestDatabaseUrl === 'string' && rawTestDatabaseUrl.length > 0;

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;

describe.skipIf(!hasTestDatabaseUrl)('assignments service integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let listEligibleTravelConsultants: (typeof import('./service'))['listEligibleTravelConsultants'];
  let AssignmentError: (typeof import('./errors'))['AssignmentError'];

  let adminActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  const createdUserIds: string[] = [];

  let activeTc1Id: string;
  let activeTc2Id: string;
  let inactiveTcId: string;
  let nonTcStaffId: string;

  beforeAll(async () => {
    validateTestDatabaseUrl(rawTestDatabaseUrl!);

    process.env.DATABASE_URL = rawTestDatabaseUrl;
    if (!process.env.BETTER_AUTH_SECRET) {
      process.env.BETTER_AUTH_SECRET =
        'integration-test-only-secret-not-a-real-credential-0000000000';
      didSetBetterAuthSecret = true;
    }
    if (!process.env.BETTER_AUTH_URL) {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      didSetBetterAuthUrl = true;
    }

    ({ prisma } = await import('@/lib/db'));
    ({ listEligibleTravelConsultants } = await import('./service'));
    ({ AssignmentError } = await import('./errors'));

    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    if (rows[0]?.current_database !== REQUIRED_TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to proceed: the connected database reports current_database() = "${rows[0]?.current_database}", not "${REQUIRED_TEST_DATABASE_NAME}".`,
      );
    }

    const unique = randomUUID();
    adminActor = {
      id: randomUUID(),
      name: `Integration Admin ${unique}`,
      email: `assignments-integration-admin-${unique}@example.test`,
      role: 'ADMIN_MANAGER',
    };
    await prisma.user.create({
      data: { ...adminActor, isActive: true },
    });
    createdUserIds.push(adminActor.id);

    activeTc1Id = randomUUID();
    await prisma.user.create({
      data: {
        id: activeTc1Id,
        name: `Alpha Consultant ${unique}`,
        email: `alpha-tc-${unique}@example.test`,
        role: 'TRAVEL_CONSULTANT',
        isActive: true,
      },
    });
    createdUserIds.push(activeTc1Id);

    activeTc2Id = randomUUID();
    await prisma.user.create({
      data: {
        id: activeTc2Id,
        name: `Zulu Consultant ${unique}`,
        email: `zulu-tc-${unique}@example.test`,
        role: 'TRAVEL_CONSULTANT',
        isActive: true,
      },
    });
    createdUserIds.push(activeTc2Id);

    inactiveTcId = randomUUID();
    await prisma.user.create({
      data: {
        id: inactiveTcId,
        name: `Inactive Consultant ${unique}`,
        email: `inactive-tc-${unique}@example.test`,
        role: 'TRAVEL_CONSULTANT',
        isActive: false,
      },
    });
    createdUserIds.push(inactiveTcId);

    nonTcStaffId = randomUUID();
    await prisma.user.create({
      data: {
        id: nonTcStaffId,
        name: `Finance Staff ${unique}`,
        email: `finance-${unique}@example.test`,
        role: 'FINANCE_ACCOUNTING',
        isActive: true,
      },
    });
    createdUserIds.push(nonTcStaffId);
  });

  afterAll(async () => {
    try {
      if (prisma && createdUserIds.length > 0) {
        try {
          await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
        } finally {
          await prisma.$disconnect();
        }
      }
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
      if (didSetBetterAuthSecret) {
        if (originalBetterAuthSecret === undefined) {
          delete process.env.BETTER_AUTH_SECRET;
        } else {
          process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
        }
      }
      if (didSetBetterAuthUrl) {
        if (originalBetterAuthUrl === undefined) {
          delete process.env.BETTER_AUTH_URL;
        } else {
          process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
        }
      }
    }
  });

  it('returns only active TRAVEL_CONSULTANT accounts, excluding inactive and non-TC staff, ordered by name', async () => {
    const result = await listEligibleTravelConsultants(adminActor, { page: 1, pageSize: 100 });

    const ids = result.items.map((item) => item.id);
    expect(ids).toContain(activeTc1Id);
    expect(ids).toContain(activeTc2Id);
    expect(ids).not.toContain(inactiveTcId);
    expect(ids).not.toContain(nonTcStaffId);

    const alphaIndex = ids.indexOf(activeTc1Id);
    const zuluIndex = ids.indexOf(activeTc2Id);
    expect(alphaIndex).toBeLessThan(zuluIndex);
  });

  it('filters by a case-insensitive search term matching name', async () => {
    const result = await listEligibleTravelConsultants(adminActor, {
      search: 'zulu consultant',
      page: 1,
      pageSize: 100,
    });

    expect(result.items.some((item) => item.id === activeTc2Id)).toBe(true);
    expect(result.items.some((item) => item.id === activeTc1Id)).toBe(false);
  });

  it('rejects a non-ADMIN_MANAGER actor with ROLE_NOT_PERMITTED, never touching the database', async () => {
    const financeActor: AuthenticatedUser = { ...adminActor, role: 'FINANCE_ACCOUNTING' };

    await expect(
      listEligibleTravelConsultants(financeActor, { page: 1, pageSize: 20 }),
    ).rejects.toThrow(AssignmentError);
  });
});
