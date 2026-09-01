import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import type { AuthenticatedUser } from '@/lib/auth/guards';

// Database-backed integration test satisfying
// docs/HERITAGE_V3_DECISIONS_LOG.md D-027 §10's real-PostgreSQL integration
// requirement for Proposal / ROS Management: "Admin-versus-Travel-Consultant
// visibility, a genuinely concurrent publish exercising the
// expectedCurrentVersionId mismatch path under real parallel transactions,
// concurrent revision-number allocation under real concurrency, PII-free
// AuditLog rows, and — specifically — a regression test proving that an
// ACCEPT ProposalAcceptance written by this checkpoint's code remains
// correctly visible to features/bookings/repository.ts's existing,
// unmodified findEligibleProposalVersionForActor/hasAcceptedAcceptance
// check, since Booking's own creation eligibility already depends on this
// exact table." Every mocked test elsewhere in this feature
// (schemas.test.ts, errors.test.ts, audit.test.ts, repository.test.ts,
// service.test.ts, http.test.ts, the five apps/web/src/app/api/proposals/**
// route.test.ts files) intentionally mocks Prisma and/or
// features/assignments — none of them can prove the real
// transactional/concurrency/constraint/cross-feature behavior against an
// actual PostgreSQL database with real foreign-key/CHECK/partial-unique-
// index constraints. This file proves it for real, against a dedicated,
// disposable PostgreSQL database — never the shared local `heritage_v3_dev`
// database — using this feature's own real, unmodified `service.ts`
// exports and, for the Booking-eligibility regression, features/bookings/
// repository.ts's own real, unmodified `findEligibleProposalVersionForActor`.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/leads/service.integration.test.ts, features/clients/service.
// integration.test.ts, features/assignments/service.integration.test.ts,
// and features/staff/service.integration.test.ts — see any of those files'
// own doc comment for the full rationale. In short: no `@/lib/db` or
// `./service` static import; everything real is imported dynamically inside
// `beforeAll` only after `TEST_DATABASE_URL` has been validated; the suite
// is `describe.skipIf`-skipped entirely (no import, no connection) whenever
// `TEST_DATABASE_URL` is unset, which is the default for `pnpm test` today.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

/**
 * Parses and validates `TEST_DATABASE_URL` without ever interpolating the
 * raw connection string into a thrown message — a deliberate, self-contained
 * copy of the identical guard already established in features/leads/,
 * features/clients/, features/assignments/, and features/staff/'s own
 * service.integration.test.ts files, not a shared import, matching those
 * files' own precedent of not sharing this safety guard across feature
 * integration suites.
 */
function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the proposals integration suite.',
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

// Captured before any mutation, mirroring every existing integration
// suite's identical discipline, so `afterAll` can restore the process
// environment exactly as it found it — this file runs inside a shared
// Vitest worker process, and `process.env` mutations are not automatically
// isolated per test file.
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
// D-034 Stage 5d (D-037 Section 11): getServerEnv()'s shared schema now
// also requires ACTIVATION_RATE_LIMIT_HMAC_SECRET, for the same reason
// BETTER_AUTH_SECRET/URL are required here above.
const originalRateLimitSecret = process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;

