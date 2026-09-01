import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Database-backed integration test for D-034 Stage 5d's rate limiter
// (D-037 Section 11), run against the real, migrated `heritage_v3_test`
// schema. Proves, against the actually-installed Prisma 7.8.0 and a real
// PostgreSQL server, exactly what D-037 Section 11 requires before its
// `upsert()`-based design may be relied on: a real concurrent-increment
// test showing no lost updates. Also proves the unknown-source shared
// bucket saturates correctly, and that cleanup only ever removes rows
// outside their own live retention window — properties a mocked
// `@/lib/db` (rate-limit.test.ts) cannot demonstrate.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: mirrors
// features/activation/service.integration.test.ts exactly — no static
// import of `@/lib/db`, `@/lib/env`, or `./rate-limit` (all transitively
// open a real database adapter or validate env at module-import time);
// `process.env.DATABASE_URL` is set to the validated `TEST_DATABASE_URL`
// before any of those modules are ever imported, via a dynamic
// `await import(...)` inside `beforeAll`; skipped entirely when
// TEST_DATABASE_URL is unset, a loud failure (never a silent skip) if set
// but invalid.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the rate-limit integration suite.',
    );
  }
  if (!ALLOWED_TEST_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `TEST_DATABASE_URL must use postgresql:// or postgres:// (got "${parsed.protocol}").`,
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_TEST_HOSTNAMES.has(hostname)) {
    throw new Error(`TEST_DATABASE_URL hostname must be local (got "${hostname}").`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName !== REQUIRED_TEST_DATABASE_NAME) {
    throw new Error(
      `TEST_DATABASE_URL must target "${REQUIRED_TEST_DATABASE_NAME}" (got "${databaseName}").`,
    );
  }
  if (!parsed.username) {
    throw new Error('TEST_DATABASE_URL must include a non-empty username.');
  }
}

const rawTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasTestDatabaseUrl = typeof rawTestDatabaseUrl === 'string' && rawTestDatabaseUrl.length > 0;

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
const originalRateLimitSecret = process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;

describe.skipIf(!hasTestDatabaseUrl)('activation rate limiting (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'];
  let rateLimit: typeof import('./rate-limit');
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;

  const runPrefix = `rl-suite-${randomUUID()}-`;

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
    rateLimit = await import('./rate-limit');
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.rateLimitBucket.deleteMany({ where: { bucketKey: { startsWith: runPrefix } } });
      await prisma.$disconnect();
    }
    if (didSetBetterAuthSecret) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    if (didSetBetterAuthUrl) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
    if (didSetRateLimitSecret) delete process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;
    else process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET = originalRateLimitSecret;
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it(
    'a real concurrent increment against one TOKEN bucket key produces no lost updates ' +
      "(D-037 Section 11's required atomic-upsert evidence)",
    async () => {
      const tokenHash = `${runPrefix}token-${randomUUID()}`;
      const now = new Date('2026-08-28T10:00:00.000Z');
      const CONCURRENCY = 25;

      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENCY }, () => rateLimit.checkTokenRateLimit(tokenHash, now)),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const limitedCount = results.filter(
        (r) => r.status === 'fulfilled' && r.value === true,
      ).length;
      // TOKEN_LIMIT is 10: the 11th-through-25th increments (15 calls) are
      // the ones whose post-increment count exceeds the limit.
      expect(limitedCount).toBe(CONCURRENCY - rateLimit.TOKEN_LIMIT);

      const row = await prisma.rateLimitBucket.findUnique({
        where: {
          dimension_bucketKey_windowStart: {
            dimension: 'TOKEN',
            bucketKey: tokenHash,
            windowStart: new Date(
              Math.floor(now.getTime() / rateLimit.TOKEN_WINDOW_MS) * rateLimit.TOKEN_WINDOW_MS,
            ),
          },
        },
      });
      // Exactly CONCURRENCY increments landed — no lost updates.
      expect(row?.count).toBe(CONCURRENCY);
    },
  );

  it('the unknown-source shared bucket saturates after SOURCE_LIMIT untrusted requests', async () => {
    // The "unknown-source" bucket key is fixed and shared (D-037 Section
    // 11) — it cannot be namespaced per test run the way TOKEN/prefixed
    // keys are. Using a randomized window (rather than a fixed date)
    // keeps repeated runs of this suite from colliding with a prior run's
    // leftover count in the same 15-minute window.
    const now = new Date(
      Date.parse('2020-01-01T00:00:00.000Z') +
        Math.floor(Math.random() * 1_000) * rateLimit.SOURCE_WINDOW_MS,
    );

    // Deliberately sequential: this test proves saturates-after-N-requests
    // ordering, not raw concurrency (covered by the TOKEN test above).
    const outcomes: boolean[] = [];
    for (let i = 0; i < rateLimit.SOURCE_LIMIT + 2; i += 1) {
      outcomes.push(await rateLimit.checkSourceRateLimit({ trusted: false }, now));
    }

    expect(outcomes.slice(0, rateLimit.SOURCE_LIMIT)).toEqual(
      new Array(rateLimit.SOURCE_LIMIT).fill(false),
    );
    expect(outcomes.slice(rateLimit.SOURCE_LIMIT)).toEqual([true, true]);

    // Clean up this test's own contribution to the real shared
    // "unknown-source" bucket key so it doesn't affect any other run.
    await prisma.rateLimitBucket.deleteMany({
      where: {
        dimension: 'SOURCE',
        bucketKey: rateLimit.UNKNOWN_SOURCE_BUCKET_KEY,
        windowStart: new Date(
          Math.floor(now.getTime() / rateLimit.SOURCE_WINDOW_MS) * rateLimit.SOURCE_WINDOW_MS,
        ),
      },
    });
  });

  it('cleanup deletes a real row outside its retention window and never one inside it', async () => {
    const staleBucketKey = `${runPrefix}stale`;
    const freshBucketKey = `${runPrefix}fresh`;
    const staleWindowStart = new Date('2000-01-01T00:00:00.000Z');
    const freshWindowStart = new Date('2026-08-28T09:00:00.000Z');

    await prisma.rateLimitBucket.create({
      data: {
        id: randomUUID(),
        dimension: 'SOURCE',
        bucketKey: staleBucketKey,
        windowStart: staleWindowStart,
        count: 1,
      },
    });
    await prisma.rateLimitBucket.create({
      data: {
        id: randomUUID(),
        dimension: 'SOURCE',
        bucketKey: freshBucketKey,
        windowStart: freshWindowStart,
        count: 1,
      },
    });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // Any check triggers the same cleanup path; the dimension/key used
      // for the check itself is unrelated to the two rows being tested.
      // Uses a run-prefixed TOKEN bucket key (not the shared
      // "unknown-source" key) so its own row is covered by this file's
      // prefix-scoped `afterAll` cleanup rather than leaking a stray row
      // into the real shared bucket.
      await rateLimit.checkTokenRateLimit(
        `${runPrefix}cleanup-trigger`,
        new Date('2026-08-28T09:05:00.000Z'),
      );
    } finally {
      randomSpy.mockRestore();
    }

    const stale = await prisma.rateLimitBucket.findFirst({ where: { bucketKey: staleBucketKey } });
    const fresh = await prisma.rateLimitBucket.findFirst({ where: { bucketKey: freshBucketKey } });
    expect(stale).toBeNull();
    expect(fresh).not.toBeNull();

    await prisma.rateLimitBucket.deleteMany({ where: { bucketKey: freshBucketKey } });
  });
});
