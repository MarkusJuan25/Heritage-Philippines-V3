import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/lib/auth/guards';

// Database-backed integration test satisfying
// docs/HERITAGE_V3_DECISIONS_LOG.md D-022's own "automated unit, route, and
// real-PostgreSQL integration coverage" boundary (D-022 §1) and D-021's
// Phase 2 verification boundary ("demonstrated in a real PostgreSQL-backed
// development/test environment... not merely against mocked repositories").
// Every mocked test elsewhere in this feature (service.test.ts,
// repository.test.ts, the three apps/web/src/app/api/leads/**/route.test.ts
// files) intentionally mocks Prisma and features/assignments — none of them
// can prove the real transactional/assignment/duplicate-detection behavior
// against an actual PostgreSQL database with real foreign-key/CHECK
// constraints. This file proves it for real, against a dedicated,
// disposable PostgreSQL database — never the shared local `heritage_v3_dev`
// database — using this feature's own real, unmodified `service.ts` and
// `features/assignments` exports.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/staff/service.integration.test.ts — see that file's own doc
// comment for the full rationale. In short: no `@/lib/db` or `./service`
// static import; everything real is imported dynamically inside `beforeAll`
// only after `TEST_DATABASE_URL` has been validated; the suite is
// `describe.skipIf`-skipped entirely (no import, no connection) whenever
// `TEST_DATABASE_URL` is unset, which is the default for `pnpm test` today.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

/**
 * Parses and validates `TEST_DATABASE_URL` without ever interpolating the
 * raw connection string into a thrown message — mirrors
 * features/staff/service.integration.test.ts's `validateTestDatabaseUrl`
 * exactly (a deliberate, self-contained copy, not a shared import, matching
 * that file's own precedent of not sharing this safety guard across
 * feature integration suites).
 */
function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the leads integration suite.',
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

// Captured before any mutation, mirroring
// features/staff/service.integration.test.ts's identical discipline, so
// `afterAll` can restore the process environment exactly as it found it —
// this file runs inside a shared Vitest worker process, and `process.env`
// mutations are not automatically isolated per test file.
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;