describe.skipIf(!hasTestDatabaseUrl)('proposals service integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let createProposal: (typeof import('./service'))['createProposal'];
  let listProposals: (typeof import('./service'))['listProposals'];
  let getProposalById: (typeof import('./service'))['getProposalById'];
  let createProposalRevision: (typeof import('./service'))['createProposalRevision'];
  let publishProposalVersion: (typeof import('./service'))['publishProposalVersion'];
  let recordProposalResponse: (typeof import('./service'))['recordProposalResponse'];
  let findEligibleProposalVersionForActor: (typeof import('@/features/bookings/repository'))['findEligibleProposalVersionForActor'];

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;
  let otherTcActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;
  const actorUserIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdProposalIds: string[] = [];

  beforeAll(async () => {
    // 1. Safety guard — must run before any env mutation, import, or
    // connection.
    validateTestDatabaseUrl(rawTestDatabaseUrl!);

    // 2. Establish the environment the real modules will read at import
    // time. `@/lib/db` transitively calls `@/lib/env`'s `getServerEnv()`,
    // which validates the full shared server env schema — including
    // BETTER_AUTH_SECRET/BETTER_AUTH_URL, even though this suite never
    // calls into Better Auth itself — so both must be present before
    // `@/lib/db` is ever imported, exactly as every existing integration
    // suite already established.
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

    // 3. Only now — dynamically — import the real, unmocked application
    // modules.
    ({ prisma } = await import('@/lib/db'));
    ({
      createProposal,
      listProposals,
      getProposalById,
      createProposalRevision,
      publishProposalVersion,
      recordProposalResponse,
    } = await import('./service'));
    ({ findEligibleProposalVersionForActor } = await import('@/features/bookings/repository'));

    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    if (rows[0]?.current_database !== REQUIRED_TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to proceed: the connected database reports current_database() = "${rows[0]?.current_database}", not "${REQUIRED_TEST_DATABASE_NAME}".`,
      );
    }

    async function createStaffFixture(
      role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT',
    ): Promise<AuthenticatedUser> {
      const id = randomUUID();
      const email = `proposals-integration-${role.toLowerCase()}-${randomUUID()}@example.test`;
      const name = `Integration ${role}`;
      await prisma!.user.create({ data: { id, name, email, role, isActive: true } });
      actorUserIds.push(id);
      return { id, name, email, role };
    }

    adminActor = await createStaffFixture('ADMIN_MANAGER');
    tcActor = await createStaffFixture('TRAVEL_CONSULTANT');
    otherTcActor = await createStaffFixture('TRAVEL_CONSULTANT');
  });

  afterAll(async () => {
    try {
      if (prisma) {
        try {
          // Deletion order respects onDelete: Restrict throughout
          // schema.prisma — ProposalAcceptance references ProposalVersion;
          // ProposalVersion references Proposal and User
          // (createdByUserId); Proposal references Client; StaffAssignment
          // references Client and the assigning/assigned User; AuditLog
          // references the actor User. Deepest dependents are removed
          // first.
          if (createdProposalIds.length > 0) {
            await prisma.proposalAcceptance.deleteMany({
              where: { proposalVersion: { proposalId: { in: createdProposalIds } } },
            });
            await prisma.proposalVersion.deleteMany({
              where: { proposalId: { in: createdProposalIds } },
            });
          }
          await prisma.staffAssignment.deleteMany({
            where: {
              OR: [
                { clientId: { in: createdClientIds } },
                { assignedStaffId: { in: actorUserIds } },
              ],
            },
          });
          await prisma.auditLog.deleteMany({ where: { actorId: { in: actorUserIds } } });
          if (createdProposalIds.length > 0) {
            await prisma.proposal.deleteMany({ where: { id: { in: createdProposalIds } } });
          }
          if (createdClientIds.length > 0) {
            await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
          }
          await prisma.user.deleteMany({ where: { id: { in: actorUserIds } } });
        } finally {
          await prisma.$disconnect();
        }
      }
    } finally {
      // Restored unconditionally — even when `prisma` was never assigned
      // (e.g. `validateTestDatabaseUrl` threw) or when cleanup above throws
      // — so this suite never leaves a stale
      // DATABASE_URL/BETTER_AUTH_SECRET/BETTER_AUTH_URL behind in the
      // shared Vitest worker's process environment.
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
      if (didSetRateLimitSecret) {
        if (originalRateLimitSecret === undefined) {
          delete process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;
        } else {
          process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET = originalRateLimitSecret;
        }
      }
    }
  });

  // --- Shared fixture helpers ---

  /** Inserts a standalone Client row directly (D-027 introduces no Client
   * creation path of its own) — tracked for cleanup. */
  async function createClientFixture(fullName: string): Promise<{ id: string; fullName: string }> {
    const id = randomUUID();
    await prisma!.client.create({
      data: { id, fullName, email: `proposals-integration-${randomUUID()}@example.test` },
    });
    createdClientIds.push(id);
    return { id, fullName };
  }

  /** Inserts an active StaffAssignment linking `staffId` to `clientId`
   * directly — mirrors every existing integration suite's identical
   * "insert the assignment fixture directly, never through the untouched
   * features/assignments module" precedent. */
  async function assignClientToStaff(clientId: string, staffId: string): Promise<void> {
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: staffId,
        assignedByUserId: adminActor.id,
        clientId,
      },
    });
  }

  // --- Deterministic real-concurrency proof helpers (Stage 6 correction) ---
  // Neither helper mocks a transaction result or an authorization outcome
  // — both only observe or pause real, unmodified Prisma/PostgreSQL
  // execution, always restored/released by the caller in a `finally`
  // block, so a failed assertion can never hang the suite.

  /**
   * Polls `pg_stat_activity`/`pg_blocking_pids()` — real PostgreSQL system
   * catalog functions, never a fixed delay — until at least
   * `expectedBlockedCount` distinct backend PIDs are observed to be
   * genuinely blocked specifically on `blockerPid`'s held row lock, or
   * throws after `timeoutMs`. This is deterministic, database-level proof
   * (not a JS-scheduling assumption) that the awaited real service
   * transactions are simultaneously in flight and contending for the
   * exact row our blocker connection holds, before that blocker is ever
   * released. The short poll interval only detects an already-true
   * condition as soon as possible — it never manufactures the condition,
   * unlike a fixed `setTimeout`-based wait.
   */
  async function waitUntilBlockedOn(
    blockerPid: number,
    expectedBlockedCount: number,
    timeoutMs = 10000,
  ): Promise<number[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await prisma!.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
      `;
      const distinctPids = Array.from(new Set(rows.map((row) => Number(row.pid))));
      if (distinctPids.length >= expectedBlockedCount) {
        return distinctPids;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${expectedBlockedCount} backend(s) to block on pid ${blockerPid} (observed ${distinctPids.length}).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  type PrismaTransactionMethod = NonNullable<typeof prisma>['$transaction'];

  /**
   * A narrow, test-only interception of the real `prisma.$transaction`
   * method — never a mock of its result, and never a mock of any
   * authorization decision. On exactly its first invocation, it signals
   * `paused` (so the test knows the real caller has finished everything
   * that runs *before* opening its transaction — e.g. service.ts's
   * pre-transaction `assertProposalAuthorAccess` check against the plain
   * `prisma` singleton) and then awaits `release()` before delegating,
   * completely unchanged, to the original `$transaction` method with the
   * original arguments. Every subsequent invocation (e.g. a later retry
   * attempt) passes straight through, unpaused. `original` is invoked via
   * `Reflect.apply` against the real `prisma` receiver (Stage 6 Correction
   * Pass 3, Part 3) rather than relying on a pre-bound copy, so the caller
   * only ever needs to capture and restore the exact, raw, unbound
   * `prisma.$transaction` method reference — never a `.bind(...)` copy of
   * it — onto `prisma.$transaction`.
   */
  function createSingleTransactionPauseGate() {
    let intercepted = false;
    let releaseGate!: () => void;
    const gateReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalPaused!: () => void;
    const pausedSignal = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });

    function wrap(original: PrismaTransactionMethod): PrismaTransactionMethod {
      const wrapped = (async (...args: Parameters<PrismaTransactionMethod>) => {
        if (!intercepted) {
          intercepted = true;
          signalPaused();
          await gateReleased;
        }
        return Reflect.apply(original as (...callArgs: unknown[]) => unknown, prisma!, args);
      }) as PrismaTransactionMethod;
      return wrapped;
    }

    return { wrap, paused: pausedSignal, release: () => releaseGate() };
  }

  /**
   * Polls `pg_stat_activity`/`pg_blocking_pids()` — real PostgreSQL, never
   * a fixed delay — until `waiterPid` is observed specifically blocked on
   * `blockerPid` (i.e. `blockerPid = ANY(pg_blocking_pids(waiterPid))`),
   * returning that row's own `wait_event_type`, `wait_event`, and `query`
   * text for the caller to assert against, or throws after `timeoutMs`.
   * Unlike an "any transaction block" query, this only ever looks at the
   * two specific, already-captured backend pids belonging to this
   * fixture's own two real transactions — never any other backend that
   * happens to be blocked in the database. It is only ever called once the
   * setup around it has already made the block inevitable (Stage 6
   * Correction Pass 2, Part A), so this poll is confirming an already-true
   * fact as soon as possible, not hoping for a coincidence — the bound
   * only needs to cover ordinary scheduling latency.
   */
  async function waitUntilBlockedOnSpecificPid(
    waiterPid: number,
    blockerPid: number,
    timeoutMs: number,
  ): Promise<{ wait_event_type: string | null; wait_event: string | null; query: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await prisma!.$queryRaw<
        { wait_event_type: string | null; wait_event: string | null; query: string }[]
      >`
        SELECT wait_event_type, wait_event, query
        FROM pg_stat_activity
        WHERE pid = ${waiterPid} AND ${blockerPid} = ANY(pg_blocking_pids(pid))
      `;
      if (rows[0]) {
        return rows[0];
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for pid ${waiterPid} to block specifically on pid ${blockerPid}.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * A narrow, test-only interception of the real `prisma.$transaction`
   * method, used only by the deterministic revision-concurrency proof
   * below (Stage 6 Correction Pass 2, Part A; extended in Stage 6
   * Correction Pass 3 with a genuine post-callback readiness signal —
   * replaces the prior bounded-retry design entirely, which relied on two
   * independently-scheduled real calls merely happening to overlap).
   * Never mocks a query result, a transaction result, or an authorization
   * outcome: on every invocation it, in this exact order, (a) reads the
   * transaction's own real `pg_backend_pid()` via `tx.$queryRaw` — an
   * unmodified, read-only introspection query — the instant the
   * transaction opens (exposed via `pid`, but this alone is never treated
   * as proof the real callback has completed), (b) runs and awaits the
   * real, unmodified callback to genuine completion — the real
   * `MAX(versionNumber)` read, the real INSERT, and the real audit INSERT
   * all genuinely execute here, (c) only once that callback has actually
   * resolved, signals `pausedAfterCallback` (exposed to the caller), and
   * (d), only when `pauseAfterCallback` is true, delays returning the
   * callback's already-fully-resolved real result back to Prisma — the
   * moment Prisma would otherwise COMMIT — until `release()` is called.
   * Holding open a transaction whose real work has already genuinely
   * executed, uncommitted, is what makes a second real transaction's own
   * real INSERT deterministically block on it, by construction — but only
   * once a caller has actually awaited `pausedAfterCallback`, never merely
   * `pid`, since `pid` alone resolves before the real work has even begun.
   * `timeoutMs` is merged into the original call's own options,
   * overriding Prisma's default 5000ms interactive-transaction timeout,
   * which would otherwise abort a deliberately-held-open transaction out
   * from under this test. `original` — the exact, raw, unbound
   * `prisma.$transaction` method reference the caller captured — is
   * invoked via `Reflect.apply` against the real `prisma` receiver (Stage
   * 6 Correction Pass 3, Part 3), never via a pre-bound copy.
   */
  function createPidCapturingTransactionWrapper(
    original: PrismaTransactionMethod,
    pauseAfterCallback: boolean,
    timeoutMs: number,
  ): {
    transactionMethod: PrismaTransactionMethod;
    pid: Promise<number>;
    pausedAfterCallback: Promise<void>;
    release: () => void;
  } {
    let capturePid!: (pid: number) => void;
    const pidCaptured = new Promise<number>((resolve) => {
      capturePid = resolve;
    });
    let signalPausedAfterCallback!: () => void;
    const pausedAfterCallbackSignal = new Promise<void>((resolve) => {
      signalPausedAfterCallback = resolve;
    });
    let releaseHold!: () => void;
    const holdReleased = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const wrapped = (async (...args: Parameters<PrismaTransactionMethod>) => {
      const [fn, callOptions] = args as unknown as [
        (tx: Prisma.TransactionClient) => Promise<unknown>,
        Record<string, unknown> | undefined,
      ];
      const wrappedFn = async (tx: Prisma.TransactionClient) => {
        // Capture the backend pid at transaction start — real, but never
        // itself treated as proof the callback below has completed.
        const pidRows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        capturePid(Number(pidRows[0]?.pid));

        // Run and await the complete real callback — the real MAX read,
        // the real ProposalVersion insert, and the real audit insert.
        const result = await fn(tx);

        // Only now, after the real callback has genuinely finished, do we
        // signal readiness and (when configured) hold open before
        // returning to Prisma/commit.
        signalPausedAfterCallback();
        if (pauseAfterCallback) {
          await holdReleased;
        }
        return result;
      };
      return Reflect.apply(original as (...callArgs: unknown[]) => unknown, prisma!, [
        wrappedFn,
        { ...callOptions, timeout: timeoutMs },
      ]);
    }) as PrismaTransactionMethod;

    return {
      transactionMethod: wrapped,
      pid: pidCaptured,
      pausedAfterCallback: pausedAfterCallbackSignal,
      release: () => releaseHold(),
    };
  }

  // ---------------------------------------------------------------------
  // Group A — Creation & author authorization
  // ---------------------------------------------------------------------

  it('creates a Proposal and its first ProposalVersion for an assigned TRAVEL_CONSULTANT, writing exactly one PII/content-free PROPOSAL_CREATED audit row', async () => {
    const client = await createClientFixture('Creation Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal, version } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Day 1: Arrival at Manila. Day 2: Palawan island hopping.',
    });
    createdProposalIds.push(proposal.id);

    expect(proposal.clientId).toBe(client.id);
    expect(version.versionNumber).toBe(1);
    expect(version.createdByUserId).toBe(tcActor.id);
    expect(version.clientVisibleAt).toBeNull();
    expect(version.supersededAt).toBeNull();

    const versionRow = await prisma!.proposalVersion.findUnique({ where: { id: version.id } });
    expect(versionRow?.content).toBe('Day 1: Arrival at Manila. Day 2: Palawan island hopping.');

    const audits = await prisma!.auditLog.findMany({
      where: { entityType: 'Proposal', entityId: proposal.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('PROPOSAL_CREATED');
    expect(audits[0]?.actorId).toBe(tcActor.id);
    expect(audits[0]?.afterState).toEqual({
      clientId: client.id,
      firstVersionId: version.id,
      firstVersionNumber: 1,
    });
    expect(JSON.stringify(audits[0]?.afterState)).not.toContain('Palawan island hopping');

    // No separate PROPOSAL_VERSION_CREATED entry for the first version
    // (D-027 §2's audit contract).
    expect(
      await prisma!.auditLog.count({
        where: {
          entityType: 'ProposalVersion',
          entityId: version.id,
          action: 'PROPOSAL_VERSION_CREATED',
        },
      }),
    ).toBe(0);
  });

  it('rejects an unassigned TRAVEL_CONSULTANT with CLIENT_FORBIDDEN before any write, leaving no Proposal or audit row', async () => {
    const client = await createClientFixture('Unassigned Creation Client');
    // Deliberately no assignment for otherTcActor to this Client.

    await expect(
      createProposal(otherTcActor, { clientId: client.id, content: 'Attempted content.' }),
    ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });

    expect(await prisma!.proposal.count({ where: { clientId: client.id } })).toBe(0);
    expect(
      await prisma!.auditLog.count({
        where: { actorId: otherTcActor.id, action: 'PROPOSAL_CREATED' },
      }),
    ).toBe(0);
  });

  it('rejects a revision request with PROPOSAL_FORBIDDEN via the real transaction-local recheck when the assignment ends while the request is genuinely paused mid-flight, after its pre-transaction check already succeeded', async () => {
    const client = await createClientFixture('Auth Race Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Initial content before the race.',
    });
    createdProposalIds.push(proposal.id);

    // Scoped baseline (Correction 4) — never a global count, which would
    // be fragile against other tests' or pre-existing rows' own
    // PROPOSAL_VERSION_CREATED audits. Scoped to this test's own fixture
    // actor, which is itself unique to this single suite invocation.
    const versionCountBefore = await prisma!.proposalVersion.count({
      where: { proposalId: proposal.id },
    });
    const auditCountBefore = await prisma!.auditLog.count({
      where: {
        entityType: 'ProposalVersion',
        action: 'PROPOSAL_VERSION_CREATED',
        actorId: tcActor.id,
      },
    });

    const gate = createSingleTransactionPauseGate();
    // The exact, raw, unbound original method reference (Stage 6
    // Correction Pass 3, Part 3) — never a `.bind(...)` copy — so
    // `finally` below restores `prisma.$transaction` to the identical
    // reference it started as. `createSingleTransactionPauseGate`'s own
    // `wrap` invokes it via `Reflect.apply` against the real `prisma`
    // receiver, so the missing binding is never a correctness problem.
    const originalTransaction = prisma!.$transaction;
    // Test-only, finally-restored interception of the real Prisma Client
    // instance method — delegates unchanged arguments to the exact
    // original method; never mocks the transaction's result or any
    // authorization outcome (see createSingleTransactionPauseGate's own
    // doc comment above).
    prisma!.$transaction = gate.wrap(originalTransaction);

    // Declared outside the try block (Stage 6 Correction Pass 2, Part B) so
    // `finally` can always settle it, even if an earlier step in `try`
    // throws before the revision call's own outcome is ever awaited.
    let revisionPromise: ReturnType<typeof createProposalRevision> | undefined;

    try {
      revisionPromise = createProposalRevision(tcActor, proposal.id, {
        content: 'Attempted while assignment ends mid-flight.',
      });

      // The real call has now finished its pre-transaction check — which
      // succeeded, since the assignment is still active at this exact
      // moment — and is genuinely paused immediately before its real
      // SERIALIZABLE transaction (and therefore its transaction-local
      // recheck) begins. Raced against the revision call rejecting outright
      // (an unexpected precheck failure would otherwise leave `gate.paused`
      // never resolving) and a bounded timeout, so a genuine failure here
      // surfaces as a real, fast assertion failure instead of hanging the
      // suite indefinitely.
      await Promise.race([
        gate.paused,
        revisionPromise.then(() => {
          throw new Error(
            'The revision call resolved before its transaction was ever paused — the pause gate did not engage as expected.',
          );
        }),
        new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                new Error('Timed out waiting for the revision call to pause mid-transaction.'),
              ),
            5000,
          );
        }),
      ]);

      // A separate, real database write ends the assignment while the
      // request is paused — deterministic, not timing-dependent: this
      // update is guaranteed to commit before the paused request is ever
      // released.
      await prisma!.staffAssignment.updateMany({
        where: { clientId: client.id, assignedStaffId: tcActor.id, endedAt: null },
        data: { endedAt: new Date() },
      });

      gate.release();

      // The real transaction-local recheck — running now, inside the real
      // transaction that only just began — observes the now-ended
      // assignment and rejects, proving the recheck itself, not merely
      // the already-passed pre-transaction check.
      await expect(revisionPromise).rejects.toMatchObject({ code: 'PROPOSAL_FORBIDDEN' });
    } finally {
      // Always released and restored, and the revision promise is always
      // settled — even when an earlier step above threw — so no service
      // operation and no dangling unhandled rejection outlives this test.
      gate.release();
      prisma!.$transaction = originalTransaction;
      await revisionPromise?.catch(() => {});
    }

    expect(await prisma!.proposalVersion.count({ where: { proposalId: proposal.id } })).toBe(
      versionCountBefore,
    );
    expect(
      await prisma!.auditLog.count({
        where: {
          entityType: 'ProposalVersion',
          action: 'PROPOSAL_VERSION_CREATED',
          actorId: tcActor.id,
        },
      }),
    ).toBe(auditCountBefore);
  });

  // ---------------------------------------------------------------------
  // Group B — Admin-versus-Travel-Consultant visibility
  // ---------------------------------------------------------------------

  it('gives ADMIN_MANAGER unconditional list/detail visibility, the assigned TC matching visibility, and rejects an unassigned TC with PROPOSAL_FORBIDDEN (never a leaked 404)', async () => {
    const client = await createClientFixture('Visibility Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Visibility scenario content.',
    });
    createdProposalIds.push(proposal.id);

    const adminDetail = await getProposalById(adminActor, proposal.id);
    expect(adminDetail.id).toBe(proposal.id);
    expect(adminDetail.client.id).toBe(client.id);

    const tcDetail = await getProposalById(tcActor, proposal.id);
    expect(tcDetail.id).toBe(proposal.id);

    await expect(getProposalById(otherTcActor, proposal.id)).rejects.toMatchObject({
      code: 'PROPOSAL_FORBIDDEN',
      status: 403,
    });

    const { items: adminItems } = await listProposals(adminActor, { page: 1, pageSize: 200 });
    expect(adminItems.some((item) => item.id === proposal.id)).toBe(true);

    const { items: tcItems } = await listProposals(tcActor, { page: 1, pageSize: 200 });
    expect(tcItems.some((item) => item.id === proposal.id)).toBe(true);

    const { items: otherTcItems } = await listProposals(otherTcActor, { page: 1, pageSize: 200 });
    expect(otherTcItems.some((item) => item.id === proposal.id)).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Group C — Revision allocation and content persistence
  // ---------------------------------------------------------------------

  it('proves two real, simultaneously in-flight revision-creation transactions via genuine, deterministic PostgreSQL lock contention on the composite unique index (verified through pg_blocking_pids() against the two specifically-captured backend pids), resolving to unique sequential versionNumbers 2 and 3 with two audit rows', async () => {
    // Empirically verified real contention point (confirmed directly
    // against heritage_v3_test via `pg_stat_activity`, not assumed): when
    // two real createProposalRevision transactions both read
    // `MAX(versionNumber)` before either has committed, both compute the
    // identical next versionNumber and then genuinely race on
    // ProposalVersion's own `@@unique([proposalId, versionNumber])`
    // index — PostgreSQL makes the second real INSERT block on the
    // first's still-open transaction (a `Lock transactionid` wait,
    // visible in `pg_blocking_pids()`) until it commits or rolls back.
    // Rather than launching both real calls independently and hoping
    // Node's own event-loop/connection-pool scheduling aligns them
    // closely enough (empirically unreliable inside Vitest across many
    // runs, unlike a bare script), this test makes the block
    // deterministic by construction: the first real transaction
    // ("holder") is allowed to run its entire real callback — the real
    // MAX(versionNumber) read, the real INSERT, the real audit INSERT —
    // to genuine completion, uncommitted, and is only then paused before
    // returning (delaying Prisma's own COMMIT). Only once that is
    // confirmed does the second real transaction ("waiter") begin — its
    // own real MAX(versionNumber) read still sees the pre-holder state,
    // so its own real INSERT is guaranteed to attempt the identical
    // versionNumber and therefore to genuinely, mechanically block on the
    // holder's still-open row. No transaction result, query result, or
    // authorization outcome is ever mocked — every value asserted below
    // comes from the real, unmodified service and repository code.
    const client = await createClientFixture('Deterministic Concurrent Revision Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Version 1 content.',
    });
    createdProposalIds.push(proposal.id);

    // The exact, raw, unbound original method reference (Stage 6
    // Correction Pass 3, Part 3) — never a `.bind(...)` copy — so both
    // restores below put `prisma.$transaction` back to the identical
    // reference it started as. `createPidCapturingTransactionWrapper`
    // invokes it via `Reflect.apply` against the real `prisma` receiver,
    // so the missing binding is never a correctness problem.
    const originalTransaction = prisma!.$transaction;
    const holderWrapper = createPidCapturingTransactionWrapper(originalTransaction, true, 15000);

    let firstPromise: ReturnType<typeof createProposalRevision> | undefined;
    let secondPromise: ReturnType<typeof createProposalRevision> | undefined;

    try {
      // Transaction A ("the holder").
      prisma!.$transaction = holderWrapper.transactionMethod;
      firstPromise = createProposalRevision(tcActor, proposal.id, {
        content: 'Concurrent revision A (holder).',
      });

      // Awaits the holder's GENUINE post-callback readiness signal —
      // never merely `pid` (which resolves the instant the transaction
      // opens, before the real MAX read/INSERT/audit-insert have even
      // run) — before transaction B is ever started. Raced against the
      // holder call unexpectedly resolving or rejecting (either of which
      // would mean the pause never engaged as expected) and a bounded
      // timeout, so an unexpected failure surfaces immediately rather
      // than hanging.
      await Promise.race([
        holderWrapper.pausedAfterCallback,
        firstPromise.then(
          () => {
            throw new Error(
              'The holder revision call resolved before its transaction was ever paused — the pause-after-callback wrapper did not engage as expected.',
            );
          },
          (error: unknown) => {
            throw error instanceof Error
              ? error
              : new Error(
                  'The holder revision call rejected before its transaction was ever paused.',
                );
          },
        ),
        new Promise<void>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('Timed out waiting for the holder transaction to pause.')),
            10000,
          );
        }),
      ]);

      // The holder's real callback — the real MAX read, the real INSERT,
      // the real audit INSERT — has now genuinely completed, uncommitted,
      // and the holder is genuinely paused immediately before returning
      // to Prisma/commit. Its pid was captured at transaction start,
      // strictly before that completion, so it is already settled here.
      const holderPid = await holderWrapper.pid;

      // Only now — deterministically, never a race — is the second real
      // transaction ("the waiter") triggered.
      const waiterWrapper = createPidCapturingTransactionWrapper(originalTransaction, false, 15000);
      prisma!.$transaction = waiterWrapper.transactionMethod;
      secondPromise = createProposalRevision(tcActor, proposal.id, {
        content: 'Concurrent revision B (waiter).',
      });

      // Races pid acquisition against the waiter call unexpectedly
      // resolving, rejecting, and a bounded timeout — no early settlement
      // of `secondPromise` may go unobserved while this awaits the pid.
      const waiterPid = await Promise.race([
        waiterWrapper.pid,
        secondPromise.then(
          () => {
            throw new Error(
              'The waiter revision call resolved before its transaction pid could be captured — unexpected.',
            );
          },
          (error: unknown) => {
            throw error instanceof Error
              ? error
              : new Error(
                  'The waiter revision call rejected before its transaction pid could be captured.',
                );
          },
        ),
        new Promise<number>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(new Error('Timed out waiting for the waiter transaction pid to be captured.')),
            10000,
          );
        }),
      ]);

      // Both real transactions' pids are now captured — restore the
      // original method before verifying; no further interception is
      // needed, and any later outer-retry attempt (e.g. the waiter's own
      // collision retry once it unblocks) must run unintercepted.
      prisma!.$transaction = originalTransaction;

      // Deterministic verification — confirming an outcome the setup
      // above already guarantees, against the two specific pids captured
      // for this fixture's own two real transactions (never "any"
      // blocked backend): a genuine Lock/transactionid wait, on the real
      // proposal_version insertion path, before either result below is
      // ever asserted.
      const blockRow = await waitUntilBlockedOnSpecificPid(waiterPid, holderPid, 5000);
      expect(blockRow.wait_event_type).toBe('Lock');
      expect(blockRow.wait_event).toBe('transactionid');
      expect(blockRow.query.toLowerCase()).toContain('insert');
      expect(blockRow.query.toLowerCase()).toContain('proposal_version');

      holderWrapper.release();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first.versionNumber).not.toBe(second.versionNumber);
      expect([first.versionNumber, second.versionNumber].sort()).toEqual([2, 3]);

      const allVersions = await prisma!.proposalVersion.findMany({
        where: { proposalId: proposal.id },
        select: { versionNumber: true },
      });
      // No duplicate, no gap: exactly versionNumbers 1, 2, 3 exist.
      expect(allVersions.map((v) => v.versionNumber).sort()).toEqual([1, 2, 3]);

      const versionAudits = await prisma!.auditLog.count({
        where: {
          entityType: 'ProposalVersion',
          action: 'PROPOSAL_VERSION_CREATED',
          entityId: { in: [first.id, second.id] },
        },
      });
      expect(versionAudits).toBe(2);
    } finally {
      // Always restored and released, and both promises (if started) are
      // always settled — even when an earlier step above throws — so no
      // service operation and no dangling unhandled rejection outlives
      // this test.
      prisma!.$transaction = originalTransaction;
      holderWrapper.release();
      await Promise.allSettled(
        [firstPromise, secondPromise].filter((p): p is NonNullable<typeof p> => p !== undefined),
      );
    }
  }, 30000);

  it('enforces the proposal_version_content_nonblank CHECK constraint at the database level, independent of the service, permitting NULL but rejecting whitespace-only content', async () => {
    const client = await createClientFixture('Constraint Client');
    const proposal = await prisma!.proposal.create({
      data: { id: randomUUID(), clientId: client.id },
    });
    createdProposalIds.push(proposal.id);

    // A raw NULL content insert is permitted (legacy-row compatibility,
    // D-027 §1) — this bypasses the service entirely, proving the database
    // constraint itself, not the service's own validation.
    const nullVersion = await prisma!.proposalVersion.create({
      data: {
        id: randomUUID(),
        proposalId: proposal.id,
        versionNumber: 1,
        content: null,
        createdByUserId: adminActor.id,
      },
    });
    expect(nullVersion.content).toBeNull();

    // A raw whitespace-only content insert is rejected by the CHECK
    // constraint itself.
    await expect(
      prisma!.proposalVersion.create({
        data: {
          id: randomUUID(),
          proposalId: proposal.id,
          versionNumber: 2,
          content: '   ',
          createdByUserId: adminActor.id,
        },
      }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // Group D — Publishing: idempotency, supersession, concurrency, and the
  // partial unique index
  // ---------------------------------------------------------------------

  it('treats a re-publish of the already-current version as an idempotent no-op — succeeding even with a stale or null expectedCurrentVersionId, writing no new audit', async () => {
    const client = await createClientFixture('Idempotent Publish Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal, version } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Idempotent publish content.',
    });
    createdProposalIds.push(proposal.id);

    const published = await publishProposalVersion(tcActor, version.id, {
      expectedCurrentVersionId: null,
    });
    expect(published.clientVisibleAt).not.toBeNull();
    expect(published.supersededAt).toBeNull();

    const auditCountAfterFirstPublish = await prisma!.auditLog.count({
      where: {
        entityType: 'ProposalVersion',
        entityId: version.id,
        action: 'PROPOSAL_VERSION_PUBLISHED',
      },
    });
    expect(auditCountAfterFirstPublish).toBe(1);

    // Stale, non-matching expectedCurrentVersionId — still succeeds, since
    // the target is already current (D-027 §5's idempotent-no-op-first
    // ordering).
    const replayWithStale = await publishProposalVersion(tcActor, version.id, {
      expectedCurrentVersionId: randomUUID(),
    });
    expect(replayWithStale.clientVisibleAt).toEqual(published.clientVisibleAt);

    // Explicit null — also still succeeds.
    const replayWithNull = await publishProposalVersion(tcActor, version.id, {
      expectedCurrentVersionId: null,
    });
    expect(replayWithNull.clientVisibleAt).toEqual(published.clientVisibleAt);

    expect(
      await prisma!.auditLog.count({
        where: {
          entityType: 'ProposalVersion',
          entityId: version.id,
          action: 'PROPOSAL_VERSION_PUBLISHED',
        },
      }),
    ).toBe(1);
  });

  it('supersedes the prior current version on a subsequent publish, audits it correctly, and never resurrects a superseded version on a later publish attempt', async () => {
    const client = await createClientFixture('Supersede Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal, version: v1 } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'V1 content.',
    });
    createdProposalIds.push(proposal.id);
    const v2 = await createProposalRevision(tcActor, proposal.id, { content: 'V2 content.' });

    await publishProposalVersion(tcActor, v1.id, { expectedCurrentVersionId: null });
    const publishedV2 = await publishProposalVersion(tcActor, v2.id, {
      expectedCurrentVersionId: v1.id,
    });
    expect(publishedV2.clientVisibleAt).not.toBeNull();
    expect(publishedV2.supersededAt).toBeNull();

    const v1Row = await prisma!.proposalVersion.findUnique({ where: { id: v1.id } });
    expect(v1Row?.supersededAt).not.toBeNull();
    expect(v1Row?.clientVisibleAt).not.toBeNull(); // was published once; never cleared

    const publishAudit = await prisma!.auditLog.findFirst({
      where: {
        entityType: 'ProposalVersion',
        entityId: v2.id,
        action: 'PROPOSAL_VERSION_PUBLISHED',
      },
    });
    expect(publishAudit?.afterState).toEqual({
      proposalId: proposal.id,
      versionNumber: 2,
      previousCurrentVersionId: v1.id,
    });
    expect(JSON.stringify(publishAudit?.afterState)).not.toContain('content');

    // v1 is now superseded — publishing it again is rejected outright,
    // never resurrecting it as current.
    await expect(
      publishProposalVersion(tcActor, v1.id, { expectedCurrentVersionId: v2.id }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_SUPERSEDED', status: 409 });

    const v1RowAfter = await prisma!.proposalVersion.findUnique({ where: { id: v1.id } });
    const v2RowAfter = await prisma!.proposalVersion.findUnique({ where: { id: v2.id } });
    expect(v1RowAfter?.clientVisibleAt).not.toBeNull();
    expect(v1RowAfter?.supersededAt).not.toBeNull();
    expect(v2RowAfter?.clientVisibleAt).not.toBeNull();
    expect(v2RowAfter?.supersededAt).toBeNull();
  });

  it('proves two real, simultaneously in-flight publish transactions on different versions via a genuine row-lock block (verified through pg_blocking_pids()), resolving to exactly one winner and one PROPOSAL_CONFLICT', async () => {
    const client = await createClientFixture('Concurrent Publish Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal, version: v1 } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Concurrent publish V1.',
    });
    createdProposalIds.push(proposal.id);
    const v2 = await createProposalRevision(tcActor, proposal.id, {
      content: 'Concurrent publish V2.',
    });

    // publishProposalVersion's real contention point (unlike revision
    // creation) is its own final UPDATE — markProposalVersionClientVisible
    // — on the target ProposalVersion row itself. Holding an explicit
    // `SELECT ... FOR UPDATE` on BOTH v1 and v2's rows from a separate,
    // deliberately-held-open real Prisma transaction forces both real
    // publishProposalVersion calls to block for real at that UPDATE step —
    // every earlier step in each call (the actor-scoped read, the
    // assignment recheck, the idempotent/superseded/current-version reads)
    // is a plain, non-locking SELECT that is never blocked by this lock, so
    // both calls genuinely reach and block at the same real contention
    // point, verified via pg_blocking_pids() before the blocker releases.
    // `timeout: 15000` overrides Prisma's own default 5000ms
    // interactive-transaction timeout, which would otherwise abort this
    // deliberately-long-held blocker transaction from underneath us while
    // it is still waiting to be released.
    let blockerPid = 0;
    let releaseBlocker!: () => void;
    const blockerReleaseSignal = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let signalBlockerReady!: () => void;
    const blockerReadySignal = new Promise<void>((resolve) => {
      signalBlockerReady = resolve;
    });

    const blockerTransactionPromise = prisma!.$transaction(
      async (tx) => {
        const pidRows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        blockerPid = Number(pidRows[0]?.pid);
        await tx.$queryRaw`SELECT id FROM proposal_version WHERE id IN (${v1.id}, ${v2.id}) FOR UPDATE`;
        signalBlockerReady();
        await blockerReleaseSignal;
      },
      { timeout: 15000 },
    );

    // Declared outside the try block (Stage 6 Correction Pass 2, Part C) so
    // `finally` can always settle them, even if an earlier step in `try`
    // throws before either publish call's own outcome is ever awaited.
    let firstPromise: ReturnType<typeof publishProposalVersion> | undefined;
    let secondPromise: ReturnType<typeof publishProposalVersion> | undefined;

    try {
      // Races the ready signal against the blocker transaction's own
      // promise so a genuine failure inside the blocker (e.g. a SQL
      // error) surfaces immediately as a real rejection here, instead of
      // hanging forever on a manually-created signal that would then
      // never resolve or reject on its own.
      await Promise.race([
        blockerReadySignal,
        blockerTransactionPromise.then(() => {
          throw new Error(
            'Blocker transaction completed unexpectedly before signaling ready — the FOR UPDATE setup itself likely failed.',
          );
        }),
      ]);

      firstPromise = publishProposalVersion(tcActor, v1.id, {
        expectedCurrentVersionId: null,
      });
      secondPromise = publishProposalVersion(tcActor, v2.id, {
        expectedCurrentVersionId: null,
      });

      const blockedPids = await waitUntilBlockedOn(blockerPid, 2);
      expect(blockedPids).toHaveLength(2);

      releaseBlocker();
      await blockerTransactionPromise;

      const results = await Promise.allSettled([firstPromise, secondPromise]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'PROPOSAL_CONFLICT',
        status: 409,
      });

      // Exactly one version of this Proposal is current afterward.
      const currentVersions = await prisma!.proposalVersion.findMany({
        where: { proposalId: proposal.id, clientVisibleAt: { not: null }, supersededAt: null },
      });
      expect(currentVersions).toHaveLength(1);

      // Exactly one PROPOSAL_VERSION_PUBLISHED audit exists across both
      // versions — the loser's rejected attempt wrote nothing.
      expect(
        await prisma!.auditLog.count({
          where: {
            entityType: 'ProposalVersion',
            entityId: { in: [v1.id, v2.id] },
            action: 'PROPOSAL_VERSION_PUBLISHED',
          },
        }),
      ).toBe(1);
    } finally {
      // Always released and settled — even when an earlier step above
      // throws (e.g. `waitUntilBlockedOn` times out or an assertion
      // fails) — so no service operation and no dangling unhandled
      // rejection outlives this test.
      releaseBlocker();
      await blockerTransactionPromise.catch(() => {});
      await Promise.allSettled(
        [firstPromise, secondPromise].filter((p): p is NonNullable<typeof p> => p !== undefined),
      );
    }
  }, 20000);

  it('enforces at most one current client-visible ProposalVersion per Proposal at the database level (partial unique index), independent of the service', async () => {
    const client = await createClientFixture('Partial Unique Index Client');
    const proposal = await prisma!.proposal.create({
      data: { id: randomUUID(), clientId: client.id },
    });
    createdProposalIds.push(proposal.id);

    await prisma!.proposalVersion.create({
      data: {
        id: randomUUID(),
        proposalId: proposal.id,
        versionNumber: 1,
        content: 'A',
        createdByUserId: adminActor.id,
        clientVisibleAt: new Date(),
      },
    });

    await expect(
      prisma!.proposalVersion.create({
        data: {
          id: randomUUID(),
          proposalId: proposal.id,
          versionNumber: 2,
          content: 'B',
          createdByUserId: adminActor.id,
          clientVisibleAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // Group E — External response, cross-feature Booking-eligibility
  // regression, and audit integrity
  // ---------------------------------------------------------------------

  it('records an ACCEPT response whose ProposalAcceptance is immediately visible to Booking eligibility via the real, unmodified findEligibleProposalVersionForActor', async () => {
    const client = await createClientFixture('Acceptance Regression Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal, version } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Acceptance regression content.',
    });
    createdProposalIds.push(proposal.id);
    await publishProposalVersion(tcActor, version.id, { expectedCurrentVersionId: null });

    // Before any response is recorded, Booking's own eligibility check must
    // report no accepted acceptance yet.
    const beforeResponse = await findEligibleProposalVersionForActor(
      prisma!,
      { id: adminActor.id, role: 'ADMIN_MANAGER' },
      version.id,
    );
    expect(beforeResponse?.hasAcceptedAcceptance).toBe(false);

    const acceptance = await recordProposalResponse(adminActor, version.id, {
      responseType: 'ACCEPT',
      respondedAt: '2026-08-04T10:00:00.000Z',
      responseMethod: 'phone',
      evidenceReference: 'Call log #4821',
    });
    expect(acceptance.responseType).toBe('ACCEPT');
    expect(acceptance.proposalVersionId).toBe(version.id);

    // The D-027-required regression: the exact same, unmodified Booking
    // repository primitive Booking creation eligibility already depends on
    // now correctly reports the acceptance, for both ADMIN_MANAGER and the
    // assigned TRAVEL_CONSULTANT.
    const adminEligibility = await findEligibleProposalVersionForActor(
      prisma!,
      { id: adminActor.id, role: 'ADMIN_MANAGER' },
      version.id,
    );
    expect(adminEligibility?.hasAcceptedAcceptance).toBe(true);
    expect(adminEligibility?.clientId).toBe(client.id);

    const tcEligibility = await findEligibleProposalVersionForActor(
      prisma!,
      { id: tcActor.id, role: 'TRAVEL_CONSULTANT' },
      version.id,
    );
    expect(tcEligibility?.hasAcceptedAcceptance).toBe(true);
  });

  it('rejects a second response attempt with PROPOSAL_RESPONSE_ALREADY_RECORDED even after the responded-to version has since been superseded, never PROPOSAL_VERSION_NOT_CURRENT', async () => {
    const client = await createClientFixture('Already Recorded Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal, version: v1 } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'V1 for already-recorded scenario.',
    });
    createdProposalIds.push(proposal.id);
    await publishProposalVersion(tcActor, v1.id, { expectedCurrentVersionId: null });

    await recordProposalResponse(adminActor, v1.id, {
      responseType: 'ACCEPT',
      respondedAt: '2026-08-04T10:00:00.000Z',
      responseMethod: 'phone',
      evidenceReference: 'Call log #1',
    });

    // A later revision supersedes v1.
    const v2 = await createProposalRevision(tcActor, proposal.id, { content: 'V2 content.' });
    await publishProposalVersion(tcActor, v2.id, { expectedCurrentVersionId: v1.id });

    const v1Row = await prisma!.proposalVersion.findUnique({ where: { id: v1.id } });
    expect(v1Row?.supersededAt).not.toBeNull();

    await expect(
      recordProposalResponse(adminActor, v1.id, {
        responseType: 'DECLINE',
        respondedAt: '2026-08-05T10:00:00.000Z',
        responseMethod: 'email',
        evidenceReference: 'Second attempt, should be rejected',
      }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED', status: 409 });

    // Still exactly one ProposalAcceptance for v1, unchanged.
    const acceptances = await prisma!.proposalAcceptance.findMany({
      where: { proposalVersionId: v1.id },
    });
    expect(acceptances).toHaveLength(1);
    expect(acceptances[0]?.responseType).toBe('ACCEPT');
  });

  it('rejects recording a response against a version that is not the current client-visible version', async () => {
    const client = await createClientFixture('Not Current Client');
    await assignClientToStaff(client.id, tcActor.id);

    const { proposal, version } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Never published draft.',
    });
    createdProposalIds.push(proposal.id);
    // Deliberately never published — version.clientVisibleAt stays null.

    await expect(
      recordProposalResponse(adminActor, version.id, {
        responseType: 'ACCEPT',
        respondedAt: '2026-08-04T10:00:00.000Z',
        responseMethod: 'phone',
        evidenceReference: 'Should be rejected — never current',
      }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_NOT_CURRENT', status: 409 });

    expect(
      await prisma!.proposalAcceptance.count({ where: { proposalVersionId: version.id } }),
    ).toBe(0);
  });

  it('records exact, PII-free AuditLog rows — exact counts, entityIds, actorIds, afterState values, and null beforeState — across the full create-revise-publish-publish-respond lifecycle, with unique secret markers for PII, content, responseMethod, and evidenceReference never appearing anywhere', async () => {
    const secretFullName = `SECRET-FULLNAME-${randomUUID()}`;
    const secretEmail = `secret-email-${randomUUID()}@example.test`;
    const secretContent = `SECRET-CONTENT-${randomUUID()}`;
    const secretMethod = `secret-method-${randomUUID()}`;
    const secretEvidence = `secret-evidence-${randomUUID()}`;

    const clientId = randomUUID();
    await prisma!.client.create({
      data: { id: clientId, fullName: secretFullName, email: secretEmail },
    });
    createdClientIds.push(clientId);
    await assignClientToStaff(clientId, tcActor.id);

    const { proposal, version: v1 } = await createProposal(tcActor, {
      clientId,
      content: secretContent,
    });
    createdProposalIds.push(proposal.id);
    const v2 = await createProposalRevision(tcActor, proposal.id, { content: secretContent });
    await publishProposalVersion(tcActor, v1.id, { expectedCurrentVersionId: null });
    await publishProposalVersion(tcActor, v2.id, { expectedCurrentVersionId: v1.id });
    const acceptance = await recordProposalResponse(adminActor, v2.id, {
      responseType: 'ACCEPT',
      respondedAt: '2026-08-04T10:00:00.000Z',
      responseMethod: secretMethod,
      evidenceReference: secretEvidence,
    });

    const allAudits = await prisma!.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'Proposal', entityId: proposal.id },
          { entityType: 'ProposalVersion', entityId: { in: [v1.id, v2.id] } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    // Exact total, and exact per-action counts — grouped explicitly into
    // arrays (never read via findFirst or a Map keyed by action alone), so
    // a duplicate row of the same action can never silently pass through
    // unnoticed.
    expect(allAudits).toHaveLength(5);
    const byAction = new Map<string, typeof allAudits>();
    for (const row of allAudits) {
      byAction.set(row.action, [...(byAction.get(row.action) ?? []), row]);
    }
    expect((byAction.get('PROPOSAL_CREATED') ?? []).length).toBe(1);
    expect((byAction.get('PROPOSAL_VERSION_CREATED') ?? []).length).toBe(1);
    expect((byAction.get('PROPOSAL_VERSION_PUBLISHED') ?? []).length).toBe(2);
    expect((byAction.get('PROPOSAL_RESPONSE_RECORDED') ?? []).length).toBe(1);

    const createdAudit = byAction.get('PROPOSAL_CREATED')![0]!;
    expect(createdAudit.entityType).toBe('Proposal');
    expect(createdAudit.entityId).toBe(proposal.id);
    expect(createdAudit.actorId).toBe(tcActor.id);
    expect(createdAudit.beforeState).toBeNull();
    expect(createdAudit.afterState).toEqual({
      clientId,
      firstVersionId: v1.id,
      firstVersionNumber: 1,
    });

    const versionCreatedAudit = byAction.get('PROPOSAL_VERSION_CREATED')![0]!;
    expect(versionCreatedAudit.entityType).toBe('ProposalVersion');
    expect(versionCreatedAudit.entityId).toBe(v2.id);
    expect(versionCreatedAudit.actorId).toBe(tcActor.id);
    expect(versionCreatedAudit.beforeState).toBeNull();
    expect(versionCreatedAudit.afterState).toEqual({ proposalId: proposal.id, versionNumber: 2 });

    const publishedAudits = byAction.get('PROPOSAL_VERSION_PUBLISHED')!;
    const firstPublishAudit = publishedAudits.find((row) => row.entityId === v1.id);
    const secondPublishAudit = publishedAudits.find((row) => row.entityId === v2.id);
    expect(firstPublishAudit).toBeDefined();
    expect(secondPublishAudit).toBeDefined();
    expect(firstPublishAudit!.entityType).toBe('ProposalVersion');
    expect(firstPublishAudit!.actorId).toBe(tcActor.id);
    expect(firstPublishAudit!.beforeState).toBeNull();
    expect(firstPublishAudit!.afterState).toEqual({
      proposalId: proposal.id,
      versionNumber: 1,
      previousCurrentVersionId: null,
    });
    expect(secondPublishAudit!.entityType).toBe('ProposalVersion');
    expect(secondPublishAudit!.actorId).toBe(tcActor.id);
    expect(secondPublishAudit!.beforeState).toBeNull();
    expect(secondPublishAudit!.afterState).toEqual({
      proposalId: proposal.id,
      versionNumber: 2,
      previousCurrentVersionId: v1.id,
    });

    const responseAudit = byAction.get('PROPOSAL_RESPONSE_RECORDED')![0]!;
    expect(responseAudit.entityType).toBe('ProposalVersion');
    expect(responseAudit.entityId).toBe(v2.id);
    expect(responseAudit.actorId).toBe(adminActor.id);
    expect(responseAudit.beforeState).toBeNull();
    expect(responseAudit.afterState).toEqual({
      acceptanceId: acceptance.id,
      responseType: 'ACCEPT',
      respondedAt: '2026-08-04T10:00:00.000Z',
    });

    // No secret value — PII (full name, email) or business content
    // (authored content, responseMethod, evidenceReference) — anywhere in
    // the complete serialized set of audit rows.
    const serialized = JSON.stringify(allAudits);
    expect(serialized).not.toContain(secretFullName);
    expect(serialized).not.toContain(secretEmail);
    expect(serialized).not.toContain(secretContent);
    expect(serialized).not.toContain(secretMethod);
    expect(serialized).not.toContain(secretEvidence);
  });
});
