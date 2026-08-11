import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import type { AuthenticatedUser } from '@/lib/auth/guards';

// Database-backed integration test satisfying
// docs/HERITAGE_V3_DECISIONS_LOG.md D-030 §2's real-PostgreSQL integration
// requirement for Booking: direct verification of the BOOKING_CREATED and
// BOOKING_STATUS_CHANGED AuditLog actions — persisted action, entity type,
// entity id, actor attribution, atomicity with the corresponding business
// write, and PII-free sanitized snapshot state. Every mocked test elsewhere
// in this feature (schemas.test.ts, transitions.test.ts, repository.test.ts,
// service.test.ts, audit.test.ts) intentionally mocks Prisma and/or
// features/assignments — none of them can prove the real
// transactional/audit behavior against an actual PostgreSQL database with
// real foreign-key/CHECK/unique constraints. This file proves it for real,
// against a dedicated, disposable PostgreSQL database — never the shared
// local `heritage_v3_dev` database — using this feature's own real,
// unmodified `service.ts` exports and, for the required accepted-
// ProposalVersion fixture chain (D-030 §3), features/proposals/service.ts's
// own real, unmodified exports.
//
// This feature previously had no service.integration.test.ts — D-030 §2
// authorizes adding it, scoped exactly to the two Booking audit actions
// above; the broader Booking business/concurrency real-PostgreSQL backfill
// remains a separate, later, already-recorded follow-up (D-028 §10; D-030
// §5) and is deliberately not attempted here.
//
// D-030 Implementation Correction Pass 1 adds two rollback-proof tests
// (one per audited action) that force the AuditLog write specifically to
// fail — via a narrow, test-only proxy over the real `tx` handed to
// `attemptCreateBooking`/`updateBookingStatus`'s transaction callback, so
// that only `tx.auditLog.create` rejects while every other `tx` method
// (`tx.booking.create`, `tx.booking.update`, `tx.$queryRaw`, etc.)
// delegates unchanged to the real transaction client — and assert the
// business write and the audit write commit or roll back together, never
// independently. The prior positive-path tests alone only proved "both
// rows exist after a successful call," which would still pass under a
// non-atomic implementation; see `installAuditLogCreateFailure`'s own doc
// comment below for the full mechanism and the empirical verification this
// pass performed before relying on it.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/leads/service.integration.test.ts,
// features/clients/service.integration.test.ts,
// features/proposals/service.integration.test.ts, and
// features/assignments/service.integration.test.ts — see any of those
// files' own doc comment for the full rationale. In short: no `@/lib/db` or
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
 * features/clients/, features/proposals/, and features/assignments/'s own
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
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the bookings integration suite.',
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

