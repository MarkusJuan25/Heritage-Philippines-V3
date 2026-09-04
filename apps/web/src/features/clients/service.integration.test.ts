import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/lib/auth/guards';

// Database-backed integration test satisfying D-025 §11's real-PostgreSQL
// integration requirement for Client Management: "Admin-versus-Travel-
// Consultant visibility, the combined stored/submitted email-or-phone
// retention invariant verified against real persisted Client rows,
// transaction-local assignment loss, concurrent stale writes, duplicate-
// metadata restriction, PII-free AuditLog rows..., originating-Lead
// traceability, and continued compatibility with D-024's conversion
// behavior." Every mocked test elsewhere in this feature (schemas.test.ts,
// repository.test.ts, service.test.ts, http.test.ts, the two
// apps/web/src/app/api/clients/**/route.test.ts files) intentionally mocks
// Prisma and/or features/assignments — none of them can prove the real
// transactional/assignment/duplicate-detection/audit behavior against an
// actual PostgreSQL database with real foreign-key/CHECK/partial-unique-
// index constraints. This file proves it for real, against a dedicated,
// disposable PostgreSQL database — never the shared local `heritage_v3_dev`
// database — using this feature's own real, unmodified `service.ts` exports
// and, for D-024 compatibility, `features/leads/service.ts`'s own real,
// unmodified exports.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/leads/service.integration.test.ts and
// features/staff/service.integration.test.ts — see either file's own doc
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
 * raw connection string into a thrown message — a deliberate, self-contained
 * copy of features/leads/service.integration.test.ts's own
 * `validateTestDatabaseUrl`, not a shared import, matching that file's own
 * precedent of not sharing this safety guard across feature integration
 * suites.
 */
function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the clients integration suite.',
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

// Captured before any mutation, mirroring both existing integration suites'
// identical discipline, so `afterAll` can restore the process environment
// exactly as it found it — this file runs inside a shared Vitest worker
// process, and `process.env` mutations are not automatically isolated per
// test file.
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
// D-034 Stage 5d (D-037 Section 11): getServerEnv()'s shared schema now
// also requires ACTIVATION_RATE_LIMIT_HMAC_SECRET, for the same reason
// BETTER_AUTH_SECRET/URL are required here above.
const originalRateLimitSecret = process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;

