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
  let getBookingById: (typeof import('./service'))['getBookingById'];
  let listBookings: (typeof import('./service'))['listBookings'];
  let updateBookingStatus: (typeof import('./service'))['updateBookingStatus'];
  let BookingError: (typeof import('./errors'))['BookingError'];
  let createProposal: (typeof import('@/features/proposals/service'))['createProposal'];
  let publishProposalVersion: (typeof import('@/features/proposals/service'))['publishProposalVersion'];
  let recordProposalResponse: (typeof import('@/features/proposals/service'))['recordProposalResponse'];
  // D-032 §4: the real, unmodified assignments service, used only to end a
  // real Client assignment for the listBookings-scoping proof — never
  // mocked, never a modification of
  // features/assignments/service.integration.test.ts.
  let endClientAssignment: (typeof import('@/features/assignments/service'))['endClientAssignment'];

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;
  // D-032 §4: a second, deliberately-unassigned TRAVEL_CONSULTANT, used
  // only for the anti-enumeration proofs (items 1-2) — mirrors
  // features/leads/service.integration.test.ts's identical otherTcActor
  // pattern.
  let otherTcActor: AuthenticatedUser;
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
    ({ createBooking, getBookingById, listBookings, updateBookingStatus } =
      await import('./service'));
    ({ BookingError } = await import('./errors'));
    ({ createProposal, publishProposalVersion, recordProposalResponse } =
      await import('@/features/proposals/service'));
    ({ endClientAssignment } = await import('@/features/assignments/service'));

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
    otherTcActor = await createStaffFixture('TRAVEL_CONSULTANT');
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
    // D-032 §4 item 6: exactly one initial BookingStatusHistory row exists
    // for this Booking after the replay — the idempotent no-op writes no
    // second history row alongside its already-confirmed no-second-audit
    // behavior above.
    expect(
      await prisma!.bookingStatusHistory.count({ where: { bookingId: first.booking.id } }),
    ).toBe(1);
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

  it('treats a same-status replay as an idempotent no-op even when expectedStatus is stale, returning the Booking completely unchanged and writing no additional BookingStatusHistory or audit row (D-032 §4 item 7)', async () => {
    const fixture = await createAcceptedProposalVersionFixture();
    const { booking } = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(booking.id);

    const historyCountBefore = await prisma!.bookingStatusHistory.count({
      where: { bookingId: booking.id },
    });
    const auditCountBefore = await prisma!.auditLog.count({
      where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_STATUS_CHANGED' },
    });

    // newStatus ('DRAFT') matches the Booking's actual current status, so
    // service.ts's idempotent no-op check — which runs before the
    // expectedStatus conflict check — applies regardless of the stale/wrong
    // expectedStatus ('PENDING_CONFIRMATION') supplied here.
    const replay = await updateBookingStatus(adminActor, booking.id, {
      expectedStatus: 'PENDING_CONFIRMATION',
      newStatus: 'DRAFT',
    });
    // The complete returned Booking is identical to the one createBooking
    // originally returned — both come from the same BOOKING_SELECT shape,
    // and nothing wrote to this row in between — not only its status.
    expect(replay).toEqual(booking);

    // The persisted row (a superset of BOOKING_SELECT's fields) still
    // contains every one of those same field values unchanged.
    const persisted = await prisma!.booking.findUnique({ where: { id: booking.id } });
    expect(persisted).toMatchObject(booking);

    expect(await prisma!.bookingStatusHistory.count({ where: { bookingId: booking.id } })).toBe(
      historyCountBefore,
    );
    expect(
      await prisma!.auditLog.count({
        where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_STATUS_CHANGED' },
      }),
    ).toBe(auditCountBefore);
  });

  // ---------------------------------------------------------------------
  // D-032 §4 (F-Booking): the eight required assertion groups closing
  // BOOKING-01 through BOOKING-04's Category-C real-PostgreSQL gap —
  // TRAVEL_CONSULTANT authorization, listBookings scoping, and genuine
  // divergent-target concurrency, none of which the two D-030 audit-scoped
  // tests above ever exercised (they use only adminActor, and never call
  // listBookings/getBookingById at all).
  // ---------------------------------------------------------------------

  it('rejects an unassigned TRAVEL_CONSULTANT creating a Booking from an existing-but-inaccessible ProposalVersion with the PROPOSAL_VERSION_FORBIDDEN result, writing nothing (D-032 §4 items 1 and 5)', async () => {
    const fixture = await createAcceptedProposalVersionFixture();

    // Scoped to this specific ProposalVersion (Booking/BookingStatusHistory)
    // and, for AuditLog, to the exact ProposalVersion id recorded in
    // BOOKING_CREATED's own sanitized afterState — never an unscoped global
    // count and never a broader actor-only scope, since a real
    // proposalVersionId is available here to filter on directly.
    const before = {
      booking: await prisma!.booking.count({ where: { proposalVersionId: fixture.versionId } }),
      history: await prisma!.bookingStatusHistory.count({
        where: { booking: { proposalVersionId: fixture.versionId } },
      }),
      audit: await prisma!.auditLog.count({
        where: {
          action: 'BOOKING_CREATED',
          afterState: { path: ['proposalVersionId'], equals: fixture.versionId },
        },
      }),
    };

    await expect(
      createBooking(otherTcActor, { proposalVersionId: fixture.versionId }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN' });

    expect(await prisma!.booking.count({ where: { proposalVersionId: fixture.versionId } })).toBe(
      before.booking,
    );
    expect(
      await prisma!.bookingStatusHistory.count({
        where: { booking: { proposalVersionId: fixture.versionId } },
      }),
    ).toBe(before.history);
    expect(
      await prisma!.auditLog.count({
        where: {
          action: 'BOOKING_CREATED',
          afterState: { path: ['proposalVersionId'], equals: fixture.versionId },
        },
      }),
    ).toBe(before.audit);
  });

  it('rejects an unassigned TRAVEL_CONSULTANT creating a Booking from a genuinely nonexistent ProposalVersion id with the identical PROPOSAL_VERSION_FORBIDDEN result, writing nothing (D-032 §4 items 1 and 5)', async () => {
    const nonexistentVersionId = randomUUID();

    // Scoped identically to the inaccessible-ProposalVersion case above,
    // to the one nonexistent id this specific attempt targets.
    const before = {
      booking: await prisma!.booking.count({ where: { proposalVersionId: nonexistentVersionId } }),
      history: await prisma!.bookingStatusHistory.count({
        where: { booking: { proposalVersionId: nonexistentVersionId } },
      }),
      audit: await prisma!.auditLog.count({
        where: {
          action: 'BOOKING_CREATED',
          afterState: { path: ['proposalVersionId'], equals: nonexistentVersionId },
        },
      }),
    };

    await expect(
      createBooking(otherTcActor, { proposalVersionId: nonexistentVersionId }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN' });

    expect(
      await prisma!.booking.count({ where: { proposalVersionId: nonexistentVersionId } }),
    ).toBe(before.booking);
    expect(
      await prisma!.bookingStatusHistory.count({
        where: { booking: { proposalVersionId: nonexistentVersionId } },
      }),
    ).toBe(before.history);
    expect(
      await prisma!.auditLog.count({
        where: {
          action: 'BOOKING_CREATED',
          afterState: { path: ['proposalVersionId'], equals: nonexistentVersionId },
        },
      }),
    ).toBe(before.audit);
  });

  // Individually-scoped before/after snapshot for a single Booking id —
  // captures Booking/BookingStatusHistory/AuditLog counts immediately
  // before one specific operation and returns a matching assertion helper,
  // never combined across more than one rejection call. AuditLog is scoped
  // to entityId alone (no action filter) so it proves nothing whatsoever
  // was written referencing this Booking — a strictly stronger, still
  // exactly-scoped proof that also covers the pure-read getBookingById
  // calls, which have no associated audit action of their own.
  async function captureBookingSnapshot(bookingId: string) {
    return {
      booking: await prisma!.booking.count({ where: { id: bookingId } }),
      history: await prisma!.bookingStatusHistory.count({ where: { bookingId } }),
      audit: await prisma!.auditLog.count({
        where: { entityType: 'Booking', entityId: bookingId },
      }),
    };
  }
  async function expectBookingSnapshotUnchanged(
    bookingId: string,
    before: { booking: number; history: number; audit: number },
  ) {
    expect(await prisma!.booking.count({ where: { id: bookingId } })).toBe(before.booking);
    expect(await prisma!.bookingStatusHistory.count({ where: { bookingId } })).toBe(before.history);
    expect(
      await prisma!.auditLog.count({ where: { entityType: 'Booking', entityId: bookingId } }),
    ).toBe(before.audit);
  }

  it('rejects an unassigned TRAVEL_CONSULTANT reading an existing-but-inaccessible Booking and a genuinely nonexistent one with the identical BOOKING_FORBIDDEN result, writing nothing for either rejection individually (D-032 §4 items 2 and 5)', async () => {
    const fixture = await createAcceptedProposalVersionFixture();
    const { booking } = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(booking.id);
    const nonexistentBookingId = randomUUID();

    // A read must not be allowed to write unnoticed — snapshots are taken
    // before each rejected read too, not only before rejected mutations.
    const beforeInaccessible = await captureBookingSnapshot(booking.id);
    await expect(getBookingById(otherTcActor, booking.id)).rejects.toMatchObject({
      code: 'BOOKING_FORBIDDEN',
    });
    await expectBookingSnapshotUnchanged(booking.id, beforeInaccessible);

    const beforeNonexistent = await captureBookingSnapshot(nonexistentBookingId);
    await expect(getBookingById(otherTcActor, nonexistentBookingId)).rejects.toMatchObject({
      code: 'BOOKING_FORBIDDEN',
    });
    await expectBookingSnapshotUnchanged(nonexistentBookingId, beforeNonexistent);
  });

  it('rejects an unassigned TRAVEL_CONSULTANT transitioning an existing-but-inaccessible Booking and a genuinely nonexistent one with the identical BOOKING_FORBIDDEN result, writing nothing for either rejection individually (D-032 §4 items 2 and 5)', async () => {
    const fixture = await createAcceptedProposalVersionFixture();
    const { booking } = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(booking.id);
    const nonexistentBookingId = randomUUID();

    const beforeInaccessible = await captureBookingSnapshot(booking.id);
    await expect(
      updateBookingStatus(otherTcActor, booking.id, {
        expectedStatus: 'DRAFT',
        newStatus: 'PENDING_CONFIRMATION',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_FORBIDDEN' });
    await expectBookingSnapshotUnchanged(booking.id, beforeInaccessible);
    const bookingRowAfterInaccessible = await prisma!.booking.findUnique({
      where: { id: booking.id },
    });
    expect(bookingRowAfterInaccessible?.status).toBe('DRAFT');

    const beforeNonexistent = await captureBookingSnapshot(nonexistentBookingId);
    await expect(
      updateBookingStatus(otherTcActor, nonexistentBookingId, {
        expectedStatus: 'DRAFT',
        newStatus: 'PENDING_CONFIRMATION',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_FORBIDDEN' });
    await expectBookingSnapshotUnchanged(nonexistentBookingId, beforeNonexistent);
  });

  it("scopes listBookings to an actively assigned TRAVEL_CONSULTANT's own Client, exactly, in both items and total, compared against unrestricted ADMIN_MANAGER visibility of every Booking in the database, and removes visibility once that assignment ends (D-032 §4 item 3)", async () => {
    // tcActor is the shared fixture several earlier tests in this file also
    // assign to their own Clients via createAcceptedProposalVersionFixture()
    // (which always assigns tcActor, never ends the prior assignment).
    // Rather than introducing a third, dedicated TRAVEL_CONSULTANT — which
    // would exceed D-032 §4's exact tcActor/otherTcActor fixture boundary —
    // every earlier active Client assignment tcActor still holds is ended
    // through the real endClientAssignment service first, isolating tcActor
    // to exactly the one target assignment this test creates next.
    const earlierAssignments = await prisma!.staffAssignment.findMany({
      where: { assignedStaffId: tcActor.id, clientId: { not: null }, endedAt: null },
      select: { clientId: true },
    });
    for (const { clientId } of earlierAssignments) {
      if (clientId) {
        await endClientAssignment(
          adminActor,
          clientId,
          'D-032 §4 item 3 listBookings-scoping test isolation (ending an earlier fixture assignment)',
        );
      }
    }
    expect(
      await prisma!.staffAssignment.count({
        where: { assignedStaffId: tcActor.id, clientId: { not: null }, endedAt: null },
      }),
    ).toBe(0);

    // The one intended Client, assigned to tcActor by the existing,
    // unmodified fixture chain, with one real, accepted Booking.
    const targetFixture = await createAcceptedProposalVersionFixture();
    const { booking: targetBooking } = await createBooking(adminActor, {
      proposalVersionId: targetFixture.versionId,
    });
    createdBookingIds.push(targetBooking.id);

    // tcActor now holds exactly one active Client assignment, and it
    // targets the intended Client.
    expect(
      await prisma!.staffAssignment.count({
        where: { assignedStaffId: tcActor.id, clientId: { not: null }, endedAt: null },
      }),
    ).toBe(1);
    const targetAssignment = await prisma!.staffAssignment.findFirst({
      where: { assignedStaffId: tcActor.id, clientId: { not: null }, endedAt: null },
    });
    expect(targetAssignment?.clientId).toBe(targetFixture.clientId);

    // While assigned to exactly the intended Client, tcActor's returned
    // Booking-id set equals exactly that Client's expected Booking-id set,
    // and .total equals that exact expected count.
    const isolatedResult = await listBookings(tcActor, { page: 1, pageSize: 100 });
    expect(new Set(isolatedResult.items.map((item) => item.id))).toEqual(
      new Set([targetBooking.id]),
    );
    expect(isolatedResult.total).toBe(1);

    // A second, real, accepted Booking whose Client tcActor is never
    // assigned to.
    const unrelatedClient = await createClientFixture();
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: otherTcActor.id,
        assignedByUserId: adminActor.id,
        clientId: unrelatedClient.id,
      },
    });
    const { proposal: unrelatedProposal, version: unrelatedVersion } = await createProposal(
      otherTcActor,
      {
        clientId: unrelatedClient.id,
        content: `Unrelated booking fixture content ${randomUUID()}.`,
      },
    );
    createdProposalIds.push(unrelatedProposal.id);
    await publishProposalVersion(otherTcActor, unrelatedVersion.id, {
      expectedCurrentVersionId: null,
    });
    await recordProposalResponse(adminActor, unrelatedVersion.id, {
      responseType: 'ACCEPT',
      respondedAt: new Date().toISOString(),
      responseMethod: 'phone',
      evidenceReference: `Unrelated booking fixture evidence ${randomUUID()}`,
    });
    const { booking: unrelatedBooking } = await createBooking(adminActor, {
      proposalVersionId: unrelatedVersion.id,
    });
    createdBookingIds.push(unrelatedBooking.id);

    // Adding the unrelated Booking does not change tcActor's .total, and
    // the unrelated id is absent from .items — the id set is still exactly
    // the one target Booking, not merely "still contains it."
    const afterUnrelatedResult = await listBookings(tcActor, { page: 1, pageSize: 100 });
    expect(afterUnrelatedResult.total).toBe(1);
    expect(afterUnrelatedResult.items.some((item) => item.id === unrelatedBooking.id)).toBe(false);
    expect(new Set(afterUnrelatedResult.items.map((item) => item.id))).toEqual(
      new Set([targetBooking.id]),
    );

    // adminActor sees every Booking currently present in the test database
    // for this suite checkpoint: the complete returned-id set and .total
    // are compared against a direct, scoped database inventory —
    // ADMIN_MANAGER's own listBookings applies no clientAssignmentFilter at
    // all (features/bookings/repository.ts), so this is a genuine
    // unrestricted-visibility proof, not merely "sees at least these two."
    // Pagination is handled explicitly rather than assuming pageSize: 100
    // covers every Booking every other test in this file may have created.
    const expectedAllBookingIds = new Set(
      (await prisma!.booking.findMany({ select: { id: true } })).map((row) => row.id),
    );
    const adminItems: { id: string }[] = [];
    let adminPage = 1;
    let adminTotal = 0;
    for (;;) {
      const pageResult = await listBookings(adminActor, { page: adminPage, pageSize: 100 });
      adminTotal = pageResult.total;
      adminItems.push(...pageResult.items);
      if (pageResult.items.length === 0 || adminItems.length >= pageResult.total) {
        break;
      }
      adminPage += 1;
    }
    expect(new Set(adminItems.map((item) => item.id))).toEqual(expectedAllBookingIds);
    expect(adminTotal).toBe(expectedAllBookingIds.size);

    // End tcActor's target Client assignment through the real, existing
    // assignment service (never a raw StaffAssignment mutation).
    await endClientAssignment(
      adminActor,
      targetFixture.clientId,
      'D-032 §4 item 3 listBookings-scoping test teardown',
    );

    // The target Booking disappears from both .items and .total; since
    // tcActor was isolated to exactly this one assignment for the
    // remainder of this test, the result is now empty and total exactly 0
    // — not merely "one fewer than before."
    const finalResult = await listBookings(tcActor, { page: 1, pageSize: 100 });
    expect(finalResult.items).toEqual([]);
    expect(finalResult.total).toBe(0);
  });

  it('allows an actively assigned TRAVEL_CONSULTANT to create, list, retrieve, and perform an allowed status transition on their own Booking end to end against real Postgres (D-032 §4 item 4)', async () => {
    const fixture = await createAcceptedProposalVersionFixture();

    const { booking: created, created: wasCreated } = await createBooking(tcActor, {
      proposalVersionId: fixture.versionId,
    });
    createdBookingIds.push(created.id);
    expect(wasCreated).toBe(true);

    const { items } = await listBookings(tcActor, { page: 1, pageSize: 100 });
    expect(items.some((item) => item.id === created.id)).toBe(true);

    const retrieved = await getBookingById(tcActor, created.id);
    expect(retrieved.id).toBe(created.id);
    expect(retrieved.status).toBe('DRAFT');

    const transitioned = await updateBookingStatus(tcActor, created.id, {
      expectedStatus: 'DRAFT',
      newStatus: 'PENDING_CONFIRMATION',
    });
    expect(transitioned.status).toBe('PENDING_CONFIRMATION');
  });

  it('proves a genuine divergent-target concurrency conflict between two real, simultaneously in-flight updateBookingStatus transactions via a captured-PID pg_blocking_pids() proof, resolving to exactly one winner and one BOOKING_CONFLICT (D-032 §4 item 8)', async () => {
    const fixture = await createAcceptedProposalVersionFixture();
    const { booking } = await createBooking(adminActor, { proposalVersionId: fixture.versionId });
    createdBookingIds.push(booking.id);

    // updateBookingStatus's real contention point is its own UPDATE
    // (updateBookingStatusWithHistory) on the target Booking row itself.
    // Holding an explicit `SELECT ... FOR UPDATE` on that row from a
    // separate, deliberately-held-open real Prisma transaction forces both
    // real updateBookingStatus calls to block for real at that UPDATE step
    // — each call's own earlier actor-scoped read (findBookingByIdForActor)
    // is a plain, non-locking SELECT never blocked by this lock, so both
    // calls genuinely reach and block at the same real contention point,
    // verified via pg_blocking_pids() before the blocker releases.
    // `timeout: 15000` overrides Prisma's own default 5000ms
    // interactive-transaction timeout, which would otherwise abort this
    // deliberately-long-held blocker transaction out from under us while it
    // is still waiting to be released — mirrors
    // proposals/service.integration.test.ts's identical publish-race
    // precedent exactly.
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
        await tx.$queryRaw`SELECT id FROM booking WHERE id = ${booking.id} FOR UPDATE`;
        signalBlockerReady();
        await blockerReleaseSignal;
      },
      { timeout: 15000 },
    );

    type PrismaTransactionMethod = NonNullable<typeof prisma>['$transaction'];
    const originalTransaction = prisma!.$transaction as PrismaTransactionMethod;

    let firstPromise: ReturnType<typeof updateBookingStatus> | undefined;
    let secondPromise: ReturnType<typeof updateBookingStatus> | undefined;

    try {
      // Races the ready signal against the blocker transaction's own
      // promise so a genuine failure inside the blocker (e.g. a SQL error)
      // surfaces immediately as a real rejection here, instead of hanging
      // forever on a manually-created signal that would then never resolve
      // or reject on its own.
      await Promise.race([
        blockerReadySignal,
        blockerTransactionPromise.then(() => {
          throw new Error(
            'Blocker transaction completed unexpectedly before signaling ready — the FOR UPDATE setup itself likely failed.',
          );
        }),
      ]);

      // A narrow, test-only interception of the real prisma.$transaction
      // method, installed only after the blocker already holds the row
      // lock. For exactly the next two invocations — each real
      // updateBookingStatus call's own first attempt — it captures that
      // transaction's own real pg_backend_pid() as the first operation
      // inside the callback, then delegates the real, completely unmodified
      // callback onward via Reflect.apply against the real prisma receiver
      // (mirroring proposals/service.integration.test.ts's established
      // createPidCapturingTransactionWrapper pattern). Any further
      // invocation beyond the first two (e.g. a bounded retry after a
      // genuine serialization conflict) passes straight through to the
      // original method, completely unwrapped.
      let invocationCount = 0;
      let captureFirstPid!: (pid: number) => void;
      let captureSecondPid!: (pid: number) => void;
      const firstPidCaptured = new Promise<number>((resolve) => {
        captureFirstPid = resolve;
      });
      const secondPidCaptured = new Promise<number>((resolve) => {
        captureSecondPid = resolve;
      });

      const pidCapturingTransaction = (async (...args: Parameters<PrismaTransactionMethod>) => {
        const invocationIndex = invocationCount;
        invocationCount += 1;
        if (invocationIndex >= 2) {
          return Reflect.apply(
            originalTransaction as (...callArgs: unknown[]) => unknown,
            prisma!,
            args,
          );
        }
        const [fn, callOptions] = args as unknown as [
          (tx: Prisma.TransactionClient) => Promise<unknown>,
          Record<string, unknown> | undefined,
        ];
        const wrappedFn = async (tx: Prisma.TransactionClient) => {
          const pidRows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          const pid = Number(pidRows[0]?.pid);
          if (invocationIndex === 0) {
            captureFirstPid(pid);
          } else {
            captureSecondPid(pid);
          }
          return fn(tx);
        };
        return Reflect.apply(originalTransaction as (...callArgs: unknown[]) => unknown, prisma!, [
          wrappedFn,
          // Overrides Prisma's own default 5000ms interactive-transaction
          // timeout, which would otherwise abort one of these two
          // deliberately-blocked transactions out from under this test
          // before the poll below ever observes it as blocked — mirrors
          // proposals/service.integration.test.ts's identical
          // createPidCapturingTransactionWrapper precedent exactly.
          { ...callOptions, timeout: 15000 },
        ]);
      }) as PrismaTransactionMethod;

      prisma!.$transaction = pidCapturingTransaction;

      firstPromise = updateBookingStatus(adminActor, booking.id, {
        expectedStatus: 'DRAFT',
        newStatus: 'PENDING_CONFIRMATION',
      });
      secondPromise = updateBookingStatus(adminActor, booking.id, {
        expectedStatus: 'DRAFT',
        newStatus: 'CANCELLED',
      });

      const [pid1, pid2] = await Promise.all([firstPidCaptured, secondPidCaptured]);
      // Sanity check: the two captured service-operation connections are
      // genuinely distinct from the external blocker's own connection, and
      // from each other — confirms this test is observing three real,
      // separate backends, not accidentally re-measuring the blocker or
      // one service call as if it were the other.
      expect(pid1).not.toBe(blockerPid);
      expect(pid2).not.toBe(blockerPid);
      expect(pid1).not.toBe(pid2);

      // Recursively follows pg_blocking_pids() from a starting pid,
      // breadth-first, through the real PostgreSQL blocking-dependency
      // graph, and reports whether `targetPid` is reachable anywhere in it.
      // A visited-pid set makes termination unconditional even if the
      // graph contained a cycle (it cannot, for a genuine lock-wait
      // dependency graph, but this guards the traversal regardless); a
      // second, independent `maxDepth` bound caps the number of BFS
      // expansions. This deliberately does not accept "pg_blocking_pids(x)
      // is non-empty" as proof of anything — pg_blocking_pids() names both
      // hard blockers (holding the lock outright) and soft blockers
      // (queued ahead in the same wait queue, per PostgreSQL's own
      // documented behavior), so a merely nonempty result only proves *a*
      // blocker exists, never *which* one. Only finding the exact,
      // separately-captured external blocker pid somewhere in the
      // traversed graph counts as proof.
      async function blockingChainReaches(
        startPid: number,
        targetPid: number,
        maxDepth = 10,
      ): Promise<boolean> {
        const visited = new Set<number>([startPid]);
        let frontier = [startPid];
        for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
          const nextFrontier: number[] = [];
          for (const pid of frontier) {
            const rows = await prisma!.$queryRaw<{ blocker: number }[]>`
              SELECT unnest(pg_blocking_pids(${pid})) AS blocker
            `;
            for (const row of rows) {
              const blocker = Number(row.blocker);
              if (blocker === targetPid) {
                return true;
              }
              if (!visited.has(blocker)) {
                visited.add(blocker);
                nextFrontier.push(blocker);
              }
            }
          }
          frontier = nextFrontier;
        }
        return false;
      }

      // Polls — real PostgreSQL, never a fixed delay, bounded by
      // `timeoutMs` — until each of the two specifically-captured
      // service-operation backend pids has its own real blocking-dependency
      // chain (via blockingChainReaches above) reaching the exact,
      // separately-captured external blocker pid, or throws after the
      // timeout. This is the corrected replacement for an earlier version
      // of this helper that accepted a merely nonempty pg_blocking_pids()
      // result as sufficient proof — insufficient, since PostgreSQL's row
      // lock wait queue is transitive (a second real waiter for the same
      // row blocks on the first real waiter's transaction id, not
      // necessarily directly on the original external blocker), so
      // checking only "blocked by something" could pass even for a waiter
      // blocked by something other than this test's own blocker. Walking
      // the full chain and requiring it to actually reach the known,
      // captured blocker pid closes that gap.
      async function waitUntilBothChainsReachBlocker(
        waiterPids: [number, number],
        blockerPidTarget: number,
        timeoutMs = 10000,
      ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const [reaches1, reaches2] = await Promise.all([
            blockingChainReaches(waiterPids[0], blockerPidTarget),
            blockingChainReaches(waiterPids[1], blockerPidTarget),
          ]);
          if (reaches1 && reaches2) {
            return;
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Timed out after ${timeoutMs}ms waiting for both pids ${waiterPids.join(',')}'s blocking chains to reach blocker pid ${blockerPidTarget} (pid ${waiterPids[0]} reached: ${reaches1}, pid ${waiterPids[1]} reached: ${reaches2}).`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      await waitUntilBothChainsReachBlocker([pid1, pid2], blockerPid);

      // Evidence, not merely a boolean: re-confirms and records that each
      // captured service pid's blocking chain genuinely reaches the exact
      // captured external blocker pid, immediately before that blocker is
      // released — the same predicate waitUntilBothChainsReachBlocker just
      // polled for, asserted here explicitly so a regression that weakened
      // the wait loop back to a shallower check would still fail this
      // assertion directly.
      expect(await blockingChainReaches(pid1, blockerPid)).toBe(true);
      expect(await blockingChainReaches(pid2, blockerPid)).toBe(true);

      releaseBlocker();
      await blockerTransactionPromise;

      const results = await Promise.allSettled([firstPromise, secondPromise]);

      const fulfilled = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof updateBookingStatus>>> =>
          result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejectionReason = rejected[0]!.reason;
      expect(rejectionReason).toBeInstanceOf(BookingError);
      expect(rejectionReason).toMatchObject({ code: 'BOOKING_CONFLICT', status: 409 });

      const winningTarget = fulfilled[0]!.value.status;
      expect(['PENDING_CONFIRMATION', 'CANCELLED']).toContain(winningTarget);
      const losingTarget =
        winningTarget === 'PENDING_CONFIRMATION' ? 'CANCELLED' : 'PENDING_CONFIRMATION';

      const bookingRow = await prisma!.booking.findUnique({ where: { id: booking.id } });
      expect(bookingRow?.status).toBe(winningTarget);

      expect(
        await prisma!.bookingStatusHistory.count({
          where: { bookingId: booking.id, previousStatus: 'DRAFT' },
        }),
      ).toBe(1);
      expect(
        await prisma!.bookingStatusHistory.count({
          where: { bookingId: booking.id, newStatus: losingTarget },
        }),
      ).toBe(0);
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Booking', entityId: booking.id, action: 'BOOKING_STATUS_CHANGED' },
        }),
      ).toBe(1);
    } finally {
      // Restored/released/settled unconditionally — even when an earlier
      // step above throws (e.g. waitUntilBothBlockedOn times out or an
      // assertion fails) — so no intercepted prisma.$transaction reference,
      // no open transaction, and no dangling unhandled rejection outlives
      // this test.
      prisma!.$transaction = originalTransaction;
      releaseBlocker();
      await blockerTransactionPromise.catch(() => {});
      await Promise.allSettled(
        [firstPromise, secondPromise].filter((p): p is NonNullable<typeof p> => p !== undefined),
      );
    }
  }, 20000);
});
