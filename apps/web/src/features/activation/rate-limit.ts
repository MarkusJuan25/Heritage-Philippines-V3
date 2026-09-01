import { createHmac, randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db';
import { getServerEnv } from '@/lib/env';

import type { ResolvedSource } from './source';

// PostgreSQL-backed activation rate limiting (D-037 Section 11), against
// the `RateLimitBucket` table already migrated in Stage 5b (schema-only
// until this stage). Feature-local per `.claude/rules/architecture.md`'s
// rule against a shared abstraction until at least two concrete features
// need it — not placed in `src/lib/`.
//
// Atomic-upsert evidence (D-037 Section 11's own requirement, obtained
// directly against the installed Prisma 7.8.0 before this module was
// written to rely on it): `prisma.rateLimitBucket.upsert()` against this
// table's compound-unique index compiles to exactly one query — a single
// `INSERT ... ON CONFLICT ("dimension","bucketKey","windowStart") DO
// UPDATE SET "count" = ("count" + $n) ... RETURNING "count"` statement,
// captured via Prisma's own query-event log. A live 25-way concurrent
// upsert against one fresh bucket key produced 25 fulfilled writes and a
// final persisted count of exactly 25 — zero lost updates. Both pieces of
// evidence were captured against the real, migrated `heritage_v3_test`
// schema and are reproducible via `rate-limit.integration.test.ts`'s own
// concurrency test below.

type RateLimitDimension = 'SOURCE' | 'TOKEN';

export const SOURCE_LIMIT = 30;
export const SOURCE_WINDOW_MS = 15 * 60 * 1000;
export const TOKEN_LIMIT = 10;
export const TOKEN_WINDOW_MS = 60 * 60 * 1000;
export const UNKNOWN_SOURCE_BUCKET_KEY = 'unknown-source';

// Rows are eligible for deletion once `windowStart` is more than 24 hours
// in the past — far beyond either window's own length (60 minutes, the
// longer of the two), so a row is never deleted while it could still be
// receiving increments.
const RETENTION_MS = 24 * 60 * 60 * 1000;

// This implementation's own choice of "a small fraction of requests"
// (D-037 Section 11 names the mechanism and its shape but not an exact
// value) — low enough that cleanup cost is negligible per request, high
// enough that accumulated rows are reliably reaped under real traffic
// without a separate scheduled job.
const CLEANUP_PROBABILITY = 0.01;

function floorToWindow(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function deriveSourceBucketKey(secret: string, identifier: string): string {
  return createHmac('sha256', secret).update(identifier).digest('hex');
}

/**
 * Injectable-determinism cleanup gate (D-037 Section 11) — tests exercise
 * both branches deterministically by passing a fixed `random` rather than
 * depending on true randomness.
 */
export function shouldRunCleanup(random: () => number = Math.random): boolean {
  return random() < CLEANUP_PROBABILITY;
}

/**
 * Runs strictly after the caller's own rate-limit decision has already
 * been computed and returned — a cleanup failure is caught here and never
 * allowed to alter, delay, or roll back that decision (D-037 Section 11).
 * On failure, logs one fixed, sanitized string only — never the caught
 * error object (which could echo a raw SQL fragment) and never a
 * `bucketKey` (HMAC or token-digest output this contract minimizes
 * exposure of, even though it is not itself secret material).
 */
async function cleanupExpiredBuckets(now: Date): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    await prisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: cutoff } } });
  } catch {
    // Deliberate, minimal, sanitized diagnostic line; see doc comment above.
    console.error('[rate-limit] cleanup failed');
  }
}

/**
 * The atomic increment-and-check primitive shared by both dimensions
 * (D-037 Section 11): `prisma.rateLimitBucket.upsert()` against the
 * table's own compound-unique index, in one round trip. A request is
 * rejected exactly when the post-increment count exceeds `limit` — the
 * request that pushes the count from `limit` to `limit + 1` is itself the
 * first one rejected.
 */
async function incrementAndCheck(
  dimension: RateLimitDimension,
  bucketKey: string,
  windowMs: number,
  limit: number,
  now: Date,
): Promise<boolean> {
  const windowStart = floorToWindow(now, windowMs);
  const updated = await prisma.rateLimitBucket.upsert({
    where: { dimension_bucketKey_windowStart: { dimension, bucketKey, windowStart } },
    create: { id: randomUUID(), dimension, bucketKey, windowStart, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  });
  return updated.count > limit;
}

/**
 * SOURCE-dimension check (D-037 Section 11): 30 requests per 15-minute
 * fixed window. Keyed by `HMAC-SHA256(ACTIVATION_RATE_LIMIT_HMAC_SECRET,
 * identifier)` for a trusted, resolved source, or the fixed shared bucket
 * key `"unknown-source"` otherwise — every environment today, since no
 * trusted-header configuration is authorized yet (Section 12), so all
 * activation traffic currently shares this one bucket. Callers (both POST
 * routes, the GET page) are responsible for running this before any
 * TOKEN-dimension check and before reading the request body (Section 10's
 * ordering) — this function does not itself enforce call order.
 */
export async function checkSourceRateLimit(
  source: ResolvedSource,
  now: Date = new Date(),
): Promise<boolean> {
  const bucketKey = source.trusted
    ? deriveSourceBucketKey(getServerEnv().ACTIVATION_RATE_LIMIT_HMAC_SECRET, source.identifier)
    : UNKNOWN_SOURCE_BUCKET_KEY;
  const limited = await incrementAndCheck('SOURCE', bucketKey, SOURCE_WINDOW_MS, SOURCE_LIMIT, now);
  if (shouldRunCleanup()) {
    await cleanupExpiredBuckets(now);
  }
  return limited;
}

/**
 * TOKEN-dimension check (D-037 Section 11): 10 requests per 60-minute
 * fixed window. Keyed by the same SHA-256 token digest already computed
 * for the invitation lookup — no separate hash — computed and checked
 * whether or not the presented token resolves to a real invitation.
 */
export async function checkTokenRateLimit(
  tokenHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  const limited = await incrementAndCheck('TOKEN', tokenHash, TOKEN_WINDOW_MS, TOKEN_LIMIT, now);
  if (shouldRunCleanup()) {
    await cleanupExpiredBuckets(now);
  }
  return limited;
}