describe.skipIf(!hasTestDatabaseUrl)('clients service integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let listClients: (typeof import('./service'))['listClients'];
  let getClientById: (typeof import('./service'))['getClientById'];
  let updateClient: (typeof import('./service'))['updateClient'];
  let ClientError: (typeof import('./errors'))['ClientError'];
  let normalizeEmail: (typeof import('@/lib/contact-normalization'))['normalizeEmail'];
  let normalizePhone: (typeof import('@/lib/contact-normalization'))['normalizePhone'];
  let createLead: (typeof import('@/features/leads/service'))['createLead'];
  let updateLeadStatus: (typeof import('@/features/leads/service'))['updateLeadStatus'];
  let convertLead: (typeof import('@/features/leads/service'))['convertLead'];
  // D-031 F-01: the real, unmodified assignments service, used only to
  // perform a genuine concurrent ADMIN_MANAGER reassignment — never mocked,
  // never a modification of features/assignments/service.integration.test.ts.
  let setClientAssignment: (typeof import('@/features/assignments/service'))['setClientAssignment'];

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;
  let otherTcActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;
  const actorUserIds: string[] = [];
  const createdLeadIds: string[] = [];
  const createdClientIds: string[] = [];

  beforeAll(async () => {
    // 1. Safety guard — must run before any env mutation, import, or
    // connection.
    validateTestDatabaseUrl(rawTestDatabaseUrl!);

    // 2. Establish the environment the real modules will read at import
    // time (identical rationale to both existing integration suites).
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
    ({ listClients, getClientById, updateClient } = await import('./service'));
    ({ ClientError } = await import('./errors'));
    ({ normalizeEmail, normalizePhone } = await import('@/lib/contact-normalization'));
    ({ createLead, updateLeadStatus, convertLead } = await import('@/features/leads/service'));
    ({ setClientAssignment } = await import('@/features/assignments/service'));

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
      const email = `clients-integration-${role.toLowerCase()}-${randomUUID()}@example.test`;
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
          // schema.prisma — LeadStatusHistory and StaffAssignment rows
          // referencing a tracked Lead/Client/actor must go first, then
          // AuditLog rows referencing a tracked actor, then tracked Leads
          // (Lead.clientId -> Client is onDelete: Restrict, so a Lead must
          // be deleted before the Client it references), then tracked
          // Clients, then tracked Users.
          if (createdLeadIds.length > 0) {
            await prisma.leadStatusHistory.deleteMany({
              where: { leadId: { in: createdLeadIds } },
            });
            await prisma.staffAssignment.deleteMany({
              where: { leadId: { in: createdLeadIds } },
            });
          }
          if (createdClientIds.length > 0) {
            await prisma.staffAssignment.deleteMany({
              where: { clientId: { in: createdClientIds } },
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

  // --- Shared fixture helpers (used across multiple scenarios below) ---

  type ClientFixtureInput = {
    fullName: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    nationality?: string | null;
    dateOfBirth?: Date | null;
    emergencyContact?: string | null;
    notes?: string | null;
  };

  /**
   * Inserts a standalone Client row directly — never through the Client
   * service itself, which (per D-025 §1) authorizes no Client-creation
   * path at all — so a test can set up a persisted Client to read, edit, or
   * match against. Tracked for cleanup. Normalizes email/phone with the
   * real, dynamically-imported `normalizeEmail`/`normalizePhone`, never a
   * hand-rolled equivalent, so duplicate-matching behaves exactly as it
   * would for a Client created any other way (mirrors
   * features/leads/service.integration.test.ts's own `createSeedClient`
   * precedent). This is purely test-fixture construction — it does not
   * become, and must never be read as, a new application-level Client
   * creation path.
   */
  async function createClientFixture(input: ClientFixtureInput) {
    const id = randomUUID();
    const email = input.email ?? null;
    const phone = input.phone ?? null;
    const row = await prisma!.client.create({
      data: {
        id,
        fullName: input.fullName,
        email,
        phone,
        normalizedEmail: email ? normalizeEmail(email) : null,
        normalizedPhone: phone ? normalizePhone(phone) : null,
        address: input.address ?? null,
        nationality: input.nationality ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        emergencyContact: input.emergencyContact ?? null,
        notes: input.notes ?? null,
      },
    });
    createdClientIds.push(id);
    return row;
  }

  /** Creates a real, active StaffAssignment linking a Client to a staff member. */
  async function createActiveClientAssignment(
    clientId: string,
    assignedStaffId: string,
    assignedByUserId: string,
  ) {
    return prisma!.staffAssignment.create({
      data: { id: randomUUID(), assignedStaffId, assignedByUserId, clientId },
    });
  }

  /**
   * Creates a Lead as `actor` and transitions it NEW -> QUALIFIED (neither
   * edge requires a reason — features/leads's transitions.ts), tracking the
   * Lead id for cleanup. Mirrors
   * features/leads/service.integration.test.ts's own identically-named
   * helper exactly.
   */
  async function createQualifiedLead(
    actor: AuthenticatedUser,
    input: { fullName: string; source: string; email?: string; phone?: string },
  ) {
    const { lead: created } = await createLead(actor, input);
    createdLeadIds.push(created.id);
    return updateLeadStatus(actor, created.id, { expectedStatus: 'NEW', newStatus: 'QUALIFIED' });
  }

  /**
   * Generates a fresh, realistic Philippine mobile phone string
   * ("09XX XXX XXXX") for every Client.phone duplicate-detection fixture in
   * this suite, so no two calls — even across this suite and an
   * independently authored one (e.g. features/leads's own integration
   * suite) running concurrently in separate Vitest workers against the
   * same live `heritage_v3_test` database — ever collide on the same
   * `normalizedPhone` value by coincidence, the way a fixed literal
   * previously did. Every digit after the fixed `09` prefix is drawn from
   * two fresh `randomUUID()` calls' hex digits (filtered to 0-9 only, then
   * defensively padded — a UUID pair supplies far more entropy than the 9
   * digits actually used), giving each call negligible collision
   * probability across parallel workers. Deterministic in format, and
   * requires no sleep, timestamp, global environment state, or database
   * lookup.
   */
  function generateUniqueClientPhone(): string {
    const digits = `${randomUUID()}${randomUUID()}`.replace(/\D/g, '').padEnd(9, '0');
    return `09${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 9)}`;
  }

  const EXPECTED_DETAIL_KEYS = [
    'id',
    'fullName',
    'email',
    'phone',
    'address',
    'nationality',
    'dateOfBirth',
    'emergencyContact',
    'notes',
    'createdAt',
    'updatedAt',
    'assignment',
    'originatingLeads',
  ].sort();

  describe('ADMIN_MANAGER visibility and persisted editing', () => {
    it('lists Clients regardless of assignment and reads an unassigned Client with the exact D-025 detail shape', async () => {
      const unassignedClient = await createClientFixture({
        fullName: 'Unassigned Client',
        email: `unassigned-${randomUUID()}@example.com`,
      });
      const assignedClient = await createClientFixture({
        fullName: 'Assigned Client (admin view)',
        email: `assigned-admin-view-${randomUUID()}@example.com`,
      });
      await createActiveClientAssignment(assignedClient.id, tcActor.id, adminActor.id);

      const { items } = await listClients(adminActor, { page: 1, pageSize: 100 });
      expect(items.some((item) => item.id === unassignedClient.id)).toBe(true);
      expect(items.some((item) => item.id === assignedClient.id)).toBe(true);

      const detail = await getClientById(adminActor, unassignedClient.id);
      expect(Object.keys(detail).sort()).toEqual(EXPECTED_DETAIL_KEYS);
      expect(detail.assignment).toBeNull();
      expect(detail.originatingLeads).toEqual([]);
      expect(detail).not.toHaveProperty('normalizedEmail');
      expect(detail).not.toHaveProperty('normalizedPhone');
    });

    it('returns dateOfBirth as a bare YYYY-MM-DD string, never a timestamp, with nullable fields always present', async () => {
      const client = await createClientFixture({
        fullName: 'DOB Client',
        email: `dob-${randomUUID()}@example.com`,
        dateOfBirth: new Date('1990-05-17T00:00:00.000Z'),
      });

      const detail = await getClientById(adminActor, client.id);
      expect(detail.dateOfBirth).toBe('1990-05-17');
      expect(detail.dateOfBirth).not.toMatch(/T|Z|:/);
      expect(detail.address).toBeNull();
      expect(detail.nationality).toBeNull();
      expect(detail.emergencyContact).toBeNull();
      expect(detail.notes).toBeNull();
    });

    it('persists a valid update to ordinary and normalized contact fields, returning a fresh updatedAt baseline, and never returns normalizedEmail/normalizedPhone', async () => {
      const client = await createClientFixture({
        fullName: 'Persist Client',
        email: `persist-old-${randomUUID()}@example.com`,
      });

      // Establishes a deterministic concurrency baseline by backdating this
      // Client's `updatedAt` 60 seconds into the past via a parameterized
      // raw SQL UPDATE (bypassing Prisma's own @updatedAt auto-management
      // entirely — the same technique the concurrency test below uses), so
      // the post-update `updatedAt` returned by the service is guaranteed
      // strictly newer than this known baseline regardless of how fast the
      // write actually executes. No sleep is used.
      const baseline = new Date(Date.now() - 60_000);
      await prisma!
        .$executeRaw`UPDATE "client" SET "updatedAt" = ${baseline} WHERE "id" = ${client.id}`;

      const newEmail = `persist-new-${randomUUID()}@example.com`;
      const newPhone = generateUniqueClientPhone();

      const result = await updateClient(adminActor, client.id, {
        fullName: 'Persist Client Updated',
        email: newEmail,
        phone: newPhone,
        expectedUpdatedAt: baseline.toISOString(),
      });

      expect(result.client.fullName).toBe('Persist Client Updated');
      expect(result.client.email).toBe(newEmail);
      expect(result.client.phone).toBe(newPhone);
      expect(result.client.updatedAt.getTime()).toBeGreaterThan(baseline.getTime());
      expect(result.client).not.toHaveProperty('normalizedEmail');
      expect(result.client).not.toHaveProperty('normalizedPhone');

      const row = await prisma!.client.findUnique({ where: { id: client.id } });
      expect(row?.email).toBe(newEmail);
      expect(row?.phone).toBe(newPhone);
      expect(row?.normalizedEmail).toBe(normalizeEmail(newEmail));
      expect(row?.normalizedPhone).toBe(normalizePhone(newPhone));
    });
  });

  describe('TRAVEL_CONSULTANT visibility and authorization', () => {
    it('lists only Clients with a current active assignment to that TC, with no hidden count leakage', async () => {
      const ownClient = await createClientFixture({
        fullName: 'TC Own Client (list test)',
        email: `tc-own-list-${randomUUID()}@example.com`,
      });
      await createActiveClientAssignment(ownClient.id, tcActor.id, adminActor.id);

      const otherClient = await createClientFixture({
        fullName: 'Other TC Client (list test)',
        email: `other-tc-list-${randomUUID()}@example.com`,
      });
      await createActiveClientAssignment(otherClient.id, otherTcActor.id, adminActor.id);

      const unassignedClient = await createClientFixture({
        fullName: 'Unassigned Client (list test)',
        email: `unassigned-list-${randomUUID()}@example.com`,
      });

      const { items, total } = await listClients(tcActor, { page: 1, pageSize: 100 });
      expect(items.some((item) => item.id === ownClient.id)).toBe(true);
      expect(items.some((item) => item.id === otherClient.id)).toBe(false);
      expect(items.some((item) => item.id === unassignedClient.id)).toBe(false);
      // No hidden count leakage: `total` (computed with the identical
      // scoped `where`) must never exceed what the page itself returned,
      // proving it isn't secretly counting Clients outside this actor's
      // visibility.
      expect(total).toBe(items.length);
    });

    it('allows read and edit of an assigned Client, and rejects an inaccessible or nonexistent Client with the identical CLIENT_FORBIDDEN result', async () => {
      const ownClient = await createClientFixture({
        fullName: 'TC Own Client (access test)',
        email: `tc-own-access-${randomUUID()}@example.com`,
      });
      await createActiveClientAssignment(ownClient.id, tcActor.id, adminActor.id);

      const otherClient = await createClientFixture({
        fullName: 'Other TC Client (access test)',
        email: `other-tc-access-${randomUUID()}@example.com`,
      });
      await createActiveClientAssignment(otherClient.id, otherTcActor.id, adminActor.id);

      const detail = await getClientById(tcActor, ownClient.id);
      expect(detail.id).toBe(ownClient.id);

      const patched = await updateClient(tcActor, ownClient.id, {
        notes: 'Edited by assigned TC',
        expectedUpdatedAt: detail.updatedAt.toISOString(),
      });
      expect(patched.client.notes).toBe('Edited by assigned TC');

      await expect(getClientById(tcActor, otherClient.id)).rejects.toBeInstanceOf(ClientError);
      await expect(getClientById(tcActor, otherClient.id)).rejects.toMatchObject({
        code: 'CLIENT_FORBIDDEN',
        message: 'You do not have access to this client.',
      });
      await expect(getClientById(tcActor, randomUUID())).rejects.toMatchObject({
        code: 'CLIENT_FORBIDDEN',
        message: 'You do not have access to this client.',
      });
    });

    it('keeps ADMIN_MANAGER CLIENT_NOT_FOUND distinct for a genuinely missing Client', async () => {
      await expect(getClientById(adminActor, randomUUID())).rejects.toMatchObject({
        code: 'CLIENT_NOT_FOUND',
        message: 'Client not found.',
      });
    });

    it("removes list/detail/edit access once the TC's active assignment ends", async () => {
      const client = await createClientFixture({
        fullName: 'Ending Assignment Client',
        email: `ending-assignment-${randomUUID()}@example.com`,
      });
      await createActiveClientAssignment(client.id, tcActor.id, adminActor.id);

      const detailBeforeEnd = await getClientById(tcActor, client.id);
      expect(detailBeforeEnd.id).toBe(client.id);

      await prisma!.staffAssignment.updateMany({
        where: { clientId: client.id, assignedStaffId: tcActor.id, endedAt: null },
        data: { endedAt: new Date() },
      });

      const { items } = await listClients(tcActor, { page: 1, pageSize: 100 });
      expect(items.some((item) => item.id === client.id)).toBe(false);

      await expect(getClientById(tcActor, client.id)).rejects.toMatchObject({
        code: 'CLIENT_FORBIDDEN',
      });
      await expect(
        updateClient(tcActor, client.id, {
          notes: 'Should not apply',
          expectedUpdatedAt: detailBeforeEnd.updatedAt.toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
    });
  });

  describe('Combined persisted email/phone invariant', () => {
    it('clears email while phone remains present, then rejects clearing the sole remaining channel, leaving the row/audit unchanged on rejection', async () => {
      const phone = generateUniqueClientPhone();
      const client = await createClientFixture({
        fullName: 'Contact Invariant Client',
        email: `invariant-${randomUUID()}@example.com`,
        phone,
      });

      const afterEmailClear = await updateClient(adminActor, client.id, {
        email: null,
        expectedUpdatedAt: client.updatedAt.toISOString(),
      });
      expect(afterEmailClear.client.email).toBeNull();
      expect(afterEmailClear.client.phone).toBe(phone);

      const auditCountBefore = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });

      // The submitted patch here is `{ phone: null }` alone — it carries no
      // information about email at all. Only because the service combines
      // this submission with the Client's now-actually-stored `email: null`
      // (the real, persisted result of the previous PATCH above — never a
      // hand-set fixture value) can it correctly determine both channels
      // would end up empty. This is deliberately not tested from the
      // submitted partial object alone.
      await expect(
        updateClient(adminActor, client.id, {
          phone: null,
          expectedUpdatedAt: afterEmailClear.client.updatedAt.toISOString(),
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'A client must retain at least one of email or phone.',
      });

      const row = await prisma!.client.findUnique({ where: { id: client.id } });
      expect(row?.email).toBeNull();
      expect(row?.phone).toBe(phone);
      expect(row?.normalizedPhone).toBe(normalizePhone(phone));
      expect(row?.updatedAt.getTime()).toBe(afterEmailClear.client.updatedAt.getTime());

      const auditCountAfter = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  describe('No-op and optimistic concurrency', () => {
    it('performs no Client write and creates no CLIENT_UPDATED audit for a genuine fresh-token no-op', async () => {
      const client = await createClientFixture({
        fullName: 'No-op Client',
        email: `noop-${randomUUID()}@example.com`,
        phone: generateUniqueClientPhone(),
      });

      const auditCountBefore = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });

      const result = await updateClient(adminActor, client.id, {
        fullName: client.fullName,
        email: client.email!,
        expectedUpdatedAt: client.updatedAt.toISOString(),
      });

      expect(result.client.updatedAt.getTime()).toBe(client.updatedAt.getTime());

      const row = await prisma!.client.findUnique({ where: { id: client.id } });
      expect(row?.updatedAt.getTime()).toBe(client.updatedAt.getTime());

      const auditCountAfter = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it('returns CLIENT_CONFLICT for a stale-token no-op', async () => {
      const client = await createClientFixture({
        fullName: 'Stale No-op Client',
        email: `stale-noop-${randomUUID()}@example.com`,
      });
      const staleToken = new Date(client.updatedAt.getTime() - 1000).toISOString();

      await expect(
        updateClient(adminActor, client.id, {
          fullName: client.fullName,
          expectedUpdatedAt: staleToken,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_CONFLICT' });
    });

    it('resolves two concurrent changed PATCH attempts using the same expectedUpdatedAt to exactly one write, one conflict, and one audit', async () => {
      const client = await createClientFixture({
        fullName: 'Concurrent Client',
        email: `concurrent-${randomUUID()}@example.com`,
      });

      // Backdates the concurrency token deterministically into the past
      // (via a raw SQL UPDATE, bypassing Prisma's own @updatedAt
      // auto-management entirely) so it is guaranteed strictly older than
      // whatever "now" the eventual winning write commits as its fresh
      // `updatedAt` — removing any possibility of the token accidentally
      // colliding with the winner's new timestamp at millisecond
      // resolution, regardless of how fast the two concurrent transactions
      // actually execute.
      const backdated = new Date(Date.now() - 60_000);
      await prisma!
        .$executeRaw`UPDATE "client" SET "updatedAt" = ${backdated} WHERE "id" = ${client.id}`;
      const expectedUpdatedAt = backdated.toISOString();

      const results = await Promise.allSettled([
        updateClient(adminActor, client.id, { notes: 'Winner A', expectedUpdatedAt }),
        updateClient(adminActor, client.id, { notes: 'Winner B', expectedUpdatedAt }),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof updateClient>>> =>
          result.status === 'fulfilled',
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: 'CLIENT_CONFLICT' });

      const winnerNotes = fulfilled[0]!.value.client.notes;
      expect(['Winner A', 'Winner B']).toContain(winnerNotes);
      expect(fulfilled[0]!.value.client.updatedAt.getTime()).toBeGreaterThan(backdated.getTime());

      const row = await prisma!.client.findUnique({ where: { id: client.id } });
      expect(row?.notes).toBe(winnerNotes);

      const auditCount = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });
      expect(auditCount).toBe(1);
    });
  });

  describe('Transaction-local assignment-loss protection', () => {
    it("returns CLIENT_FORBIDDEN when the TC's assignment ends between the pre-transaction authorization check and the transaction-local recheck, with no partial write", async () => {
      const client = await createClientFixture({
        fullName: 'Assignment Loss Client',
        email: `assignment-loss-${randomUUID()}@example.com`,
      });
      await createActiveClientAssignment(client.id, tcActor.id, adminActor.id);

      const auditCountBefore = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });

      const db = prisma!;
      const originalTransaction = db.$transaction;
      let interceptionRan = false;

      db.$transaction = (async (...args: Parameters<typeof db.$transaction>) => {
        interceptionRan = true;
        // Ends the real, persisted Client assignment after updateClient's
        // pre-transaction `canAccessClient` check has already passed (that
        // check runs against the live `prisma` singleton before
        // `$transaction` is ever invoked), and immediately before the real
        // transaction callback begins — proving the transaction-local
        // recheck inside the mutation transaction (not merely the earlier
        // pre-transaction check) actually re-verifies the assignment
        // against current state. Delegates to, and never replaces, the
        // real transaction implementation.
        await db.staffAssignment.updateMany({
          where: { clientId: client.id, assignedStaffId: tcActor.id, endedAt: null },
          data: { endedAt: new Date() },
        });
        return originalTransaction.apply(db, args);
      }) as unknown as typeof db.$transaction;

      try {
        await expect(
          updateClient(tcActor, client.id, {
            fullName: 'Should Never Persist',
            expectedUpdatedAt: client.updatedAt.toISOString(),
          }),
        ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
      } finally {
        db.$transaction = originalTransaction;
      }

      expect(interceptionRan).toBe(true);

      const row = await prisma!.client.findUnique({ where: { id: client.id } });
      expect(row?.fullName).toBe('Assignment Loss Client');
      expect(row?.updatedAt.getTime()).toBe(client.updatedAt.getTime());

      const auditCountAfter = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });
  });

  describe('Duplicate metadata and access restriction', () => {
    it("excludes the Client's own originating Lead, restricts an inaccessible match, and surfaces only allow-listed metadata for an accessible match, while the edit itself still persists", async () => {
      const sharedEmail = `dup-shared-${randomUUID()}@example.com`;

      // The Client's own originating Lead — self-assigned to tcActor at
      // creation, then converted by tcActor into a brand-new Client that
      // inherits that same assignment (D-024 §5/§6's established
      // self-conversion-inherits-assignment behavior).
      const ownLead = await createQualifiedLead(tcActor, {
        fullName: 'Own Originating Lead (dup test)',
        source: 'Walk-in',
        email: sharedEmail,
      });
      const conversion = await convertLead(tcActor, ownLead.id, { expectedStatus: 'QUALIFIED' });
      createdClientIds.push(conversion.client.id);
      const clientBeingEdited = conversion.client;

      // An independently accessible unrelated Client sharing the same
      // contact, also assigned to tcActor.
      const accessibleClientMatch = await createClientFixture({
        fullName: 'Accessible Client Match',
        email: sharedEmail,
      });
      await createActiveClientAssignment(accessibleClientMatch.id, tcActor.id, adminActor.id);

      // An independently accessible unrelated Lead sharing the same contact
      // — self-assigned to tcActor at creation, never converted.
      const { lead: accessibleLeadMatch } = await createLead(tcActor, {
        fullName: 'Accessible Lead Match',
        source: 'Referral',
        email: sharedEmail,
      });
      createdLeadIds.push(accessibleLeadMatch.id);

      // An inaccessible Lead sharing the same contact — self-assigned only
      // to otherTcActor.
      const { lead: inaccessibleLeadMatch } = await createLead(otherTcActor, {
        fullName: 'Inaccessible Lead Match',
        source: 'Referral',
        email: sharedEmail,
      });
      createdLeadIds.push(inaccessibleLeadMatch.id);

      const detailBefore = await getClientById(tcActor, clientBeingEdited.id);

      const result = await updateClient(tcActor, clientBeingEdited.id, {
        fullName: 'Edited By TC',
        email: sharedEmail,
        expectedUpdatedAt: detailBefore.updatedAt.toISOString(),
      });

      expect(result.duplicateMatches).toBeDefined();
      expect(result.restrictedMatchDetected).toBe(true);
      const matches = result.duplicateMatches!;

      // The Client's own originating Lead is never surfaced as a match.
      expect(matches.some((match) => match.id === ownLead.id)).toBe(false);

      // The inaccessible Lead's identity never leaks anywhere in the result.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(inaccessibleLeadMatch.id);
      expect(serialized).not.toContain('Inaccessible Lead Match');

      const clientMatch = matches.find(
        (match) => match.type === 'CLIENT' && match.id === accessibleClientMatch.id,
      );
      expect(clientMatch).toBeDefined();
      expect(Object.keys(clientMatch!).sort()).toEqual(['fullName', 'id', 'matchedOn', 'type']);
      expect(clientMatch).toMatchObject({
        fullName: 'Accessible Client Match',
        matchedOn: ['EMAIL'],
      });

      const leadMatch = matches.find(
        (match) => match.type === 'LEAD' && match.id === accessibleLeadMatch.id,
      );
      expect(leadMatch).toBeDefined();
      expect(Object.keys(leadMatch!).sort()).toEqual([
        'fullName',
        'id',
        'matchedOn',
        'status',
        'type',
      ]);
      expect(leadMatch).toMatchObject({
        fullName: 'Accessible Lead Match',
        status: 'NEW',
        matchedOn: ['EMAIL'],
      });

      // Duplicate matches are advisory only — the edit itself still persists.
      const row = await prisma!.client.findUnique({ where: { id: clientBeingEdited.id } });
      expect(row?.fullName).toBe('Edited By TC');
    });
  });

  describe('Originating-Lead traceability and D-024 compatibility', () => {
    it('shows ADMIN_MANAGER every originating Lead and a TC only the independently accessible ones, without altering Lead/conversion state on a Client PATCH', async () => {
      const sharedEmail = `origin-shared-${randomUUID()}@example.com`;

      const lead1 = await createQualifiedLead(tcActor, {
        fullName: 'Origin Lead One',
        source: 'Walk-in',
        email: sharedEmail,
      });
      const conversion = await convertLead(tcActor, lead1.id, { expectedStatus: 'QUALIFIED' });
      createdClientIds.push(conversion.client.id);
      const clientId = conversion.client.id;

      const lead2 = await createQualifiedLead(tcActor, {
        fullName: 'Origin Lead Two',
        source: 'Walk-in',
        email: sharedEmail,
      });
      const linked2 = await convertLead(tcActor, lead2.id, {
        expectedStatus: 'QUALIFIED',
        clientId,
      });
      expect(linked2.clientCreated).toBe(false);

      const lead3 = await createQualifiedLead(otherTcActor, {
        fullName: 'Origin Lead Three (other TC)',
        source: 'Walk-in',
        email: sharedEmail,
      });
      const linked3 = await convertLead(adminActor, lead3.id, {
        expectedStatus: 'QUALIFIED',
        clientId,
      });
      expect(linked3.clientCreated).toBe(false);

      const adminDetail = await getClientById(adminActor, clientId);
      expect(adminDetail.originatingLeads.map((lead) => lead.id).sort()).toEqual(
        [lead1.id, lead2.id, lead3.id].sort(),
      );

      const tcDetail = await getClientById(tcActor, clientId);
      const tcLeadIds = tcDetail.originatingLeads.map((lead) => lead.id);
      expect(tcLeadIds.sort()).toEqual([lead1.id, lead2.id].sort());
      expect(tcLeadIds).not.toContain(lead3.id);
      expect(JSON.stringify(tcDetail)).not.toContain('Origin Lead Three');

      const trackedLeadIds = [lead1.id, lead2.id, lead3.id];

      /**
       * A complete, deterministically ordered snapshot of every Lead- and
       * conversion-adjacent row this Client PATCH must never touch — not
       * merely a count — so the before/after comparison below catches any
       * field-level drift (status, clientId, assignment identity/
       * timestamps/endedAt, audit before/afterState), not just a changed
       * row count.
       */
      async function snapshotLeadAndConversionState() {
        return {
          leads: await Promise.all(
            trackedLeadIds.map((id) => prisma!.lead.findUnique({ where: { id } })),
          ),
          statusHistory: await prisma!.leadStatusHistory.findMany({
            where: { leadId: { in: trackedLeadIds } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
          // Every StaffAssignment connected to any tracked Lead OR the
          // converted Client itself — covers lead1's and lead2's own
          // (untouched, tcActor-held) assignments, lead3's own (untouched,
          // otherTcActor-held) assignment, and the Client's own assignment
          // inherited from lead1's self-conversion.
          assignments: await prisma!.staffAssignment.findMany({
            where: { OR: [{ leadId: { in: trackedLeadIds } }, { clientId }] },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
          conversionAudits: await prisma!.auditLog.findMany({
            where: {
              entityType: 'Lead',
              entityId: { in: trackedLeadIds },
              action: 'LEAD_CONVERTED_TO_CLIENT',
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
        };
      }

      const before = await snapshotLeadAndConversionState();
      const clientCountForContactBefore = await prisma!.client.count({
        where: { normalizedEmail: normalizeEmail(sharedEmail) },
      });

      await updateClient(tcActor, clientId, {
        notes: 'TC edited notes (traceability test)',
        expectedUpdatedAt: tcDetail.updatedAt.toISOString(),
      });

      const after = await snapshotLeadAndConversionState();
      expect(after.leads).toEqual(before.leads);
      expect(after.statusHistory).toEqual(before.statusHistory);
      expect(after.assignments).toEqual(before.assignments);
      expect(after.conversionAudits).toEqual(before.conversionAudits);

      expect(await prisma!.client.count({ where: { id: clientId } })).toBe(1);
      expect(
        await prisma!.client.count({ where: { normalizedEmail: normalizeEmail(sharedEmail) } }),
      ).toBe(clientCountForContactBefore);
    });
  });

  describe('PII-free CLIENT_UPDATED audit integrity', () => {
    it('writes exactly one PII-free CLIENT_UPDATED audit row for a genuine update', async () => {
      const originalEmail = `audit-old-${randomUUID()}@example.com`;
      const originalPhone = generateUniqueClientPhone();
      const client = await createClientFixture({
        fullName: 'Audit Integrity Client',
        email: originalEmail,
        phone: originalPhone,
        address: '123 Sensitive Street',
        nationality: 'Filipino',
        dateOfBirth: new Date('1985-03-10T00:00:00.000Z'),
        emergencyContact: 'Jane Doe +63 917 000 0000',
        notes: 'Confidential internal note',
      });

      const newEmail = `audit-new-${randomUUID()}@example.com`;
      const newPhone = generateUniqueClientPhone();

      const result = await updateClient(adminActor, client.id, {
        fullName: 'Audit Integrity Client Updated',
        email: newEmail,
        phone: newPhone,
        address: '456 New Street',
        nationality: 'American',
        dateOfBirth: new Date('1986-04-11T00:00:00.000Z'),
        emergencyContact: 'John Doe +63 917 111 1111',
        notes: 'Updated confidential note',
        expectedUpdatedAt: client.updatedAt.toISOString(),
      });
      expect(result.client.fullName).toBe('Audit Integrity Client Updated');

      const audits = await prisma!.auditLog.findMany({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });
      expect(audits).toHaveLength(1);
      const audit = audits[0]!;
      expect(audit.entityType).toBe('Client');
      expect(audit.entityId).toBe(client.id);
      expect(audit.actorId).toBe(adminActor.id);
      expect(audit.beforeState).toBeNull();

      const afterState = audit.afterState as {
        changedFields: string[];
        hasEmail: boolean;
        hasPhone: boolean;
      };
      expect(Object.keys(afterState).sort()).toEqual(['changedFields', 'hasEmail', 'hasPhone']);
      expect(afterState.changedFields).toEqual([
        'fullName',
        'email',
        'phone',
        'address',
        'nationality',
        'dateOfBirth',
        'emergencyContact',
        'notes',
      ]);
      expect(afterState.hasEmail).toBe(true);
      expect(afterState.hasPhone).toBe(true);
      expect(afterState).not.toHaveProperty('expectedUpdatedAt');

      const serialized = JSON.stringify(audit);
      // Covers both the persisted-before and the submitted-after value of
      // every PII-bearing field — not the "after" values alone — so the
      // assertion actually proves neither state ever reaches AuditLog.
      const persistedAndSubmittedPiiValues = [
        'Audit Integrity Client', // persisted-before fullName
        'Audit Integrity Client Updated', // submitted-after fullName
        originalEmail,
        newEmail,
        originalPhone,
        newPhone,
        '123 Sensitive Street',
        '456 New Street',
        'Filipino',
        'American',
        '1985-03-10', // persisted-before dateOfBirth
        '1986-04-11', // submitted-after dateOfBirth
        'Jane Doe +63 917 000 0000', // persisted-before emergencyContact, in full
        'John Doe +63 917 111 1111', // submitted-after emergencyContact, in full
        'Confidential internal note',
        'Updated confidential note',
      ];
      for (const piiValue of persistedAndSubmittedPiiValues) {
        expect(serialized).not.toContain(piiValue);
      }
    });

    it('writes no audit for a failed/stale/forbidden update attempt, leaving no partial Client change', async () => {
      const client = await createClientFixture({
        fullName: 'No Audit On Failure Client',
        email: `no-audit-${randomUUID()}@example.com`,
      });

      const auditCountBefore = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });

      const staleToken = new Date(client.updatedAt.getTime() - 5000).toISOString();
      await expect(
        updateClient(adminActor, client.id, {
          fullName: 'Should Not Persist (stale)',
          expectedUpdatedAt: staleToken,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_CONFLICT' });

      // tcActor holds no assignment on this Client at all.
      await expect(
        updateClient(tcActor, client.id, {
          fullName: 'Should Not Persist (forbidden)',
          expectedUpdatedAt: client.updatedAt.toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });

      const row = await prisma!.client.findUnique({ where: { id: client.id } });
      expect(row?.fullName).toBe('No Audit On Failure Client');
      expect(row?.updatedAt.getTime()).toBe(client.updatedAt.getTime());

      const auditCountAfter = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
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
     * `findActiveAssignmentForClient` (features/assignments/repository.ts)
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

    it("proves PostgreSQL detects a genuine serialization conflict when an ADMIN_MANAGER reassignment commits between updateClient's transaction-local recheck and its business write, resolving to a fresh retry whose own recheck observes the lost assignment and returns the controlled CLIENT_FORBIDDEN result — never a silent success, never a raw database error", async () => {
      const client = await createClientFixture({
        fullName: 'Real Race Client',
        email: `real-race-${randomUUID()}@example.com`,
      });
      await createActiveClientAssignment(client.id, tcActor.id, adminActor.id);

      const db = prisma!;
      const originalTransaction = db.$transaction;
      const gate = createRecheckPauseGate(db);
      db.$transaction = gate.wrap(originalTransaction) as typeof db.$transaction;

      try {
        const updatePromise = updateClient(tcActor, client.id, {
          fullName: 'Should never persist',
          expectedUpdatedAt: client.updatedAt.toISOString(),
        });

        await gate.recheckDone;

        // Real, concurrent ADMIN_MANAGER reassignment — commits fully
        // before the paused mutation resumes.
        await setClientAssignment(
          adminActor,
          client.id,
          otherTcActor.id,
          'D-031 real-concurrency test reassignment',
        );

        gate.release();

        await expect(updatePromise).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
      } finally {
        db.$transaction = originalTransaction;
      }

      const row = await prisma!.client.findUnique({ where: { id: client.id } });
      expect(row?.fullName).toBe('Real Race Client');

      const rejectedAuditCount = await prisma!.auditLog.count({
        where: { entityType: 'Client', entityId: client.id, action: 'CLIENT_UPDATED' },
      });
      expect(rejectedAuditCount).toBe(0);

      // The Admin's own, separate, legitimate reassignment correctly
      // audits — expected, and never to be confused with an audit row for
      // the rejected business mutation above.
      const reassignmentAuditCount = await prisma!.auditLog.count({
        where: {
          entityType: 'Client',
          entityId: client.id,
          action: 'CLIENT_ASSIGNMENT_REPLACED',
        },
      });
      expect(reassignmentAuditCount).toBe(1);
    }, 20000);
  });

  // --- D-040 §9: one CLIENT-actor case for Contract A (getOwnClientForUser) ---
  describe('getOwnClientForUser (D-040 Contract A) — real database', () => {
    let getOwnClientForUser: (typeof import('./service'))['getOwnClientForUser'];
    const localUserIds: string[] = [];
    const localClientIds: string[] = [];
    const localProfileIds: string[] = [];
    let clientActor: AuthenticatedUser;
    let ownedClientId: string;
    let ownedFullName: string;
    let ownedEmail: string;
    let noProfileActor: AuthenticatedUser;

    beforeAll(async () => {
      ({ getOwnClientForUser } = await import('./service'));

      const userId = randomUUID();
      ownedClientId = randomUUID();
      const profileId = randomUUID();
      ownedFullName = `Owned Portal Client ${randomUUID()}`;
      ownedEmail = `clients-portal-${randomUUID()}@example.test`;
      await prisma!.user.create({
        data: {
          id: userId,
          name: ownedFullName,
          email: ownedEmail,
          role: 'CLIENT',
          isActive: true,
        },
      });
      localUserIds.push(userId);
      await prisma!.client.create({
        data: { id: ownedClientId, fullName: ownedFullName, email: ownedEmail, phone: null },
      });
      localClientIds.push(ownedClientId);
      await prisma!.clientProfile.create({
        data: { id: profileId, userId, clientId: ownedClientId },
      });
      localProfileIds.push(profileId);
      clientActor = { id: userId, email: ownedEmail, name: ownedFullName, role: 'CLIENT' };

      const noProfId = randomUUID();
      await prisma!.user.create({
        data: {
          id: noProfId,
          name: `No Profile Client ${noProfId}`,
          email: `clients-portal-noprofile-${randomUUID()}@example.test`,
          role: 'CLIENT',
          isActive: true,
        },
      });
      localUserIds.push(noProfId);
      noProfileActor = {
        id: noProfId,
        email: `noprofile-${noProfId}@example.test`,
        name: 'No Profile',
        role: 'CLIENT',
      };
    }, 20000);

    afterAll(async () => {
      if (!prisma) return;
      await prisma.clientProfile.deleteMany({ where: { id: { in: localProfileIds } } });
      await prisma.client.deleteMany({ where: { id: { in: localClientIds } } });
      await prisma.user.deleteMany({ where: { id: { in: localUserIds } } });
    }, 20000);

    it('resolves the owned Client from actor.id alone (identity-card fields only)', async () => {
      const result = await getOwnClientForUser(clientActor);
      expect(result).toEqual({
        clientId: ownedClientId,
        fullName: ownedFullName,
        email: ownedEmail,
        phone: null,
      });
    });

    it('returns null for a CLIENT user with no ClientProfile', async () => {
      expect(await getOwnClientForUser(noProfileActor)).toBeNull();
    });

    it('rejects a staff actor with ROLE_NOT_PERMITTED (the Contract A vs B-F role split)', async () => {
      await expect(getOwnClientForUser(adminActor)).rejects.toMatchObject({
        name: 'ClientError',
        code: 'ROLE_NOT_PERMITTED',
      });
    });
  });
});
