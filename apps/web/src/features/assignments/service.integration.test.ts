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
// Extended by docs/HERITAGE_V3_DECISIONS_LOG.md D-030 §2 with direct
// real-PostgreSQL AuditLog coverage for `setLeadAssignment`,
// `endLeadAssignment`, `setClientAssignment`, `endClientAssignment`, and
// `setBookingAssignment` — the 8 assertions covering
// LEAD_ASSIGNMENT_CREATED/REPLACED/ENDED,
// CLIENT_ASSIGNMENT_CREATED/REPLACED/ENDED, and
// BOOKING_ASSIGNMENT_CREATED/REPLACED that D-030's discovery pass found
// unverified against a real database. The Booking-assignment fixture chain
// follows D-030 §3 exactly (a raw Client fixture, then the real
// `createProposal` -> `publishProposalVersion` ->
// `recordProposalResponse('ACCEPT')` -> `createBooking` chain) using this
// feature's own untouched `setBookingAssignment`, never a raw Booking
// insert.
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
  let setLeadAssignment: (typeof import('./service'))['setLeadAssignment'];
  let endLeadAssignment: (typeof import('./service'))['endLeadAssignment'];
  let setClientAssignment: (typeof import('./service'))['setClientAssignment'];
  let endClientAssignment: (typeof import('./service'))['endClientAssignment'];
  let setBookingAssignment: (typeof import('./service'))['setBookingAssignment'];
  let AssignmentError: (typeof import('./errors'))['AssignmentError'];
  let createProposal: (typeof import('@/features/proposals/service'))['createProposal'];
  let publishProposalVersion: (typeof import('@/features/proposals/service'))['publishProposalVersion'];
  let recordProposalResponse: (typeof import('@/features/proposals/service'))['recordProposalResponse'];
  let createBooking: (typeof import('@/features/bookings/service'))['createBooking'];

  let adminActor: AuthenticatedUser;
  let chainTcActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  const createdUserIds: string[] = [];
  const createdLeadIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdProposalIds: string[] = [];
  const createdBookingIds: string[] = [];

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
    ({
      listEligibleTravelConsultants,
      setLeadAssignment,
      endLeadAssignment,
      setClientAssignment,
      endClientAssignment,
      setBookingAssignment,
    } = await import('./service'));
    ({ AssignmentError } = await import('./errors'));
    ({ createProposal, publishProposalVersion, recordProposalResponse } =
      await import('@/features/proposals/service'));
    ({ createBooking } = await import('@/features/bookings/service'));

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

    // A dedicated TRAVEL_CONSULTANT actor for the D-030 Booking-assignment
    // fixture chain below (createAcceptedBookingFixture) — distinct from
    // activeTc1Id/activeTc2Id, which the D-030 tests use only as assignment
    // *targets* (assignedStaffId), never as the acting Proposal author.
    chainTcActor = {
      id: randomUUID(),
      name: `Chain Consultant ${unique}`,
      email: `chain-tc-${unique}@example.test`,
      role: 'TRAVEL_CONSULTANT',
    };
    await prisma.user.create({ data: { ...chainTcActor, isActive: true } });
    createdUserIds.push(chainTcActor.id);
  });

  afterAll(async () => {
    try {
      if (prisma) {
        try {
          // Deletion order respects onDelete: Restrict throughout
          // schema.prisma, extended from this file's own prior
          // user-only cleanup (D-030 introduces Lead/Client/Proposal/
          // Booking fixtures this file previously never created) to mirror
          // features/clients/service.integration.test.ts's and
          // features/proposals/service.integration.test.ts's identical
          // precedent: StaffAssignment rows referencing a tracked Lead/
          // Client/Booking or actor go first; then AuditLog rows
          // referencing a tracked actor; then BookingStatusHistory and
          // Booking (Booking references ProposalVersion and Client, both
          // Restrict); then ProposalAcceptance and ProposalVersion (both
          // reference Proposal, Restrict); then Proposal (references
          // Client, Restrict); then LeadStatusHistory and Lead; then
          // Client; then User last.
          await prisma.staffAssignment.deleteMany({
            where: {
              OR: [
                { bookingId: { in: createdBookingIds } },
                { leadId: { in: createdLeadIds } },
                { clientId: { in: createdClientIds } },
                { assignedStaffId: { in: createdUserIds } },
                { assignedByUserId: { in: createdUserIds } },
              ],
            },
          });
          await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
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
          if (createdLeadIds.length > 0) {
            await prisma.leadStatusHistory.deleteMany({
              where: { leadId: { in: createdLeadIds } },
            });
            await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
          }
          if (createdClientIds.length > 0) {
            await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
          }
          if (createdUserIds.length > 0) {
            await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
          }
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

  // --- D-030 fixture helpers ---

  /** Inserts a standalone Lead row directly — this feature introduces no
   * Lead-creation path of its own — tracked for cleanup. Mirrors
   * features/clients/service.integration.test.ts's `createClientFixture`
   * precedent for the equivalent Client case below. */
  async function createLeadFixture(fullName: string): Promise<{ id: string }> {
    const id = randomUUID();
    await prisma!.lead.create({
      data: { id, fullName, source: 'Referral', email: `d030-lead-${randomUUID()}@example.test` },
    });
    createdLeadIds.push(id);
    return { id };
  }

  /** Inserts a standalone Client row directly — mirrors
   * features/clients/service.integration.test.ts's and
   * features/proposals/service.integration.test.ts's own identical
   * `createClientFixture` precedent (neither feature's own service
   * authorizes a Client-creation path). */
  async function createClientFixture(fullName: string): Promise<{ id: string }> {
    const id = randomUUID();
    await prisma!.client.create({
      data: { id, fullName, email: `d030-client-${randomUUID()}@example.test` },
    });
    createdClientIds.push(id);
    return { id };
  }

  /**
   * Builds a real, database-backed accepted Booking via the exact fixture
   * chain D-030 §3 requires: a raw Client fixture, then the real
   * `createProposal`, `publishProposalVersion`, `recordProposalResponse`
   * (ACCEPT), and `createBooking` — never a raw Booking insert.
   * `chainTcActor` is assigned to the fixture Client via a raw
   * StaffAssignment insert first (mirroring
   * features/proposals/service.integration.test.ts's own
   * `assignClientToStaff` precedent) — required because `createProposal`
   * (D-027 §3) only permits an author who currently holds the target
   * Client's active assignment; this is setup for the chain, not itself one
   * of D-030 §3's five named steps. Publication (step c) is required, not
   * optional, before `recordProposalResponse` can succeed — see D-030 §3's
   * own rationale.
   */
  async function createAcceptedBookingFixture(): Promise<{ bookingId: string }> {
    const client = await createClientFixture(`D-030 Booking Fixture Client ${randomUUID()}`);
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: chainTcActor.id,
        assignedByUserId: adminActor.id,
        clientId: client.id,
      },
    });

    const { proposal, version } = await createProposal(chainTcActor, {
      clientId: client.id,
      content: 'D-030 booking fixture chain content.',
    });
    createdProposalIds.push(proposal.id);

    await publishProposalVersion(chainTcActor, version.id, { expectedCurrentVersionId: null });

    await recordProposalResponse(adminActor, version.id, {
      responseType: 'ACCEPT',
      respondedAt: new Date().toISOString(),
      responseMethod: 'phone',
      evidenceReference: `D-030 fixture evidence ${randomUUID()}`,
    });

    const { booking } = await createBooking(adminActor, { proposalVersionId: version.id });
    createdBookingIds.push(booking.id);

    return { bookingId: booking.id };
  }

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

  // ---------------------------------------------------------------------
  // D-030 — direct real-PostgreSQL AuditLog coverage for setLeadAssignment,
  // endLeadAssignment, setClientAssignment, endClientAssignment, and
  // setBookingAssignment (docs/HERITAGE_V3_DECISIONS_LOG.md D-030 §2). Each
  // test verifies the exact persisted action, entityType, entityId, and
  // actorId against the real database.
  // ---------------------------------------------------------------------

  it('creates then replaces a Lead assignment, writing LEAD_ASSIGNMENT_CREATED then LEAD_ASSIGNMENT_REPLACED with exact actor/entity attribution', async () => {
    const lead = await createLeadFixture('D-030 Lead Assignment Fixture');

    const created = await setLeadAssignment(adminActor, lead.id, activeTc1Id);
    expect(created.assignedStaffId).toBe(activeTc1Id);

    const createdAudits = await prisma!.auditLog.findMany({
      where: { entityType: 'Lead', entityId: lead.id, action: 'LEAD_ASSIGNMENT_CREATED' },
    });
    expect(createdAudits).toHaveLength(1);
    expect(createdAudits[0]?.actorId).toBe(adminActor.id);
    expect(createdAudits[0]?.beforeState).toBeNull();

    const replaced = await setLeadAssignment(
      adminActor,
      lead.id,
      activeTc2Id,
      'D-030 reassignment test',
    );
    expect(replaced.assignedStaffId).toBe(activeTc2Id);

    const replacedAudits = await prisma!.auditLog.findMany({
      where: { entityType: 'Lead', entityId: lead.id, action: 'LEAD_ASSIGNMENT_REPLACED' },
    });
    expect(replacedAudits).toHaveLength(1);
    expect(replacedAudits[0]?.actorId).toBe(adminActor.id);
    expect(replacedAudits[0]?.beforeState).not.toBeNull();
  });

  it('ends a Lead assignment, writing LEAD_ASSIGNMENT_ENDED with exact actor/entity attribution', async () => {
    const lead = await createLeadFixture('D-030 Lead End Fixture');
    await setLeadAssignment(adminActor, lead.id, activeTc1Id);

    const ended = await endLeadAssignment(adminActor, lead.id, 'D-030 end-assignment test');
    expect(ended?.endedAt).not.toBeNull();

    const endedAudits = await prisma!.auditLog.findMany({
      where: { entityType: 'Lead', entityId: lead.id, action: 'LEAD_ASSIGNMENT_ENDED' },
    });
    expect(endedAudits).toHaveLength(1);
    expect(endedAudits[0]?.actorId).toBe(adminActor.id);
  });

  it('creates then replaces a Client assignment, writing CLIENT_ASSIGNMENT_CREATED then CLIENT_ASSIGNMENT_REPLACED with exact actor/entity attribution', async () => {
    const client = await createClientFixture('D-030 Client Assignment Fixture');

    const created = await setClientAssignment(adminActor, client.id, activeTc1Id);
    expect(created.assignedStaffId).toBe(activeTc1Id);

    const createdAudits = await prisma!.auditLog.findMany({
      where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_ASSIGNMENT_CREATED' },
    });
    expect(createdAudits).toHaveLength(1);
    expect(createdAudits[0]?.actorId).toBe(adminActor.id);
    expect(createdAudits[0]?.beforeState).toBeNull();

    const replaced = await setClientAssignment(
      adminActor,
      client.id,
      activeTc2Id,
      'D-030 reassignment test',
    );
    expect(replaced.assignedStaffId).toBe(activeTc2Id);

    const replacedAudits = await prisma!.auditLog.findMany({
      where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_ASSIGNMENT_REPLACED' },
    });
    expect(replacedAudits).toHaveLength(1);
    expect(replacedAudits[0]?.actorId).toBe(adminActor.id);
    expect(replacedAudits[0]?.beforeState).not.toBeNull();
  });

  it('ends a Client assignment, writing CLIENT_ASSIGNMENT_ENDED with exact actor/entity attribution', async () => {
    const client = await createClientFixture('D-030 Client End Fixture');
    await setClientAssignment(adminActor, client.id, activeTc1Id);

    const ended = await endClientAssignment(adminActor, client.id, 'D-030 end-assignment test');
    expect(ended?.endedAt).not.toBeNull();

    const endedAudits = await prisma!.auditLog.findMany({
      where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_ASSIGNMENT_ENDED' },
    });
    expect(endedAudits).toHaveLength(1);
    expect(endedAudits[0]?.actorId).toBe(adminActor.id);
  });

  it('creates then replaces a Booking assignment (via the full D-030 §3 accepted-Booking fixture chain), writing BOOKING_ASSIGNMENT_CREATED then BOOKING_ASSIGNMENT_REPLACED with exact actor/entity attribution', async () => {
    const { bookingId } = await createAcceptedBookingFixture();

    const created = await setBookingAssignment(adminActor, bookingId, activeTc1Id);
    expect(created.assignedStaffId).toBe(activeTc1Id);

    const createdAudits = await prisma!.auditLog.findMany({
      where: {
        entityType: 'Booking',
        entityId: bookingId,
        action: 'BOOKING_ASSIGNMENT_CREATED',
      },
    });
    expect(createdAudits).toHaveLength(1);
    expect(createdAudits[0]?.actorId).toBe(adminActor.id);
    expect(createdAudits[0]?.beforeState).toBeNull();

    const replaced = await setBookingAssignment(
      adminActor,
      bookingId,
      activeTc2Id,
      'D-030 reassignment test',
    );
    expect(replaced.assignedStaffId).toBe(activeTc2Id);

    const replacedAudits = await prisma!.auditLog.findMany({
      where: {
        entityType: 'Booking',
        entityId: bookingId,
        action: 'BOOKING_ASSIGNMENT_REPLACED',
      },
    });
    expect(replacedAudits).toHaveLength(1);
    expect(replacedAudits[0]?.actorId).toBe(adminActor.id);
    expect(replacedAudits[0]?.beforeState).not.toBeNull();
  }, 20000);
});
