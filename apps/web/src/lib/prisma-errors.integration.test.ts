import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real-PostgreSQL proof that lib/prisma-errors.ts and
// lib/serializable-transaction.ts recognize the error shapes
// `@prisma/adapter-pg` actually produces — not the pre-adapter shapes the
// mocked tests elsewhere could only assume. Every conflict below is a
// genuine SQLSTATE 40001 or 23505 raised by Postgres itself.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to every
// feature's service.integration.test.ts — no `@/lib/db` or
// `./serializable-transaction` static import; everything real is imported
// dynamically inside `beforeAll` only after `TEST_DATABASE_URL` has been
// validated; the suite is skipped entirely when `TEST_DATABASE_URL` is
// unset. Only `Client`, `User`, `ClientProfile`, and `Proposal` rows this
// suite creates (all tagged) are written, and all are removed in `afterAll`.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the prisma-errors integration suite.',
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
const originalRateLimitSecret = process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;

describe.skipIf(!hasTestDatabaseUrl)('prisma-errors integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let runSerializableWithRetry: (typeof import('./serializable-transaction'))['runSerializableWithRetry'];
  let errors: typeof import('./prisma-errors');
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;
  const tag = `prisma-errors-integration-${randomUUID()}`;
  const createdUserIds: string[] = [];

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
    if (!process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET) {
      process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET =
        'integration-test-only-rl-secret-not-a-real-credential-00000000';
      didSetRateLimitSecret = true;
    }

    ({ prisma } = await import('@/lib/db'));
    ({ runSerializableWithRetry } = await import('./serializable-transaction'));
    errors = await import('./prisma-errors');

    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    if (rows[0]?.current_database !== REQUIRED_TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to proceed: the connected database reports current_database() = "${rows[0]?.current_database}", not "${REQUIRED_TEST_DATABASE_NAME}".`,
      );
    }
  });

  afterAll(async () => {
    try {
      if (prisma) {
        try {
          await prisma.proposal.deleteMany({
            where: { client: { fullName: { startsWith: tag } } },
          });
          await prisma.clientProfile.deleteMany({ where: { userId: { in: createdUserIds } } });
          await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
          await prisma.client.deleteMany({ where: { fullName: { startsWith: tag } } });
        } finally {
          await prisma.$disconnect();
        }
      }
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
      if (didSetBetterAuthSecret) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
      if (didSetBetterAuthUrl) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
      if (didSetRateLimitSecret) delete process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;
      else process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET = originalRateLimitSecret;
    }
  });

  /**
   * A second, independent SERIALIZABLE transaction that reads the same
   * predicate the caller has already read, inserts a row matching it, and
   * commits — the classic write-skew rival. When the caller then inserts its
   * own matching row, Postgres must abort the caller with 40001.
   */
  async function commitRival(fullName: string): Promise<void> {
    await prisma!.$transaction(
      async (tx) => {
        await tx.client.count({ where: { fullName } });
        await tx.client.create({ data: { id: randomUUID(), fullName } });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  it('retries a genuine write conflict and succeeds on a fresh transaction', async () => {
    const fullName = `${tag}-retry-then-succeed`;
    let attempts = 0;

    const result = await runSerializableWithRetry(async (tx) => {
      attempts += 1;
      await tx.client.count({ where: { fullName } });
      if (attempts === 1) await commitRival(fullName);
      await tx.client.create({ data: { id: randomUUID(), fullName } });
      return 'done';
    });

    expect(result).toBe('done');
    expect(attempts).toBe(2);
    // One row from the rival, one from the successful second attempt; the
    // first attempt's insert was rolled back.
    expect(await prisma!.client.count({ where: { fullName } })).toBe(2);
  });

  it('throws SerializableRetriesExhaustedError after exactly three genuine conflicts, wrapping a recognized write conflict', async () => {
    const fullName = `${tag}-always-conflict`;
    let attempts = 0;

    const error = await runSerializableWithRetry(async (tx) => {
      attempts += 1;
      await tx.client.count({ where: { fullName } });
      await commitRival(fullName);
      await tx.client.create({ data: { id: randomUUID(), fullName } });
      return 'unreachable';
    }).catch((caught: unknown) => caught);

    expect(errors.isSerializableRetriesExhausted(error)).toBe(true);
    const exhausted = error as InstanceType<typeof errors.SerializableRetriesExhaustedError>;
    expect(exhausted.attempts).toBe(3);
    expect(errors.isRetryableWriteConflict(exhausted.cause)).toBe(true);
    expect(errors.isResidualDatabaseConflict(error)).toBe(true);
    expect(attempts).toBe(3);
    // Only the three rivals committed; every attempt of the caller rolled back.
    expect(await prisma!.client.count({ where: { fullName } })).toBe(3);
  });

  it('recognizes every write-conflict form Postgres actually raises, at a statement and at COMMIT', async () => {
    const fullName = `${tag}-forms`;
    const seen: unknown[] = [];

    for (let round = 0; round < 4; round += 1) {
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => (release = resolve));
      let reads = 0;
      const racer = () =>
        prisma!.$transaction(
          async (tx) => {
            await tx.client.count({ where: { fullName } });
            reads += 1;
            if (reads === 2) release();
            await bothRead;
            await tx.client.create({ data: { id: randomUUID(), fullName } });
          },
          { isolationLevel: 'Serializable' },
        );
      const results = await Promise.allSettled([racer(), racer()]);
      for (const result of results) {
        if (result.status === 'rejected') seen.push(result.reason);
      }
    }

    expect(seen.length).toBeGreaterThan(0);
    for (const error of seen) {
      expect(errors.isRetryableWriteConflict(error)).toBe(true);
      expect(errors.uniqueViolation(error)).toBeNull();
    }
  });

  it('reads a genuine mixed-case unique violation exactly, matching only its own model and columns, and never retries it', async () => {
    const userId = randomUUID();
    await prisma!.user.create({
      data: { id: userId, name: 'Integration', email: `${tag}@example.test`, role: 'CLIENT' },
    });
    createdUserIds.push(userId);
    const [first, second] = [randomUUID(), randomUUID()];
    await prisma!.client.createMany({
      data: [
        { id: first, fullName: `${tag}-profile-a` },
        { id: second, fullName: `${tag}-profile-b` },
      ],
    });
    await prisma!.clientProfile.create({ data: { id: randomUUID(), userId, clientId: first } });

    let attempts = 0;
    const error = await runSerializableWithRetry(async (tx) => {
      attempts += 1;
      await tx.clientProfile.create({ data: { id: randomUUID(), userId, clientId: second } });
    }).catch((caught: unknown) => caught);

    expect(attempts).toBe(1);
    expect(errors.isSerializableRetriesExhausted(error)).toBe(false);
    expect(errors.isRetryableWriteConflict(error)).toBe(false);
    expect(errors.uniqueViolation(error)).toEqual({
      modelName: 'ClientProfile',
      fields: ['userId'],
    });
    expect(errors.isUniqueViolationOn(error, 'ClientProfile', ['userId'])).toBe(true);
    expect(errors.isUniqueViolationOn(error, 'ClientProfile', ['clientId'])).toBe(false);
    expect(errors.isUniqueViolationOn(error, 'ClientProfile', ['userId', 'clientId'])).toBe(false);
    expect(errors.isUniqueViolationOn(error, 'Booking', ['userId'])).toBe(false);
    expect(errors.isResidualDatabaseConflict(error)).toBe(true);
  });

  it('never retries a genuine CHECK violation or treats it as a conflict, so it stays a generic error (D-055)', async () => {
    const userId = randomUUID();
    await prisma!.user.create({
      data: {
        id: userId,
        name: 'Integration',
        email: `${tag}-check@example.test`,
        role: 'TRAVEL_CONSULTANT',
      },
    });
    createdUserIds.push(userId);
    const clientId = randomUUID();
    await prisma!.client.create({ data: { id: clientId, fullName: `${tag}-check` } });
    const proposalId = randomUUID();
    await prisma!.proposal.create({ data: { id: proposalId, clientId } });

    let attempts = 0;
    const error = await runSerializableWithRetry(async (tx) => {
      attempts += 1;
      // Violates proposal_version_content_nonblank: content must not be blank.
      await tx.proposalVersion.create({
        data: {
          id: randomUUID(),
          proposalId,
          versionNumber: 1,
          createdByUserId: userId,
          content: '   ',
        },
      });
    }).catch((caught: unknown) => caught);

    // The real shape: a raw DriverAdapterError (Postgres 23514), not P2004.
    expect(error).toMatchObject({
      name: 'DriverAdapterError',
      cause: { kind: 'postgres', originalCode: '23514' },
    });
    expect(attempts).toBe(1);
    expect(errors.isRetryableWriteConflict(error)).toBe(false);
    expect(errors.isSerializableRetriesExhausted(error)).toBe(false);
    expect(errors.uniqueViolation(error)).toBeNull();
    expect(errors.isResidualDatabaseConflict(error)).toBe(false);
    expect(await prisma!.proposalVersion.count({ where: { proposalId } })).toBe(0);
  });
});