describe.skipIf(!hasTestDatabaseUrl)('bookings service integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let createBooking: (typeof import('./service'))['createBooking'];
  let updateBookingStatus: (typeof import('./service'))['updateBookingStatus'];
  let createProposal: (typeof import('@/features/proposals/service'))['createProposal'];
  let publishProposalVersion: (typeof import('@/features/proposals/service'))['publishProposalVersion'];
  let recordProposalResponse: (typeof import('@/features/proposals/service'))['recordProposalResponse'];

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  const actorUserIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdProposalIds: string[] = [];
  const createdBookingIds: string[] = [];

  beforeAll(async () => {
    // 1. Safety guard — must run before any env mutation, import, or
    // connection.
    validateTestDatabaseUrl(rawTestDatabaseUrl!);

    // 2. Establish the environment the real modules will read at import
    // time (identical rationale to every existing integration suite).
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

    // 3. Only now — dynamically — import the real, unmocked application
    // modules.
    ({ prisma } = await import('@/lib/db'));
    ({ createBooking, updateBookingStatus } = await import('./service'));
    ({ createProposal, publishProposalVersion, recordProposalResponse } =
      await import('@/features/proposals/service'));

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
      const email = `bookings-integration-${role.toLowerCase()}-${randomUUID()}@example.test`;
      const name = `Integration ${role}`;
      await prisma!.user.create({ data: { id, name, email, role, isActive: true } });
      actorUserIds.push(id);
      return { id, name, email, role };
    }

    adminActor = await createStaffFixture('ADMIN_MANAGER');
    tcActor = await createStaffFixture('TRAVEL_CONSULTANT');
  });

  afterAll(async () => {
    try {
      if (prisma) {
        try {
          // Deletion order respects onDelete: Restrict throughout
          // schema.prisma, mirroring features/clients/service.
          // integration.test.ts's and features/proposals/service.
          // integration.test.ts's identical precedent, extended for this
          // file's own Booking fixtures: StaffAssignment rows referencing
          // a tracked Client or actor go first; then AuditLog rows
          // referencing a tracked actor; then BookingStatusHistory and
          // Booking (Booking references ProposalVersion and Client, both
          // Restrict); then ProposalAcceptance and ProposalVersion (both
          // reference Proposal, Restrict); then Proposal (references
          // Client, Restrict); then Client; then User last.
          await prisma.staffAssignment.deleteMany({
            where: {
              OR: [
                { clientId: { in: createdClientIds } },
                { assignedStaffId: { in: actorUserIds } },
                { assignedByUserId: { in: actorUserIds } },
              ],
            },
          });
          await prisma.auditLog.deleteMany({ where: { actorId: { in: actorUserIds } } });
          if (createdBookingIds.length > 0) {
            await prisma.bookingStatusHistory.deleteMany({
              where: { bookingId: { in: createdBookingIds } },
            });
            await prisma.booking.deleteMany({ where: { id: { in: createdBookingIds } } });
          }
          if (createdProposalIds.length > 0) {
            await prisma.proposalAcceptance.deleteMany({
              where: { proposalVersion: { proposalId: { in: createdProposalIds } } },
            });
            await prisma.proposalVersion.deleteMany({
              where: { proposalId: { in: createdProposalIds } },
            });
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
    }
  });

  // --- D-030 §3 fixture chain: a raw Client fixture, then the real
  // createProposal -> publishProposalVersion -> recordProposalResponse
  // ('ACCEPT') chain, stopping just short of createBooking so each test can
  // call the function under test itself. ---

  /** Inserts a standalone Client row directly (this feature introduces no
   * Client-creation path of its own) — mirrors
   * features/clients/service.integration.test.ts's and
   * features/proposals/service.integration.test.ts's own identical
   * `createClientFixture` precedent. Accepts optional PII overrides so
   * audit-integrity tests can plant unique secret markers. */
  async function createClientFixture(overrides?: {
    fullName?: string;
    email?: string;
  }): Promise<{ id: string; fullName: string; email: string }> {
    const id = randomUUID();
    const fullName = overrides?.fullName ?? `Booking Fixture Client ${randomUUID()}`;
    const email = overrides?.email ?? `bookings-integration-${randomUUID()}@example.test`;
    await prisma!.client.create({ data: { id, fullName, email } });
    createdClientIds.push(id);
    return { id, fullName, email };
  }

  /**
   * Builds a real, accepted ProposalVersion ready to source a Booking, via
   * the real, unmodified `createProposal` -> `publishProposalVersion` ->
   * `recordProposalResponse('ACCEPT')` chain (D-030 §3, steps b-d).
   * `tcActor` is assigned to the fixture Client via a raw StaffAssignment
   * insert first (mirrors features/proposals/service.integration.test.ts's
   * own `assignClientToStaff` precedent) — required because `createProposal`
   * (D-027 §3) only permits an author who currently holds the target
   * Client's active assignment. Publication is required, not optional,
   * before `recordProposalResponse` can succeed — a version fresh from
   * `createProposal` alone has `clientVisibleAt: null` and is rejected with
   * `PROPOSAL_VERSION_NOT_CURRENT` (D-030 §3's own rationale).
   */
  async function createAcceptedProposalVersionFixture(overrides?: {
    fullName?: string;
    email?: string;
    content?: string;
  }): Promise<{ clientId: string; proposalId: string; versionId: string }> {
    const client = await createClientFixture({
      fullName: overrides?.fullName,
      email: overrides?.email,
    });
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: tcActor.id,
        assignedByUserId: adminActor.id,
        clientId: client.id,
      },
    });

    const { proposal, version } = await createProposal(tcActor, {
      clientId: client.id,
      content: overrides?.content ?? `Booking fixture proposal content ${randomUUID()}.`,
    });
    createdProposalIds.push(proposal.id);

    await publishProposalVersion(tcActor, version.id, { expectedCurrentVersionId: null });

    await recordProposalResponse(adminActor, version.id, {
      responseType: 'ACCEPT',
      respondedAt: new Date().toISOString(),
      responseMethod: 'phone',
      evidenceReference: `Booking fixture evidence ${randomUUID()}`,
    });

    return { clientId: client.id, proposalId: proposal.id, versionId: version.id };
  }

  // --- D-030 Correction Pass 1: rollback-proof failure injection ---

  const AUDIT_LOG_FAILURE_MARKER = 'D-030 Correction Pass 1: induced AuditLog insert failure';

  type PrismaTransactionMethod = NonNullable<typeof prisma>['$transaction'];

  /**
   * Installs a narrow, test-only interception of the real
   * `prisma.$transaction` method — never a mock of a query result or a
   * business/authorization outcome — that makes ONLY `tx.auditLog.create`
   * reject, for exactly the next transaction opened while installed, with
   * every other property/method of the real `tx` (`tx.booking.create`,
   * `tx.booking.update`, `tx.$queryRaw`, etc.) delegating unchanged to the
   * real transaction client via `Reflect.get`. `original` — captured before
   * installing — is invoked via `Reflect.apply` against the real `prisma`
   * receiver, mirroring
   * features/proposals/service.integration.test.ts's own established
   * `Reflect.apply(original, prisma!, args)` precedent exactly, so Prisma
   * itself (not this test) still opens the real transaction, runs the real
   * callback, and issues the real COMMIT/ROLLBACK.
   *
   * Why this proves atomicity rather than merely asserting it:
   * `attemptCreateBooking` and `updateBookingStatus`
   * (features/bookings/service.ts) both `await` their business write
   * (`repository.createBookingWithInitialHistory` /
   * `repository.updateBookingStatusWithHistory`) to completion — a single
   * nested Prisma write per call, covering Booking and its
   * BookingStatusHistory row together — strictly before ever calling
   * `repository.insertAuditLog`, which is the only call in either function
   * that touches `tx.auditLog.create`. Because this proxy leaves
   * `tx.booking.create`/`tx.booking.update` completely untouched, the real
   * business write genuinely executes against the real `tx` first and
   * would have committed on its own; only the already-reached,
   * already-attempted `tx.auditLog.create` call is forced to throw. Since
   * a plain thrown `Error` is not a `Prisma.PrismaClientKnownRequestError`,
   * neither `runSerializableWithRetry` (which retries only on `P2034`) nor
   * `createBooking`'s own bounded retry loop (which retries only on a
   * `bookingReference`/`proposalVersionId` unique-constraint conflict)
   * treats it as retryable — it propagates straight out, unmodified
   * (verified empirically against this exact database/adapter before this
   * test was written: a plain `Error` thrown inside a
   * `prisma.$transaction` callback here rolls back an already-executed
   * write on a different table made earlier in the same callback, and
   * reaches the `$transaction` caller as the identical, unwrapped `Error`
   * instance — not a Prisma-wrapped or replaced error). Prisma's own
   * interactive-transaction semantics then roll back everything the real
   * callback did in that transaction — including the already-executed
   * business write — the instant the callback rejects. The assertions
   * below check the real, post-rollback database state, so they would fail
   * under any implementation where the business write and the audit write
   * were committed as two independent operations rather than one atomic
   * transaction.
   *
   * Always paired with a `finally { release() }` in the caller, so a
   * failed assertion can never leave this interception installed for a
   * later test — matching every other transaction-interception helper
   * already established in this codebase's sibling integration suites
   * (features/clients/, features/proposals/).
   */
  function installAuditLogCreateFailure(): { release: () => void } {
    const original = prisma!.$transaction as PrismaTransactionMethod;

    const wrapped = (async (...args: Parameters<PrismaTransactionMethod>) => {
      const [fn, options] = args as unknown as [
        (tx: Prisma.TransactionClient) => Promise<unknown>,
        Record<string, unknown> | undefined,
      ];
      const wrappedFn = async (tx: Prisma.TransactionClient) => {
        const patchedTx = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop === 'auditLog') {
              return new Proxy(target.auditLog, {
                get(auditTarget, auditProp, auditReceiver) {
                  if (auditProp === 'create') {
                    return async () => {
                      throw new Error(AUDIT_LOG_FAILURE_MARKER);
                    };
                  }
                  return Reflect.get(auditTarget, auditProp, auditReceiver);
                },
              });
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as Prisma.TransactionClient;
        return fn(patchedTx);
      };
      return Reflect.apply(original as (...callArgs: unknown[]) => unknown, prisma!, [
        wrappedFn,
        options,
      ]);
    }) as PrismaTransactionMethod;

    prisma!.$transaction = wrapped;
    return {
      release: () => {
        prisma!.$transaction = original;
      },
    };
  }

  // ---------------------------------------------------------------------
  // BOOKING_CREATED
  // ---------------------------------------------------------------------

  it('creates a Booking from an accepted ProposalVersion, writing exactly one PII-free BOOKING_CREATED audit row atomic with the Booking write', async () => {
    const secretFullName = `SECRET-FULLNAME-${randomUUID()}`;
    const secretEmail = `secret-email-${randomUUID()}@example.test`;
    const secretContent = `SECRET-CONTENT-${randomUUID()}`;

    const fixture = await createAcceptedProposalVersionFixture({
      fullName: secretFullName,
      email: secretEmail,
      content: secretContent,
    });

    const { booking, created } = await createBooking(adminActor, {
      proposalVersionId: fixture.versionId,
    });
    createdBookingIds.push(booking.id);

    expect(created).toBe(true);
    expect(booking.clientId).toBe(fixture.clientId);
    expect(booking.proposalVersionId).toBe(fixture.versionId);
    expect(booking.status).toBe('DRAFT');

    // Atomic with the Booking write: both the Booking row itself and its
    // audit row exist together once createBooking has returned.
    const bookingRow = await prisma!.booking.findUnique({ where: { id: booking.id } });
    expect(bookingRow).not.toBeNull();

    const audits = await prisma!.auditLog.findMany({
      where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_CREATED' },
    });
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actorId).toBe(adminActor.id);
    expect(audit.beforeState).toBeNull();
    expect(audit.afterState).toEqual({
      id: booking.id,
      bookingReference: booking.bookingReference,
      clientId: booking.clientId,
      proposalVersionId: booking.proposalVersionId,
      status: booking.status,
    });

    // No PII (Client full name/email) or Proposal content anywhere in the
    // persisted audit row.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(secretFullName);
    expect(serialized).not.toContain(secretEmail);
    expect(serialized).not.toContain(secretContent);
  });

  it('rolls back the entire transaction when the AuditLog write fails after the Booking business write has been attempted, persisting neither the Booking nor any BOOKING_CREATED audit', async () => {
    const fixture = await createAcceptedProposalVersionFixture();

    const auditCountBefore = await prisma!.auditLog.count({
      where: { action: 'BOOKING_CREATED', actorId: adminActor.id },
    });

    const failure = installAuditLogCreateFailure();
    try {
      await expect(
        createBooking(adminActor, { proposalVersionId: fixture.versionId }),
      ).rejects.toThrow(AUDIT_LOG_FAILURE_MARKER);
    } finally {
      failure.release();
    }

    // The Booking + initial BookingStatusHistory write was genuinely
    // attempted (attemptCreateBooking awaits
    // repository.createBookingWithInitialHistory to completion before ever
    // calling repository.insertAuditLog) and would have committed on its
    // own — but rolled back along with the failed audit write, inside the
    // same real transaction, exactly as installAuditLogCreateFailure's own
    // doc comment proves.
    expect(await prisma!.booking.count({ where: { proposalVersionId: fixture.versionId } })).toBe(
      0,
    );

    const auditCountAfter = await prisma!.auditLog.count({
      where: { action: 'BOOKING_CREATED', actorId: adminActor.id },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it('treats a repeated createBooking call for the same ProposalVersion as an idempotent no-op, writing no additional BOOKING_CREATED audit', async () => {
    const fixture = await createAcceptedProposalVersionFixture();

    const first = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(first.booking.id);
    expect(first.created).toBe(true);

    const auditCountAfterFirst = await prisma!.auditLog.count({
      where: { entityType: 'Booking', entityId: first.booking.id, action: 'BOOKING_CREATED' },
    });
    expect(auditCountAfterFirst).toBe(1);

    const second = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    expect(second.created).toBe(false);
    expect(second.booking.id).toBe(first.booking.id);

    const auditCountAfterSecond = await prisma!.auditLog.count({
      where: { entityType: 'Booking', entityId: first.booking.id, action: 'BOOKING_CREATED' },
    });
    expect(auditCountAfterSecond).toBe(1);

    expect(await prisma!.booking.count({ where: { proposalVersionId: fixture.versionId } })).toBe(
      1,
    );
  });

  it('rejects a not-yet-accepted ProposalVersion with PROPOSAL_VERSION_NOT_ACCEPTED, writing no Booking and no BOOKING_CREATED audit', async () => {
    const client = await createClientFixture();
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: tcActor.id,
        assignedByUserId: adminActor.id,
        clientId: client.id,
      },
    });
    const { proposal, version } = await createProposal(tcActor, {
      clientId: client.id,
      content: 'Never accepted proposal content.',
    });
    createdProposalIds.push(proposal.id);
    await publishProposalVersion(tcActor, version.id, { expectedCurrentVersionId: null });
    // Deliberately never calls recordProposalResponse.

    // A before/after delta, scoped to this actor — never a bare `toBe(0)`
    // global count, which would be fragile against other tests in this
    // same suite invocation also writing BOOKING_CREATED audits attributed
    // to the same shared `adminActor` fixture.
    const auditCountBefore = await prisma!.auditLog.count({
      where: { action: 'BOOKING_CREATED', actorId: adminActor.id },
    });

    await expect(
      createBooking(adminActor, { proposalVersionId: version.id }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_NOT_ACCEPTED' });

    expect(await prisma!.booking.count({ where: { proposalVersionId: version.id } })).toBe(0);
    const auditCountAfter = await prisma!.auditLog.count({
      where: { action: 'BOOKING_CREATED', actorId: adminActor.id },
    });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  // ---------------------------------------------------------------------
  // BOOKING_STATUS_CHANGED
  // ---------------------------------------------------------------------

  it("transitions a Booking's status, writing exactly one PII-free BOOKING_STATUS_CHANGED audit row with status-only before/after state, atomic with the status write", async () => {
    const fixture = await createAcceptedProposalVersionFixture();
    const { booking } = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(booking.id);

    const updated = await updateBookingStatus(adminActor, booking.id, {
      expectedStatus: 'DRAFT',
      newStatus: 'PENDING_CONFIRMATION',
    });
    expect(updated.status).toBe('PENDING_CONFIRMATION');

    const updatedRow = await prisma!.booking.findUnique({ where: { id: booking.id } });
    expect(updatedRow?.status).toBe('PENDING_CONFIRMATION');

    const historyRow = await prisma!.bookingStatusHistory.findFirst({
      where: { bookingId: booking.id, newStatus: 'PENDING_CONFIRMATION' },
    });
    expect(historyRow?.previousStatus).toBe('DRAFT');

    const audits = await prisma!.auditLog.findMany({
      where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_STATUS_CHANGED' },
    });
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit.actorId).toBe(adminActor.id);
    expect(audit.beforeState).toEqual({ status: 'DRAFT' });
    expect(audit.afterState).toEqual({ status: 'PENDING_CONFIRMATION' });
  });

  it('rolls back the entire transaction when the AuditLog write fails after the status/status-history business write has been attempted, leaving the Booking status and history unchanged and persisting no BOOKING_STATUS_CHANGED audit', async () => {
    const fixture = await createAcceptedProposalVersionFixture();
    const { booking } = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(booking.id);

    const historyCountBefore = await prisma!.bookingStatusHistory.count({
      where: { bookingId: booking.id },
    });

    const failure = installAuditLogCreateFailure();
    try {
      await expect(
        updateBookingStatus(adminActor, booking.id, {
          expectedStatus: 'DRAFT',
          newStatus: 'PENDING_CONFIRMATION',
        }),
      ).rejects.toThrow(AUDIT_LOG_FAILURE_MARKER);
    } finally {
      failure.release();
    }

    // The Booking.status + new BookingStatusHistory write was genuinely
    // attempted (updateBookingStatus awaits
    // repository.updateBookingStatusWithHistory to completion before ever
    // calling repository.insertAuditLog) and would have committed on its
    // own — but rolled back along with the failed audit write, inside the
    // same real transaction, exactly as installAuditLogCreateFailure's own
    // doc comment proves.
    const row = await prisma!.booking.findUnique({ where: { id: booking.id } });
    expect(row?.status).toBe('DRAFT');

    const historyCountAfter = await prisma!.bookingStatusHistory.count({
      where: { bookingId: booking.id },
    });
    expect(historyCountAfter).toBe(historyCountBefore);
    expect(
      await prisma!.bookingStatusHistory.count({
        where: { bookingId: booking.id, newStatus: 'PENDING_CONFIRMATION' },
      }),
    ).toBe(0);

    const auditCount = await prisma!.auditLog.count({
      where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_STATUS_CHANGED' },
    });
    expect(auditCount).toBe(0);
  });

  it('treats re-applying the same status as an idempotent no-op, writing no additional BOOKING_STATUS_CHANGED audit', async () => {
    const fixture = await createAcceptedProposalVersionFixture();
    const { booking } = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(booking.id);

    const replay = await updateBookingStatus(adminActor, booking.id, {
      expectedStatus: 'DRAFT',
      newStatus: 'DRAFT',
    });
    expect(replay.status).toBe('DRAFT');

    const auditCount = await prisma!.auditLog.count({
      where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_STATUS_CHANGED' },
    });
    expect(auditCount).toBe(0);
  });

  it('rejects a stale expectedStatus with BOOKING_CONFLICT, writing no audit and leaving the Booking status unchanged', async () => {
    const fixture = await createAcceptedProposalVersionFixture();
    const { booking } = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(booking.id);

    await expect(
      updateBookingStatus(adminActor, booking.id, {
        expectedStatus: 'PENDING_CONFIRMATION',
        newStatus: 'CONFIRMED',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_CONFLICT' });

    const row = await prisma!.booking.findUnique({ where: { id: booking.id } });
    expect(row?.status).toBe('DRAFT');

    const auditCount = await prisma!.auditLog.count({
      where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_STATUS_CHANGED' },
    });
    expect(auditCount).toBe(0);
  });
});