describe.skipIf(!hasTestDatabaseUrl)('leads service integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let createLead: (typeof import('./service'))['createLead'];
  let getLeadById: (typeof import('./service'))['getLeadById'];
  let listLeads: (typeof import('./service'))['listLeads'];
  let updateLead: (typeof import('./service'))['updateLead'];
  let updateLeadStatus: (typeof import('./service'))['updateLeadStatus'];
  let getLeadStatusHistory: (typeof import('./service'))['getLeadStatusHistory'];
  let convertLead: (typeof import('./service'))['convertLead'];
  let getConversionOptions: (typeof import('./service'))['getConversionOptions'];
  let LeadError: (typeof import('./errors'))['LeadError'];
  let normalizeEmail: (typeof import('@/lib/contact-normalization'))['normalizeEmail'];
  let normalizePhone: (typeof import('@/lib/contact-normalization'))['normalizePhone'];
  // D-031 F-01: the real, unmodified assignments service, used only to
  // perform a genuine concurrent ADMIN_MANAGER reassignment — never mocked,
  // never a modification of features/assignments/service.integration.test.ts.
  let setLeadAssignment: (typeof import('@/features/assignments/service'))['setLeadAssignment'];

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;
  let otherTcActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  const actorUserIds: string[] = [];
  const createdLeadIds: string[] = [];
  const createdClientIds: string[] = [];

  beforeAll(async () => {
    // 1. Safety guard — must run before any env mutation, import, or
    // connection (mirrors features/staff/service.integration.test.ts).
    validateTestDatabaseUrl(rawTestDatabaseUrl!);

    // 2. Establish the environment the real modules will read at import
    // time. `@/lib/db` transitively calls `@/lib/env`'s `getServerEnv()`,
    // which validates the full shared server env schema — including
    // BETTER_AUTH_SECRET/BETTER_AUTH_URL, even though this suite never
    // calls into Better Auth itself — so both must be present before
    // `@/lib/db` is ever imported, exactly as
    // features/staff/service.integration.test.ts already established for
    // its own (real) Better Auth usage.
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
    ({
      createLead,
      getLeadById,
      listLeads,
      updateLead,
      updateLeadStatus,
      getLeadStatusHistory,
      convertLead,
      getConversionOptions,
    } = await import('./service'));
    ({ LeadError } = await import('./errors'));
    ({ normalizeEmail, normalizePhone } = await import('@/lib/contact-normalization'));
    ({ setLeadAssignment } = await import('@/features/assignments/service'));

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
      const email = `leads-integration-${role.toLowerCase()}-${randomUUID()}@example.test`;
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
          // Deletion order respects onDelete: Restrict — LeadStatusHistory
          // and StaffAssignment rows referencing a Lead/User must go first,
          // then AuditLog rows referencing an actor, then the
          // Lead/Client/User rows themselves.
          if (createdLeadIds.length > 0) {
            await prisma.leadStatusHistory.deleteMany({
              where: { leadId: { in: createdLeadIds } },
            });
            await prisma.staffAssignment.deleteMany({
              where: { leadId: { in: createdLeadIds } },
            });
          }
          await prisma.staffAssignment.deleteMany({
            where: { assignedStaffId: { in: actorUserIds } },
          });
          await prisma.auditLog.deleteMany({ where: { actorId: { in: actorUserIds } } });
          if (createdLeadIds.length > 0) {
            await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
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
      // (e.g. `validateTestDatabaseUrl` threw, or the `@/lib/db` import
      // itself threw after these were already set) or when cleanup above
      // throws — so this suite never leaves a stale
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

  it('creates, lists, retrieves, edits, and transitions a Lead end to end for ADMIN_MANAGER', async () => {
    const email = `integration-lead-${randomUUID()}@example.com`;
    const { lead: created } = await createLead(adminActor, {
      fullName: 'Integration Lead',
      source: 'Contact page',
      email,
    });
    createdLeadIds.push(created.id);
    expect(created.status).toBe('NEW');
    // Stage 2 correction: POST /api/leads must never carry `assignment` at
    // all — createLeadWithInitialHistory's response keeps its exact
    // pre-D-023 (afe1201) shape.
    expect(created).not.toHaveProperty('assignment');

    const retrieved = await getLeadById(adminActor, created.id);
    expect(retrieved.id).toBe(created.id);
    // D-023 §5: GET /api/leads/[id] is the read path that carries
    // `assignment` — an ADMIN_MANAGER-created Lead is never auto-assigned.
    expect(retrieved.assignment).toBeNull();

    const { items } = await listLeads(adminActor, { page: 1, pageSize: 100 });
    expect(items.some((item) => item.id === created.id)).toBe(true);

    const { lead: edited } = await updateLead(adminActor, created.id, {
      notes: 'Called back once',
    });
    expect(edited.notes).toBe('Called back once');
    // Stage 2 correction: PATCH /api/leads/[id] must never carry `assignment`.
    expect(edited).not.toHaveProperty('assignment');

    const transitioned = await updateLeadStatus(adminActor, created.id, {
      expectedStatus: 'NEW',
      newStatus: 'QUALIFIED',
    });
    expect(transitioned.status).toBe('QUALIFIED');
    // Stage 2 correction: PUT /api/leads/[id]/status must never carry
    // `assignment`.
    expect(transitioned).not.toHaveProperty('assignment');

    const history = await prisma!.leadStatusHistory.findMany({
      where: { leadId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((row) => row.newStatus)).toEqual(['NEW', 'QUALIFIED']);

    const auditActions = await prisma!.auditLog.findMany({
      where: { entityType: 'Lead', entityId: created.id },
    });
    expect(auditActions.map((row) => row.action).sort()).toEqual(
      ['LEAD_CREATED', 'LEAD_STATUS_CHANGED', 'LEAD_UPDATED'].sort(),
    );

    // D-023 §8: paginated status-history read, ordered createdAt desc, id
    // desc — the transition (NEW -> QUALIFIED) must appear before the
    // initial creation row.
    const statusHistory = await getLeadStatusHistory(adminActor, created.id, {
      page: 1,
      pageSize: 20,
    });
    expect(statusHistory.total).toBe(2);
    expect(statusHistory.items.map((item) => item.newStatus)).toEqual(['QUALIFIED', 'NEW']);
    expect(statusHistory.items[0]?.previousStatus).toBe('NEW');
    expect(statusHistory.items[0]?.changedByUserId).toBe(adminActor.id);
    expect(statusHistory.items[0]?.changedByName).toBe(adminActor.name);
    expect(statusHistory.items[1]?.previousStatus).toBeNull();
    // No reason field is ever present (D-023 §8 — reasons live only in
    // sanitized AuditLog state, out of scope for this read).
    expect(JSON.stringify(statusHistory.items)).not.toContain('"reason"');
  });

  it('atomically self-assigns a TRAVEL_CONSULTANT-created Lead, visible to its creator and ADMIN_MANAGER but not a different TC', async () => {
    const phone = '0917 111 2222';
    const { lead: created } = await createLead(tcActor, {
      fullName: 'TC Created Lead',
      source: 'Phone inquiry',
      phone,
    });
    createdLeadIds.push(created.id);
    // Stage 2 correction: POST /api/leads must never carry `assignment` —
    // not even null — regardless of whether the creator was auto-assigned.
    // A subsequent GET (below) is the read path that reflects it.
    expect(created).not.toHaveProperty('assignment');

    const assignment = await prisma!.staffAssignment.findFirst({
      where: { leadId: created.id, endedAt: null },
    });
    expect(assignment?.assignedStaffId).toBe(tcActor.id);
    expect(assignment?.assignedByUserId).toBe(tcActor.id);

    const assignmentAudit = await prisma!.auditLog.findFirst({
      where: { entityType: 'Lead', entityId: created.id, action: 'LEAD_ASSIGNMENT_CREATED' },
    });
    expect(assignmentAudit).not.toBeNull();

    // D-023 §5: GET /api/leads/[id] (unlike the POST creation response
    // above) is read fresh from the database, so it correctly reflects the
    // self-assignment written immediately after creation, in the same
    // transaction.
    await expect(getLeadById(tcActor, created.id)).resolves.toMatchObject({
      id: created.id,
      assignment: { staffId: tcActor.id, staffName: tcActor.name },
    });
    await expect(getLeadById(adminActor, created.id)).resolves.toMatchObject({
      id: created.id,
      assignment: { staffId: tcActor.id, staffName: tcActor.name },
    });
    await expect(getLeadById(otherTcActor, created.id)).rejects.toThrow(LeadError);
    // D-023 §8: status-history read preserves the identical anti-
    // enumeration behavior — a TC with no active assignment to this Lead
    // is rejected exactly like getLeadById.
    await expect(
      getLeadStatusHistory(otherTcActor, created.id, { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'LEAD_FORBIDDEN' });

    const { items: otherTcItems } = await listLeads(otherTcActor, { page: 1, pageSize: 100 });
    expect(otherTcItems.some((item) => item.id === created.id)).toBe(false);

    const { items: creatorItems } = await listLeads(tcActor, { page: 1, pageSize: 100 });
    expect(creatorItems.some((item) => item.id === created.id)).toBe(true);
  });

  it('surfaces a duplicate Lead match, shaped by the caller authorization, without leaking a restricted match', async () => {
    const sharedPhone = `0917${Math.floor(1000000 + Math.random() * 8999999)}`;

    // First Lead, assigned to otherTcActor via TC self-assignment.
    const { lead: firstLead } = await createLead(otherTcActor, {
      fullName: 'First Contact',
      source: 'Walk-in',
      phone: sharedPhone,
    });
    createdLeadIds.push(firstLead.id);

    // ADMIN_MANAGER creating a second Lead with the same phone sees the full match.
    const {
      lead: secondLead,
      duplicateMatches: adminMatches,
      restrictedMatchDetected: adminRestricted,
    } = await createLead(adminActor, {
      fullName: 'Second Contact (admin)',
      source: 'Walk-in',
      phone: sharedPhone,
    });
    createdLeadIds.push(secondLead.id);
    expect(adminRestricted).toBe(false);
    expect(adminMatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'LEAD', id: firstLead.id, matchedOn: ['PHONE'] }),
      ]),
    );

    // tcActor (not assigned to firstLead) creating a third Lead with the same
    // phone must not learn firstLead's identity — only the restricted flag.
    const {
      lead: thirdLead,
      duplicateMatches: tcMatches,
      restrictedMatchDetected: tcRestricted,
    } = await createLead(tcActor, {
      fullName: 'Third Contact (tc)',
      source: 'Walk-in',
      phone: sharedPhone,
    });
    createdLeadIds.push(thirdLead.id);
    expect(tcRestricted).toBe(true);
    expect(tcMatches.some((match) => match.id === firstLead.id)).toBe(false);
  });

  it('returns LEAD_CONFLICT when expectedStatus is stale relative to the real current status', async () => {
    const { lead: created } = await createLead(adminActor, {
      fullName: 'Conflict Lead',
      source: 'Walk-in',
      email: `conflict-${randomUUID()}@example.com`,
    });
    createdLeadIds.push(created.id);

    await updateLeadStatus(adminActor, created.id, {
      expectedStatus: 'NEW',
      newStatus: 'UNDER_REVIEW',
    });

    await expect(
      updateLeadStatus(adminActor, created.id, { expectedStatus: 'NEW', newStatus: 'CONTACTED' }),
    ).rejects.toMatchObject({ code: 'LEAD_CONFLICT' });
  });

  // D-024 Lead-to-Client conversion — real-PostgreSQL coverage of
  // `convertLead` (Stage E). Every scenario below proves, against real
  // foreign-key/CHECK/partial-unique-index constraints, what
  // service.test.ts already proves with mocked repositories: this suite
  // never redefines the contract, only demonstrates it end to end. Uses the
  // same fixture actors, `createdLeadIds`/`createdClientIds` tracking, and
  // `afterAll` cleanup already established above — no separate
  // beforeAll/afterAll, no separate database-safety scaffold.
  describe('convertLead (D-024 Lead-to-Client conversion)', () => {
    /** Creates a Lead as `actor` and transitions it NEW -> QUALIFIED (no
     * reason required for that edge — transitions.ts), tracking the Lead id
     * for cleanup. Returns the QUALIFIED LeadRecord. */
    async function createQualifiedLead(
      actor: AuthenticatedUser,
      input: { fullName: string; source: string; email?: string; phone?: string },
    ) {
      const { lead: created } = await createLead(actor, input);
      createdLeadIds.push(created.id);
      return updateLeadStatus(actor, created.id, { expectedStatus: 'NEW', newStatus: 'QUALIFIED' });
    }

    /** Inserts a standalone Client row directly (never through `convertLead`
     * itself), so a test can set up a pre-existing Client to link against —
     * tracked for cleanup. Normalizes email/phone with the real,
     * dynamically-imported `normalizeEmail`/`normalizePhone`, never a
     * hand-rolled equivalent, so duplicate/link matching behaves exactly as
     * it would for a Client created any other way. */
    async function createSeedClient(input: {
      fullName: string;
      email?: string;
      phone?: string;
    }): Promise<{ id: string; fullName: string }> {
      const id = randomUUID();
      await prisma!.client.create({
        data: {
          id,
          fullName: input.fullName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          normalizedEmail: input.email ? normalizeEmail(input.email) : null,
          normalizedPhone: input.phone ? normalizePhone(input.phone) : null,
        },
      });
      createdClientIds.push(id);
      return { id, fullName: input.fullName };
    }

    /** Reads the keys of a persisted JSON AuditLog state column as a sorted
     * array, for exact-shape assertions — parameter typed `unknown` (not
     * `Prisma.JsonValue`) purely so the cast inside is always safe without a
     * double-cast. */
    function auditStateKeys(value: unknown): string[] {
      return Object.keys(value as Record<string, unknown>).sort();
    }

    it('ADMIN_MANAGER creates a new Client from a QUALIFIED Lead with no active assignment, converting the Lead and recording history/audit exactly once', async () => {
      const email = `convert-admin-new-${randomUUID()}@example.com`;
      const phone = '0917 555 1111';
      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Conversion Admin Lead',
        source: 'Walk-in',
        email,
        phone,
      });
      expect(qualified.status).toBe('QUALIFIED');

      const result = await convertLead(adminActor, qualified.id, { expectedStatus: 'QUALIFIED' });
      createdClientIds.push(result.client.id);

      expect(result.clientCreated).toBe(true);
      expect(result.lead.status).toBe('CONVERTED_TO_CLIENT');
      expect(result.lead.clientId).toBe(result.client.id);
      // Mutation-style, assignment-free LeadRecord (D-024 §9) — never
      // LeadRecordWithAssignment.
      expect(result.lead).not.toHaveProperty('assignment');

      // Exactly one Client row, with the exact D-024 §4 field mapping.
      const clientRow = await prisma!.client.findUnique({ where: { id: result.client.id } });
      expect(clientRow).toMatchObject({
        fullName: 'Conversion Admin Lead',
        email,
        phone,
        normalizedEmail: normalizeEmail(email),
        normalizedPhone: normalizePhone(phone),
        notes: null,
        address: null,
        nationality: null,
        dateOfBirth: null,
        emergencyContact: null,
      });
      expect(await prisma!.client.count({ where: { id: result.client.id } })).toBe(1);

      const leadRow = await prisma!.lead.findUnique({ where: { id: qualified.id } });
      expect(leadRow?.status).toBe('CONVERTED_TO_CLIENT');
      expect(leadRow?.clientId).toBe(result.client.id);

      // LeadStatusHistory: NEW -> QUALIFIED -> CONVERTED_TO_CLIENT, earlier
      // history preserved, conversion recorded exactly once.
      const history = await prisma!.leadStatusHistory.findMany({
        where: { leadId: qualified.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((row) => row.newStatus)).toEqual([
        'NEW',
        'QUALIFIED',
        'CONVERTED_TO_CLIENT',
      ]);
      const conversionHistoryRow = history[history.length - 1];
      expect(conversionHistoryRow?.previousStatus).toBe('QUALIFIED');
      expect(conversionHistoryRow?.changedByUserId).toBe(adminActor.id);

      // Exact sanitized LEAD_CONVERTED_TO_CLIENT audit (D-024 §8).
      const conversionAudits = await prisma!.auditLog.findMany({
        where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
      });
      expect(conversionAudits).toHaveLength(1);
      expect(conversionAudits[0]?.afterState).toEqual({
        status: 'CONVERTED_TO_CLIENT',
        clientId: result.client.id,
        clientCreated: true,
      });
      expect(conversionAudits[0]?.actorId).toBe(adminActor.id);

      // Exact sanitized CLIENT_CREATED audit — no PII.
      const clientCreatedAudits = await prisma!.auditLog.findMany({
        where: { entityType: 'Client', entityId: result.client.id, action: 'CLIENT_CREATED' },
      });
      expect(clientCreatedAudits).toHaveLength(1);
      expect(clientCreatedAudits[0]?.afterState).toEqual({
        sourceLeadId: qualified.id,
        hasEmail: true,
        hasPhone: true,
      });

      // No assignment side effect: the Lead had none, so the new Client
      // inherits none either (D-024 §5).
      const assignments = await prisma!.staffAssignment.findMany({
        where: { clientId: result.client.id },
      });
      expect(assignments).toHaveLength(0);
    });

    it("ADMIN_MANAGER converting a Lead with an active TRAVEL_CONSULTANT assignment inherits that assignment onto the newly created Client, and never mutates the Lead's own assignment", async () => {
      const email = `convert-inherit-${randomUUID()}@example.com`;
      const qualified = await createQualifiedLead(tcActor, {
        fullName: 'TC Assigned Conversion Lead',
        source: 'Phone inquiry',
        email,
      });

      const result = await convertLead(adminActor, qualified.id, { expectedStatus: 'QUALIFIED' });
      createdClientIds.push(result.client.id);
      expect(result.clientCreated).toBe(true);

      const clientAssignment = await prisma!.staffAssignment.findFirst({
        where: { clientId: result.client.id, endedAt: null },
      });
      expect(clientAssignment?.assignedStaffId).toBe(tcActor.id);
      expect(clientAssignment?.assignedByUserId).toBe(adminActor.id);

      const clientAssignmentAudit = await prisma!.auditLog.findFirst({
        where: {
          entityType: 'Client',
          entityId: result.client.id,
          action: 'CLIENT_ASSIGNMENT_CREATED',
        },
      });
      expect(clientAssignmentAudit).not.toBeNull();

      // The Lead's own (now-historical) assignment is never ended or
      // mutated by conversion (D-024 §6's "do not end or mutate the Lead
      // assignment").
      const leadAssignment = await prisma!.staffAssignment.findFirst({
        where: { leadId: qualified.id },
      });
      expect(leadAssignment?.assignedStaffId).toBe(tcActor.id);
      expect(leadAssignment?.endedAt).toBeNull();
    });

    it("links to an existing Client on a contact match instead of creating a new one, and never touches that Client's own assignment", async () => {
      const sharedEmail = `convert-link-${randomUUID()}@example.com`;

      const seedClient = await createSeedClient({
        fullName: 'Existing Client',
        email: sharedEmail,
      });
      const seedAssignmentId = randomUUID();
      await prisma!.staffAssignment.create({
        data: {
          id: seedAssignmentId,
          assignedStaffId: otherTcActor.id,
          assignedByUserId: adminActor.id,
          clientId: seedClient.id,
        },
      });

      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Link Candidate Lead',
        source: 'Walk-in',
        email: sharedEmail,
      });

      const result = await convertLead(adminActor, qualified.id, {
        expectedStatus: 'QUALIFIED',
        clientId: seedClient.id,
      });

      expect(result.clientCreated).toBe(false);
      expect(result.client).toEqual({ id: seedClient.id, fullName: 'Existing Client' });
      expect(result.lead.status).toBe('CONVERTED_TO_CLIENT');
      expect(result.lead.clientId).toBe(seedClient.id);

      // Exactly the one seeded Client row sharing this contact — linking
      // never creates another.
      expect(
        await prisma!.client.count({ where: { normalizedEmail: normalizeEmail(sharedEmail) } }),
      ).toBe(1);

      const history = await prisma!.leadStatusHistory.findMany({
        where: { leadId: qualified.id, newStatus: 'CONVERTED_TO_CLIENT' },
      });
      expect(history).toHaveLength(1);

      const conversionAudits = await prisma!.auditLog.findMany({
        where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
      });
      expect(conversionAudits).toHaveLength(1);
      expect(conversionAudits[0]?.afterState).toEqual({
        status: 'CONVERTED_TO_CLIENT',
        clientId: seedClient.id,
        clientCreated: false,
      });

      // No CLIENT_CREATED audit for a link (D-024 §8: written only on the
      // create-new path).
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Client', entityId: seedClient.id, action: 'CLIENT_CREATED' },
        }),
      ).toBe(0);

      // The pre-existing Client assignment is untouched — still active,
      // still otherTcActor, and no second assignment was created.
      const clientAssignment = await prisma!.staffAssignment.findUnique({
        where: { id: seedAssignmentId },
      });
      expect(clientAssignment?.endedAt).toBeNull();
      expect(clientAssignment?.assignedStaffId).toBe(otherTcActor.id);
      expect(await prisma!.staffAssignment.count({ where: { clientId: seedClient.id } })).toBe(1);
    });

    it('allows an assigned TRAVEL_CONSULTANT to convert their own QUALIFIED Lead', async () => {
      const qualified = await createQualifiedLead(tcActor, {
        fullName: 'TC Self Conversion Lead',
        source: 'Referral',
        email: `convert-tc-self-${randomUUID()}@example.com`,
      });

      const result = await convertLead(tcActor, qualified.id, { expectedStatus: 'QUALIFIED' });
      createdClientIds.push(result.client.id);

      expect(result.clientCreated).toBe(true);
      expect(result.lead.status).toBe('CONVERTED_TO_CLIENT');

      const assignment = await prisma!.staffAssignment.findFirst({
        where: { clientId: result.client.id, endedAt: null },
      });
      expect(assignment?.assignedStaffId).toBe(tcActor.id);
      expect(assignment?.assignedByUserId).toBe(tcActor.id);
    });

    // Both the pre-transaction `canAccessLead` check and the in-transaction
    // `findActiveAssignmentForLead` recheck (D-024 §2/§6) express the
    // identical policy against the same live StaffAssignment state; in any
    // deterministic (non-racing) scenario like this one, both necessarily
    // agree, so this proves the real, unmocked end-to-end rejection without
    // needing to isolate exactly which of the two checks fired. Genuine
    // divergence between them only arises under true concurrent
    // modification mid-transaction — the "concurrent conversion" case below
    // covers that race using the service's own retry contract, never a raw
    // sleep.
    it('rejects an unassigned TRAVEL_CONSULTANT with LEAD_FORBIDDEN and leaves Lead/history/audit state unchanged', async () => {
      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Unassigned TC Target Lead',
        source: 'Walk-in',
        email: `convert-unassigned-${randomUUID()}@example.com`,
      });

      await expect(
        convertLead(tcActor, qualified.id, { expectedStatus: 'QUALIFIED' }),
      ).rejects.toMatchObject({ code: 'LEAD_FORBIDDEN' });

      const leadRow = await prisma!.lead.findUnique({ where: { id: qualified.id } });
      expect(leadRow?.status).toBe('QUALIFIED');
      expect(leadRow?.clientId).toBeNull();

      expect(await prisma!.leadStatusHistory.count({ where: { leadId: qualified.id } })).toBe(2);
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
      ).toBe(0);
    });

    // D-032 §5 (F-Lead): `convertLead` calls the global `canAccessLead`
    // check before its transaction ever opens, and `canAccessLead`'s own
    // mechanism for a TRAVEL_CONSULTANT actor (an active-StaffAssignment
    // lookup) returns an identical denial whether the target Lead is
    // genuinely nonexistent or merely exists-but-unassigned — there is no
    // distinct mocked branch that could prove this specific distinction
    // (the mocked `canAccessLead`-denial test above already proves
    // convertLead's own service-layer mapping from that denial to
    // LEAD_FORBIDDEN). Only a real database, where the two underlying facts
    // genuinely differ, can prove it — hence this test lives here, not in
    // service.test.ts.
    it('rejects a TRAVEL_CONSULTANT converting a genuinely nonexistent Lead id with the identical LEAD_FORBIDDEN result the inaccessible-Lead case above already proves, writing nothing', async () => {
      const nonexistentLeadId = randomUUID();

      await expect(
        convertLead(tcActor, nonexistentLeadId, { expectedStatus: 'QUALIFIED' }),
      ).rejects.toMatchObject({ code: 'LEAD_FORBIDDEN' });

      expect(await prisma!.lead.findUnique({ where: { id: nonexistentLeadId } })).toBeNull();
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: nonexistentLeadId },
        }),
      ).toBe(0);
    });

    it('rejects an ADMIN_MANAGER supplying a genuinely nonexistent clientId with CLIENT_LINK_NOT_AVAILABLE, producing no conversion-related write', async () => {
      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Nonexistent Client Target Lead',
        source: 'Walk-in',
        email: `convert-nonexistent-client-${randomUUID()}@example.com`,
      });
      const nonexistentClientId = randomUUID();

      // Captured immediately before the rejected attempt, not hardcoded —
      // this Lead's actual history count at this point is an implementation
      // detail of createQualifiedLead (currently 2: creation + QUALIFIED
      // transition), not a fact this test should assume or restate.
      const historyCountBefore = await prisma!.leadStatusHistory.count({
        where: { leadId: qualified.id },
      });

      await expect(
        convertLead(adminActor, qualified.id, {
          expectedStatus: 'QUALIFIED',
          clientId: nonexistentClientId,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });

      const leadRow = await prisma!.lead.findUnique({ where: { id: qualified.id } });
      expect(leadRow?.status).toBe('QUALIFIED');
      expect(leadRow?.clientId).toBeNull();
      expect(await prisma!.leadStatusHistory.count({ where: { leadId: qualified.id } })).toBe(
        historyCountBefore,
      );
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
      ).toBe(0);

      // No CLIENT_CREATED audit row attributes a newly created Client back
      // to this specific Lead — checked by content, not by a Client id we
      // don't have (none was ever created).
      const clientCreatedAudits = await prisma!.auditLog.findMany({
        where: { entityType: 'Client', action: 'CLIENT_CREATED' },
      });
      expect(
        clientCreatedAudits.some(
          (row) =>
            row.afterState !== null &&
            typeof row.afterState === 'object' &&
            (row.afterState as { sourceLeadId?: string }).sourceLeadId === qualified.id,
        ),
      ).toBe(false);
    });

    it('rejects a TRAVEL_CONSULTANT link-existing request with CLIENT_LINK_NOT_AVAILABLE when they lack the required active Client assignment, leaving state unchanged', async () => {
      const sharedEmail = `convert-tc-link-denied-${randomUUID()}@example.com`;
      const seedClient = await createSeedClient({
        fullName: 'Unassigned-To-TC Client',
        email: sharedEmail,
      });
      await prisma!.staffAssignment.create({
        data: {
          id: randomUUID(),
          assignedStaffId: otherTcActor.id,
          assignedByUserId: adminActor.id,
          clientId: seedClient.id,
        },
      });

      const qualified = await createQualifiedLead(tcActor, {
        fullName: 'TC Link Denied Lead',
        source: 'Walk-in',
        email: sharedEmail,
      });

      await expect(
        convertLead(tcActor, qualified.id, {
          expectedStatus: 'QUALIFIED',
          clientId: seedClient.id,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });

      const leadRow = await prisma!.lead.findUnique({ where: { id: qualified.id } });
      expect(leadRow?.status).toBe('QUALIFIED');
      expect(leadRow?.clientId).toBeNull();

      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
      ).toBe(0);

      const clientAssignments = await prisma!.staffAssignment.findMany({
        where: { clientId: seedClient.id },
      });
      expect(clientAssignments).toHaveLength(1);
      expect(clientAssignments[0]?.assignedStaffId).toBe(otherTcActor.id);
    });

    it('rejects a non-QUALIFIED Lead with LEAD_CONFLICT and leaves state unchanged', async () => {
      const { lead: created } = await createLead(adminActor, {
        fullName: 'Never Qualified Lead',
        source: 'Walk-in',
        email: `convert-never-qualified-${randomUUID()}@example.com`,
      });
      createdLeadIds.push(created.id);
      expect(created.status).toBe('NEW');

      await expect(
        convertLead(adminActor, created.id, { expectedStatus: 'QUALIFIED' }),
      ).rejects.toMatchObject({ code: 'LEAD_CONFLICT' });

      const leadRow = await prisma!.lead.findUnique({ where: { id: created.id } });
      expect(leadRow?.status).toBe('NEW');
      expect(leadRow?.clientId).toBeNull();
      expect(await prisma!.leadStatusHistory.count({ where: { leadId: created.id } })).toBe(1);
    });

    it('rejects create-new with CLIENT_MATCH_REQUIRES_LINK when a matching Client exists, and creates no new Client', async () => {
      const sharedEmail = `convert-match-required-${randomUUID()}@example.com`;
      await createSeedClient({ fullName: 'Pre-existing Match', email: sharedEmail });

      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Matching Lead',
        source: 'Walk-in',
        email: sharedEmail,
      });

      await expect(
        convertLead(adminActor, qualified.id, { expectedStatus: 'QUALIFIED' }),
      ).rejects.toMatchObject({ code: 'CLIENT_MATCH_REQUIRES_LINK' });

      const leadRow = await prisma!.lead.findUnique({ where: { id: qualified.id } });
      expect(leadRow?.status).toBe('QUALIFIED');
      expect(leadRow?.clientId).toBeNull();
      expect(
        await prisma!.client.count({ where: { normalizedEmail: normalizeEmail(sharedEmail) } }),
      ).toBe(1);
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
      ).toBe(0);
    });

    it('rejects an unrelated supplied clientId with CLIENT_LINK_NOT_AVAILABLE and leaves state unchanged', async () => {
      const unrelatedClient = await createSeedClient({
        fullName: 'Unrelated Client',
        email: `convert-unrelated-${randomUUID()}@example.com`,
      });

      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Unrelated Target Lead',
        source: 'Walk-in',
        email: `convert-unrelated-target-${randomUUID()}@example.com`,
      });

      await expect(
        convertLead(adminActor, qualified.id, {
          expectedStatus: 'QUALIFIED',
          clientId: unrelatedClient.id,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });

      const leadRow = await prisma!.lead.findUnique({ where: { id: qualified.id } });
      expect(leadRow?.status).toBe('QUALIFIED');
      expect(leadRow?.clientId).toBeNull();
    });

    it('replays a completed create-new conversion (omitted and matching clientId) with no new writes', async () => {
      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Replay Create-New Lead',
        source: 'Walk-in',
        email: `convert-replay-new-${randomUUID()}@example.com`,
      });

      const first = await convertLead(adminActor, qualified.id, { expectedStatus: 'QUALIFIED' });
      createdClientIds.push(first.client.id);

      const before = {
        history: await prisma!.leadStatusHistory.count({ where: { leadId: qualified.id } }),
        audits: await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
        clients: await prisma!.client.count({ where: { id: first.client.id } }),
        assignments: await prisma!.staffAssignment.count({ where: { clientId: first.client.id } }),
      };

      const replayOmitted = await convertLead(adminActor, qualified.id, {
        expectedStatus: 'QUALIFIED',
      });
      expect(replayOmitted.clientCreated).toBe(true);
      expect(replayOmitted.client).toEqual(first.client);

      const replaySameClientId = await convertLead(adminActor, qualified.id, {
        expectedStatus: 'QUALIFIED',
        clientId: first.client.id,
      });
      expect(replaySameClientId.clientCreated).toBe(true);
      expect(replaySameClientId.client).toEqual(first.client);

      expect(await prisma!.leadStatusHistory.count({ where: { leadId: qualified.id } })).toBe(
        before.history,
      );
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
      ).toBe(before.audits);
      expect(await prisma!.client.count({ where: { id: first.client.id } })).toBe(before.clients);
      expect(await prisma!.staffAssignment.count({ where: { clientId: first.client.id } })).toBe(
        before.assignments,
      );
    });

    it('replays a completed link-existing conversion (omitted and matching clientId), returning clientCreated: false with no new writes', async () => {
      const sharedEmail = `convert-replay-link-${randomUUID()}@example.com`;
      const seedClient = await createSeedClient({
        fullName: 'Replay Link Client',
        email: sharedEmail,
      });

      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Replay Link Lead',
        source: 'Walk-in',
        email: sharedEmail,
      });

      const first = await convertLead(adminActor, qualified.id, {
        expectedStatus: 'QUALIFIED',
        clientId: seedClient.id,
      });
      expect(first.clientCreated).toBe(false);

      const before = {
        history: await prisma!.leadStatusHistory.count({ where: { leadId: qualified.id } }),
        audits: await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
      };

      const replayOmitted = await convertLead(adminActor, qualified.id, {
        expectedStatus: 'QUALIFIED',
      });
      expect(replayOmitted.clientCreated).toBe(false);
      expect(replayOmitted.client).toEqual({ id: seedClient.id, fullName: 'Replay Link Client' });

      const replaySameClientId = await convertLead(adminActor, qualified.id, {
        expectedStatus: 'QUALIFIED',
        clientId: seedClient.id,
      });
      expect(replaySameClientId.clientCreated).toBe(false);

      expect(await prisma!.leadStatusHistory.count({ where: { leadId: qualified.id } })).toBe(
        before.history,
      );
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
      ).toBe(before.audits);
    });

    it('rejects a TRAVEL_CONSULTANT replay with CLIENT_LINK_NOT_AVAILABLE once their Client assignment has ended, writing nothing new', async () => {
      const email = `convert-replay-reauth-${randomUUID()}@example.com`;

      // tcActor converts (create-new) their own Lead, inheriting the new
      // Client's assignment (D-024 §5) — a real active Client assignment
      // for tcActor, established without any raw fixture insert.
      const qualifiedSource = await createQualifiedLead(tcActor, {
        fullName: 'Replay Reauth Source Lead',
        source: 'Walk-in',
        email,
      });
      const created = await convertLead(tcActor, qualifiedSource.id, {
        expectedStatus: 'QUALIFIED',
      });
      createdClientIds.push(created.client.id);
      expect(created.clientCreated).toBe(true);

      // A second Lead sharing the same contact channel, linked to that same
      // Client by tcActor while their inherited assignment is still active.
      const qualifiedLink = await createQualifiedLead(tcActor, {
        fullName: 'Replay Reauth Link Lead',
        source: 'Walk-in',
        email,
      });
      const linked = await convertLead(tcActor, qualifiedLink.id, {
        expectedStatus: 'QUALIFIED',
        clientId: created.client.id,
      });
      expect(linked.clientCreated).toBe(false);

      // Simulate the Client being reassigned away from tcActor in between —
      // a separate, later ADMIN_MANAGER action through
      // PUT /api/clients/[id]/assignment. Deterministic, no timing
      // assumption: the assignment is fully ended *before* the replay call
      // is ever made, so both the pre-transaction canAccessClient check and
      // the transaction-local recheck observe the identical, already-ended
      // state — proving the reauthorization is not skipped for a replay.
      await prisma!.staffAssignment.updateMany({
        where: { clientId: created.client.id, assignedStaffId: tcActor.id, endedAt: null },
        data: { endedAt: new Date() },
      });

      const auditsBefore = await prisma!.auditLog.count({
        where: {
          entityType: 'Lead',
          entityId: qualifiedLink.id,
          action: 'LEAD_CONVERTED_TO_CLIENT',
        },
      });

      await expect(
        convertLead(tcActor, qualifiedLink.id, {
          expectedStatus: 'QUALIFIED',
          clientId: created.client.id,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });

      expect(
        await prisma!.auditLog.count({
          where: {
            entityType: 'Lead',
            entityId: qualifiedLink.id,
            action: 'LEAD_CONVERTED_TO_CLIENT',
          },
        }),
      ).toBe(auditsBefore);

      // The original, already-completed link is itself left exactly as it was.
      const leadRow = await prisma!.lead.findUnique({ where: { id: qualifiedLink.id } });
      expect(leadRow?.clientId).toBe(created.client.id);
      expect(leadRow?.status).toBe('CONVERTED_TO_CLIENT');
    });

    // Deterministic by construction, not by timing: `runSerializableWithRetry`
    // (SERIALIZABLE isolation + its own retry-with-backoff) and D-024 §7's
    // idempotent-replay contract together guarantee that of two concurrent,
    // identical-intent conversion requests against the same Lead, the
    // loser observes the winner's committed result as a replay rather than
    // erroring — this test asserts that guarantee directly, with no sleep
    // and no fixed ordering assumption between the two calls.
    it('resolves two concurrent create-new conversion attempts on the same Lead to exactly one effective conversion', async () => {
      const qualified = await createQualifiedLead(adminActor, {
        fullName: 'Concurrent Conversion Lead',
        source: 'Walk-in',
        email: `convert-concurrent-${randomUUID()}@example.com`,
      });

      const [first, second] = await Promise.all([
        convertLead(adminActor, qualified.id, { expectedStatus: 'QUALIFIED' }),
        convertLead(adminActor, qualified.id, { expectedStatus: 'QUALIFIED' }),
      ]);
      createdClientIds.push(first.client.id);

      expect(first.client.id).toBe(second.client.id);
      expect(first.clientCreated).toBe(true);
      expect(second.clientCreated).toBe(true);

      expect(await prisma!.client.count({ where: { id: first.client.id } })).toBe(1);
      expect(
        await prisma!.leadStatusHistory.count({
          where: { leadId: qualified.id, newStatus: 'CONVERTED_TO_CLIENT' },
        }),
      ).toBe(1);
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Lead', entityId: qualified.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
        }),
      ).toBe(1);
      expect(
        await prisma!.auditLog.count({
          where: { entityType: 'Client', entityId: first.client.id, action: 'CLIENT_CREATED' },
        }),
      ).toBe(1);
      // No partial/duplicate assignment side effect (this Lead had none).
      expect(await prisma!.staffAssignment.count({ where: { clientId: first.client.id } })).toBe(0);
    });

    it('writes the exact sanitized D-024 audit shape, preserves prior Lead history, and never leaks contact PII into the conversion audit', async () => {
      const email = `convert-audit-integrity-${randomUUID()}@example.com`;
      const phone = '0917 222 3333';
      const { lead: created } = await createLead(adminActor, {
        fullName: 'Audit Integrity Lead',
        source: 'Walk-in',
        email,
        phone,
        notes: 'Sensitive internal note',
      });
      createdLeadIds.push(created.id);

      // Richer prior history before qualifying, to prove conversion appends
      // rather than replaces (NEW -> UNDER_REVIEW -> QUALIFIED — neither
      // edge requires a reason, transitions.ts).
      await updateLeadStatus(adminActor, created.id, {
        expectedStatus: 'NEW',
        newStatus: 'UNDER_REVIEW',
      });
      const qualified = await updateLeadStatus(adminActor, created.id, {
        expectedStatus: 'UNDER_REVIEW',
        newStatus: 'QUALIFIED',
      });

      const result = await convertLead(adminActor, qualified.id, { expectedStatus: 'QUALIFIED' });
      createdClientIds.push(result.client.id);

      const history = await prisma!.leadStatusHistory.findMany({
        where: { leadId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((row) => row.newStatus)).toEqual([
        'NEW',
        'UNDER_REVIEW',
        'QUALIFIED',
        'CONVERTED_TO_CLIENT',
      ]);

      const conversionAudit = await prisma!.auditLog.findFirst({
        where: { entityType: 'Lead', entityId: created.id, action: 'LEAD_CONVERTED_TO_CLIENT' },
      });
      expect(conversionAudit).not.toBeNull();
      expect(auditStateKeys(conversionAudit!.afterState)).toEqual(
        ['clientCreated', 'clientId', 'status'].sort(),
      );
      expect(conversionAudit!.afterState).toEqual({
        status: 'CONVERTED_TO_CLIENT',
        clientId: result.client.id,
        clientCreated: true,
      });
      expect(conversionAudit!.beforeState).toBeNull();

      const clientCreatedAudit = await prisma!.auditLog.findFirst({
        where: { entityType: 'Client', entityId: result.client.id, action: 'CLIENT_CREATED' },
      });
      expect(clientCreatedAudit).not.toBeNull();
      expect(auditStateKeys(clientCreatedAudit!.afterState)).toEqual(
        ['hasEmail', 'hasPhone', 'sourceLeadId'].sort(),
      );

      // No PII — raw email, name, note, or unrelated assignment data — in
      // either sanitized audit record.
      const serializedAudits = JSON.stringify([conversionAudit, clientCreatedAudit]);
      expect(serializedAudits).not.toContain(email);
      expect(serializedAudits).not.toContain(normalizePhone(phone));
      expect(serializedAudits).not.toContain('Audit Integrity Lead');
      expect(serializedAudits).not.toContain('Sensitive internal note');
    });

    // Stage F review correction 4: real-PostgreSQL coverage for
    // `getConversionOptions` (D-024 §10) — reuses this describe block's own
    // `createQualifiedLead`/`createSeedClient` helpers and the outer
    // suite's ID-tracked cleanup/database-safety scaffold unchanged.
    describe('getConversionOptions (D-024 §10 conversion-options read)', () => {
      it('returns no matches for ADMIN_MANAGER when no Client matches the QUALIFIED Lead', async () => {
        const qualified = await createQualifiedLead(adminActor, {
          fullName: 'Options No Match Lead',
          source: 'Walk-in',
          email: `options-no-match-${randomUUID()}@example.com`,
        });

        const result = await getConversionOptions(adminActor, qualified.id);

        expect(result).toEqual({ accessibleMatches: [], restrictedMatchDetected: false });
      });

      it('returns the exact accessible candidate (id/fullName/matchedOn only) for ADMIN_MANAGER when a Client matches', async () => {
        const sharedEmail = `options-match-${randomUUID()}@example.com`;
        const seedClient = await createSeedClient({
          fullName: 'Options Match Client',
          email: sharedEmail,
        });

        const qualified = await createQualifiedLead(adminActor, {
          fullName: 'Options Match Lead',
          source: 'Walk-in',
          email: sharedEmail,
        });

        const result = await getConversionOptions(adminActor, qualified.id);

        expect(result).toEqual({
          accessibleMatches: [
            { id: seedClient.id, fullName: 'Options Match Client', matchedOn: ['EMAIL'] },
          ],
          restrictedMatchDetected: false,
        });
      });

      it('collapses a matching Client assigned to another TRAVEL_CONSULTANT into restrictedMatchDetected, with no candidate metadata', async () => {
        const sharedEmail = `options-restricted-${randomUUID()}@example.com`;
        const seedClient = await createSeedClient({
          fullName: 'Options Restricted Client',
          email: sharedEmail,
        });
        await prisma!.staffAssignment.create({
          data: {
            id: randomUUID(),
            assignedStaffId: otherTcActor.id,
            assignedByUserId: adminActor.id,
            clientId: seedClient.id,
          },
        });

        const qualified = await createQualifiedLead(tcActor, {
          fullName: 'Options Restricted Lead',
          source: 'Walk-in',
          email: sharedEmail,
        });

        const result = await getConversionOptions(tcActor, qualified.id);

        expect(result.accessibleMatches).toEqual([]);
        expect(result.restrictedMatchDetected).toBe(true);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(seedClient.id);
        expect(serialized).not.toContain('Options Restricted Client');
      });

      it('throws CONVERSION_NOT_ELIGIBLE for a non-QUALIFIED Lead, performing no writes', async () => {
        const { lead: created } = await createLead(adminActor, {
          fullName: 'Options Not Eligible Lead',
          source: 'Walk-in',
          email: `options-not-eligible-${randomUUID()}@example.com`,
        });
        createdLeadIds.push(created.id);
        expect(created.status).toBe('NEW');

        await expect(getConversionOptions(adminActor, created.id)).rejects.toMatchObject({
          code: 'CONVERSION_NOT_ELIGIBLE',
        });

        const leadRow = await prisma!.lead.findUnique({ where: { id: created.id } });
        expect(leadRow?.status).toBe('NEW');
        expect(leadRow?.clientId).toBeNull();
        expect(await prisma!.leadStatusHistory.count({ where: { leadId: created.id } })).toBe(1);
        expect(
          await prisma!.auditLog.count({
            where: {
              entityType: 'Lead',
              entityId: created.id,
              action: 'LEAD_CONVERTED_TO_CLIENT',
            },
          }),
        ).toBe(0);
      });
    });
  });

  describe('D-031 F-01: real-PostgreSQL transaction-local recheck race', () => {
    type PrismaTransactionMethod = NonNullable<typeof prisma>['$transaction'];

    /**
     * A narrow, test-only interception of the real `prisma.$transaction`
     * method — never a mock of any query result or authorization outcome —
     * mirroring features/proposals/service.integration.test.ts's own
     * established `prisma.$transaction`-wrapping technique, applied at one
     * additional level of precision this specific race requires. On the
     * transaction's first attempt only (a later retry attempt, e.g. after a
     * genuine PostgreSQL serialization conflict, passes straight through
     * unintercepted), it wraps the fresh transaction-scoped client's own
     * `staffAssignment.findFirst` — the exact Prisma call
     * `findActiveAssignmentForLead` (features/assignments/repository.ts)
     * makes — so that once that one real query has genuinely resolved
     * against the database (the transaction-local recheck has actually
     * succeeded), execution pauses, mid-transaction, before the caller's own
     * business write, until `release()` is called. Every other real query
     * the real callback performs — including the eventual write — proceeds
     * completely unmodified once released.
     */
    function createRecheckPauseGate(db: NonNullable<typeof prisma>) {
      let intercepted = false;
      let signalRecheckDone!: () => void;
      const recheckDone = new Promise<void>((resolve) => {
        signalRecheckDone = resolve;
      });
      let releaseGate!: () => void;
      const gateReleased = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      function wrap(original: PrismaTransactionMethod): PrismaTransactionMethod {
        return (async (...args: Parameters<PrismaTransactionMethod>) => {
          if (intercepted) {
            return Reflect.apply(original as (...callArgs: unknown[]) => unknown, db, args);
          }
          intercepted = true;
          const [fn, options] = args as unknown as [
            (tx: unknown) => Promise<unknown>,
            Record<string, unknown> | undefined,
          ];
          const wrappedFn = async (tx: unknown) => {
            const staffAssignmentModel = (
              tx as {
                staffAssignment: { findFirst: (...findArgs: unknown[]) => Promise<unknown> };
              }
            ).staffAssignment;
            const originalFindFirst = staffAssignmentModel.findFirst.bind(staffAssignmentModel);
            staffAssignmentModel.findFirst = async (...findArgs: unknown[]) => {
              const result = await originalFindFirst(...findArgs);
              signalRecheckDone();
              await gateReleased;
              return result;
            };
            return fn(tx);
          };
          return Reflect.apply(original as (...callArgs: unknown[]) => unknown, db, [
            wrappedFn,
            options,
          ]);
        }) as PrismaTransactionMethod;
      }

      return { wrap, recheckDone, release: () => releaseGate() };
    }

    it("proves PostgreSQL detects a genuine serialization conflict when an ADMIN_MANAGER reassignment commits between updateLead's transaction-local recheck and its business write, resolving to a fresh retry whose own recheck observes the lost assignment and returns the controlled LEAD_FORBIDDEN result — never a silent success, never a raw database error", async () => {
      const { lead: created } = await createLead(tcActor, {
        fullName: 'Race Lead (updateLead)',
        source: 'Contact page',
        email: `race-updatelead-${randomUUID()}@example.com`,
      });
      createdLeadIds.push(created.id);

      const db = prisma!;
      const originalTransaction = db.$transaction;
      const gate = createRecheckPauseGate(db);
      db.$transaction = gate.wrap(originalTransaction) as typeof db.$transaction;

      try {
        const updatePromise = updateLead(tcActor, created.id, {
          notes: 'Should never persist',
        });

        await gate.recheckDone;

        // Real, concurrent ADMIN_MANAGER reassignment — commits fully
        // before the paused mutation resumes.
        await setLeadAssignment(
          adminActor,
          created.id,
          otherTcActor.id,
          'D-031 real-concurrency test reassignment',
        );

        gate.release();

        await expect(updatePromise).rejects.toMatchObject({ code: 'LEAD_FORBIDDEN' });
      } finally {
        db.$transaction = originalTransaction;
      }

      const row = await prisma!.lead.findUnique({ where: { id: created.id } });
      expect(row?.notes).toBeNull();

      const rejectedAuditCount = await prisma!.auditLog.count({
        where: { entityType: 'Lead', entityId: created.id, action: 'LEAD_UPDATED' },
      });
      expect(rejectedAuditCount).toBe(0);

      // The Admin's own, separate, legitimate reassignment correctly
      // audits — expected, and never to be confused with an audit row for
      // the rejected business mutation above.
      const reassignmentAuditCount = await prisma!.auditLog.count({
        where: { entityType: 'Lead', entityId: created.id, action: 'LEAD_ASSIGNMENT_REPLACED' },
      });
      expect(reassignmentAuditCount).toBe(1);
    }, 20000);

    it('proves the identical real-PostgreSQL race for updateLeadStatus, resolving to a fresh retry whose own recheck observes the lost assignment and returns the controlled LEAD_FORBIDDEN result', async () => {
      const { lead: created } = await createLead(tcActor, {
        fullName: 'Race Lead (updateLeadStatus)',
        source: 'Contact page',
        email: `race-updatestatus-${randomUUID()}@example.com`,
      });
      createdLeadIds.push(created.id);

      const db = prisma!;
      const originalTransaction = db.$transaction;
      const gate = createRecheckPauseGate(db);
      db.$transaction = gate.wrap(originalTransaction) as typeof db.$transaction;

      try {
        const updatePromise = updateLeadStatus(tcActor, created.id, {
          expectedStatus: 'NEW',
          newStatus: 'QUALIFIED',
        });

        await gate.recheckDone;

        await setLeadAssignment(
          adminActor,
          created.id,
          otherTcActor.id,
          'D-031 real-concurrency test reassignment',
        );

        gate.release();

        await expect(updatePromise).rejects.toMatchObject({ code: 'LEAD_FORBIDDEN' });
      } finally {
        db.$transaction = originalTransaction;
      }

      const row = await prisma!.lead.findUnique({ where: { id: created.id } });
      expect(row?.status).toBe('NEW');

      const rejectedAuditCount = await prisma!.auditLog.count({
        where: { entityType: 'Lead', entityId: created.id, action: 'LEAD_STATUS_CHANGED' },
      });
      expect(rejectedAuditCount).toBe(0);

      const reassignmentAuditCount = await prisma!.auditLog.count({
        where: { entityType: 'Lead', entityId: created.id, action: 'LEAD_ASSIGNMENT_REPLACED' },
      });
      expect(reassignmentAuditCount).toBe(1);
    }, 20000);
  });
});
