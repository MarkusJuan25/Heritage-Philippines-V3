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
  let LeadError: (typeof import('./errors'))['LeadError'];

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
    ({ createLead, getLeadById, listLeads, updateLead, updateLeadStatus } =
      await import('./service'));
    ({ LeadError } = await import('./errors'));

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

    const retrieved = await getLeadById(adminActor, created.id);
    expect(retrieved.id).toBe(created.id);

    const { items } = await listLeads(adminActor, { page: 1, pageSize: 100 });
    expect(items.some((item) => item.id === created.id)).toBe(true);

    const { lead: edited } = await updateLead(adminActor, created.id, {
      notes: 'Called back once',
    });
    expect(edited.notes).toBe('Called back once');

    const transitioned = await updateLeadStatus(adminActor, created.id, {
      expectedStatus: 'NEW',
      newStatus: 'QUALIFIED',
    });
    expect(transitioned.status).toBe('QUALIFIED');

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
  });

  it('atomically self-assigns a TRAVEL_CONSULTANT-created Lead, visible to its creator and ADMIN_MANAGER but not a different TC', async () => {
    const phone = '0917 111 2222';
    const { lead: created } = await createLead(tcActor, {
      fullName: 'TC Created Lead',
      source: 'Phone inquiry',
      phone,
    });
    createdLeadIds.push(created.id);

    const assignment = await prisma!.staffAssignment.findFirst({
      where: { leadId: created.id, endedAt: null },
    });
    expect(assignment?.assignedStaffId).toBe(tcActor.id);
    expect(assignment?.assignedByUserId).toBe(tcActor.id);

    const assignmentAudit = await prisma!.auditLog.findFirst({
      where: { entityType: 'Lead', entityId: created.id, action: 'LEAD_ASSIGNMENT_CREATED' },
    });
    expect(assignmentAudit).not.toBeNull();

    await expect(getLeadById(tcActor, created.id)).resolves.toMatchObject({ id: created.id });
    await expect(getLeadById(adminActor, created.id)).resolves.toMatchObject({ id: created.id });
    await expect(getLeadById(otherTcActor, created.id)).rejects.toThrow(LeadError);

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
});
