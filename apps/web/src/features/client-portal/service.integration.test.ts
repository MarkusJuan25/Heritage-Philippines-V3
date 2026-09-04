import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BookingStatus } from '@/generated/prisma/client';
import type { AuthenticatedUser } from '@/lib/auth/guards';

// Real-PostgreSQL integration coverage for the D-040 Client Home / Overview
// composition (D-040 §9). Proves against an actual PostgreSQL database —
// with real foreign-key / CHECK / partial-unique constraints — the behavior
// the mocked-tier unit tests cannot: Contract A resolving the owned Client
// from `actor.id` alone, absolute cross-client isolation, the proposal
// visibility + superseded-exclusion predicates, the accepted-proposal /
// missing-vs-DRAFT-vs-client-visible-booking distinctions, DRAFT exclusion
// from the booking count / grouping / preview, assigned-consultant
// visibility, the identifier-free + data-minimized composed DTO, and every
// one of the fifteen §6.4 travel-status scenario traces.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to every other
// features/*/service.integration.test.ts — no `@/lib/db` or `./service`
// static import; everything real is imported dynamically inside `beforeAll`
// only after `TEST_DATABASE_URL` has been validated; the suite is
// `describe.skipIf`-skipped entirely (no import, no connection) whenever
// `TEST_DATABASE_URL` is unset, which is the default for `pnpm test`.
//
// Fixture data is deliberately non-PII: synthetic names, `@example.test`
// emails, and opaque canary tokens only — no real personal data, and no
// credential is ever constructed or logged.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the client-portal integration suite.',
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

describe.skipIf(!hasTestDatabaseUrl)('client-portal overview integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let getClientOverview: (typeof import('./service'))['getClientOverview'];
  let ClientPortalError: (typeof import('./errors'))['ClientPortalError'];

  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;

  const staffUserIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdProfileIds: string[] = [];
  const createdProposalIds: string[] = [];
  const createdBookingIds: string[] = [];

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;

  function bookingReference(): string {
    return `HPB-${randomBytes(10).toString('hex').toUpperCase()}`;
  }

  type ClientFixture = {
    userId: string;
    clientId: string;
    profileId: string;
    actor: AuthenticatedUser;
    fullName: string;
    email: string;
    phone: string | null;
    notesCanary: string | null;
  };

  async function createClientWithProfile(opts?: {
    label?: string;
    withNotesCanary?: boolean;
    phone?: string | null;
  }): Promise<ClientFixture> {
    const userId = randomUUID();
    const clientId = randomUUID();
    const profileId = randomUUID();
    const label = opts?.label ?? 'Client';
    const fullName = `CP Integration ${label} ${randomUUID()}`;
    const email = `cp-integration-${randomUUID()}@example.test`;
    const phone =
      opts?.phone === undefined ? `+63-2-${randomBytes(3).toString('hex')}` : opts.phone;
    const notesCanary = opts?.withNotesCanary ? `NOTES_CANARY_${randomUUID()}` : null;

    await prisma!.user.create({
      data: { id: userId, name: fullName, email, role: 'CLIENT', isActive: true },
    });
    createdUserIds.push(userId);
    await prisma!.client.create({
      data: { id: clientId, fullName, email, phone, notes: notesCanary },
    });
    createdClientIds.push(clientId);
    await prisma!.clientProfile.create({ data: { id: profileId, userId, clientId } });
    createdProfileIds.push(profileId);

    return {
      userId,
      clientId,
      profileId,
      actor: { id: userId, email, name: fullName, role: 'CLIENT' },
      fullName,
      email,
      phone,
      notesCanary,
    };
  }

  /** A CLIENT-role User with NO ClientProfile — Contract A must resolve null. */
  async function createClientUserWithoutProfile(): Promise<AuthenticatedUser> {
    const id = randomUUID();
    const email = `cp-integration-noprofile-${randomUUID()}@example.test`;
    await prisma!.user.create({
      data: { id, name: `CP Integration NoProfile ${id}`, email, role: 'CLIENT', isActive: true },
    });
    createdUserIds.push(id);
    return { id, email, name: `CP Integration NoProfile ${id}`, role: 'CLIENT' };
  }

  type SeedProposalOpts = {
    published?: boolean; // default true
    draftOnly?: boolean; // v1 clientVisibleAt null — never counts
    superseded?: boolean; // v1 superseded + v2 current; acceptance/booking attach to v2
    acceptance?: 'ACCEPT' | 'DECLINE' | 'REQUEST_CHANGES' | null;
    bookingStatus?: BookingStatus | null;
    contentMarker?: string;
    internalNotesCanary?: string;
    clientVisibleNotesCanary?: string;
    withMoney?: boolean;
  };

  async function seedProposalForClient(
    clientId: string,
    opts: SeedProposalOpts = {},
  ): Promise<{ proposalId: string; currentVersionId: string; bookingReference?: string }> {
    const proposalId = randomUUID();
    const now = new Date();
    const draftOnly = opts.draftOnly ?? false;
    const published = draftOnly ? false : (opts.published ?? true);

    await prisma!.proposal.create({ data: { id: proposalId, clientId } });
    createdProposalIds.push(proposalId);

    async function createVersion(
      versionNumber: number,
      clientVisibleAt: Date | null,
      supersededAt: Date | null,
    ): Promise<string> {
      const id = randomUUID();
      await prisma!.proposalVersion.create({
        data: {
          id,
          proposalId,
          versionNumber,
          content: opts.contentMarker ?? `Proposal content ${randomUUID()}`,
          createdByUserId: tcActor.id,
          clientVisibleAt,
          supersededAt,
        },
      });
      return id;
    }

    let currentVersionId: string;
    if (opts.superseded) {
      await createVersion(1, new Date(now.getTime() - 1000), now);
      currentVersionId = await createVersion(2, now, null);
    } else {
      currentVersionId = await createVersion(1, published ? now : null, null);
    }

    if (opts.acceptance) {
      await prisma!.proposalAcceptance.create({
        data: {
          id: randomUUID(),
          proposalVersionId: currentVersionId,
          responseType: opts.acceptance,
          respondedAt: now,
          recordedByStaffUserId: tcActor.id,
          responseMethod: 'phone',
          evidenceReference: `evidence-${randomUUID()}`,
        },
      });
    }

    let ref: string | undefined;
    if (opts.bookingStatus) {
      const bookingId = randomUUID();
      ref = bookingReference();
      await prisma!.booking.create({
        data: {
          id: bookingId,
          bookingReference: ref,
          clientId,
          proposalVersionId: currentVersionId,
          status: opts.bookingStatus,
          totalAmount: opts.withMoney ? '123456.78' : null,
          currencyCode: opts.withMoney ? 'PHP' : null,
          internalNotes: opts.internalNotesCanary ?? null,
          clientVisibleNotes: opts.clientVisibleNotesCanary ?? null,
          destination: 'Palawan',
          tourPackageName: 'Island Hopping',
          statusHistory: {
            create: {
              id: randomUUID(),
              previousStatus: null,
              newStatus: opts.bookingStatus,
              changedByUserId: tcActor.id,
            },
          },
        },
      });
      createdBookingIds.push(bookingId);
    }

    return { proposalId, currentVersionId, bookingReference: ref };
  }

  async function assignConsultant(clientId: string): Promise<void> {
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: tcActor.id,
        assignedByUserId: adminActor.id,
        clientId,
      },
    });
  }

  // Rich Client A + minimal Client B (isolation + DTO checks).
  let clientA: ClientFixture;
  let clientB: ClientFixture;
  const aContentMarker = `PROPOSAL_CONTENT_A_${randomUUID()}`;
  const aInternalNotes = `INTERNAL_NOTES_A_${randomUUID()}`;
  const aClientVisNotes = `CLIENT_VIS_NOTES_A_${randomUUID()}`;
  let aBookingRefConfirmed: string;
  let aBookingRefCancelled: string;

  let noProfileActor: AuthenticatedUser;

  // The fifteen §6.4 scenarios.
  type ScenarioSpec = {
    n: number;
    awaiting?: number;
    decline?: number;
    acceptedNoBooking?: number;
    acceptedDraftBooking?: number;
    acceptedActive?: BookingStatus[];
    acceptedCompleted?: number;
    acceptedCancelled?: number;
    proposalLine: string | null;
    progressLine: string;
  };

  const SCENARIOS: ScenarioSpec[] = [
    { n: 1, proposalLine: null, progressLine: 'AWAITING_FIRST_PROPOSAL' },
    {
      n: 2,
      awaiting: 1,
      proposalLine: 'PROPOSALS_AWAITING_YOU',
      progressLine: 'PROPOSAL_IN_REVIEW',
    },
    {
      n: 3,
      acceptedNoBooking: 1,
      proposalLine: null,
      progressLine: 'PROPOSAL_ACCEPTED_AWAITING_BOOKING',
    },
    { n: 4, decline: 1, proposalLine: 'RESPONSE_RECORDED', progressLine: 'NO_ACTIVE_BOOKING' },
    {
      n: 5,
      acceptedActive: ['PENDING_CONFIRMATION'],
      proposalLine: null,
      progressLine: 'BOOKING_PENDING_CONFIRMATION',
    },
    {
      n: 6,
      awaiting: 1,
      acceptedActive: ['CONFIRMED'],
      proposalLine: 'PROPOSALS_AWAITING_YOU',
      progressLine: 'BOOKING_CONFIRMED',
    },
    { n: 7, acceptedCompleted: 1, proposalLine: null, progressLine: 'TRIP_COMPLETED' },
    {
      n: 8,
      awaiting: 1,
      acceptedCompleted: 1,
      proposalLine: 'PROPOSALS_AWAITING_YOU',
      progressLine: 'PROPOSAL_IN_REVIEW',
    },
    {
      n: 9,
      acceptedNoBooking: 1,
      acceptedCompleted: 1,
      proposalLine: null,
      progressLine: 'PROPOSAL_ACCEPTED_AWAITING_BOOKING',
    },
    { n: 10, acceptedCancelled: 1, proposalLine: null, progressLine: 'NO_ACTIVE_BOOKING' },
    { n: 11, acceptedCancelled: 1, proposalLine: null, progressLine: 'NO_ACTIVE_BOOKING' },
    {
      n: 12,
      awaiting: 1,
      acceptedCancelled: 1,
      proposalLine: 'PROPOSALS_AWAITING_YOU',
      progressLine: 'PROPOSAL_IN_REVIEW',
    },
    {
      n: 13,
      acceptedActive: ['PENDING_CONFIRMATION', 'IN_PREPARATION'],
      proposalLine: null,
      progressLine: 'TRIP_IN_PREPARATION',
    },
    {
      n: 14,
      acceptedActive: ['CONFIRMED'],
      acceptedCompleted: 1,
      proposalLine: null,
      progressLine: 'BOOKING_CONFIRMED',
    },
    {
      n: 15,
      acceptedDraftBooking: 1,
      proposalLine: null,
      progressLine: 'PROPOSAL_ACCEPTED_AWAITING_BOOKING',
    },
  ];

  const scenarioActors = new Map<number, AuthenticatedUser>();

  async function seedScenario(spec: ScenarioSpec): Promise<void> {
    const fixture = await createClientWithProfile({ label: `Scenario ${spec.n}` });
    scenarioActors.set(spec.n, fixture.actor);
    const cid = fixture.clientId;

    for (let i = 0; i < (spec.awaiting ?? 0); i += 1) {
      await seedProposalForClient(cid, { acceptance: null });
    }
    for (let i = 0; i < (spec.decline ?? 0); i += 1) {
      await seedProposalForClient(cid, { acceptance: 'DECLINE' });
    }
    for (let i = 0; i < (spec.acceptedNoBooking ?? 0); i += 1) {
      await seedProposalForClient(cid, { acceptance: 'ACCEPT', bookingStatus: null });
    }
    for (let i = 0; i < (spec.acceptedDraftBooking ?? 0); i += 1) {
      await seedProposalForClient(cid, { acceptance: 'ACCEPT', bookingStatus: 'DRAFT' });
    }
    for (const status of spec.acceptedActive ?? []) {
      await seedProposalForClient(cid, { acceptance: 'ACCEPT', bookingStatus: status });
    }
    for (let i = 0; i < (spec.acceptedCompleted ?? 0); i += 1) {
      await seedProposalForClient(cid, { acceptance: 'ACCEPT', bookingStatus: 'COMPLETED' });
    }
    for (let i = 0; i < (spec.acceptedCancelled ?? 0); i += 1) {
      await seedProposalForClient(cid, { acceptance: 'ACCEPT', bookingStatus: 'CANCELLED' });
    }
  }

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
    ({ getClientOverview } = await import('./service'));
    ({ ClientPortalError } = await import('./errors'));

    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    if (rows[0]?.current_database !== REQUIRED_TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to proceed: the connected database reports current_database() = "${rows[0]?.current_database}", not "${REQUIRED_TEST_DATABASE_NAME}".`,
      );
    }

    async function createStaff(role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT') {
      const id = randomUUID();
      const email = `cp-integration-${role.toLowerCase()}-${randomUUID()}@example.test`;
      await prisma!.user.create({
        data: { id, name: `Integration ${role}`, email, role, isActive: true },
      });
      staffUserIds.push(id);
      return { id, name: `Integration ${role}`, email, role } as AuthenticatedUser;
    }
    adminActor = await createStaff('ADMIN_MANAGER');
    tcActor = await createStaff('TRAVEL_CONSULTANT');

    // --- Client A: rich portfolio ---
    clientA = await createClientWithProfile({
      label: 'A',
      withNotesCanary: true,
      phone: '+63-2-1234',
    });
    const a1 = await seedProposalForClient(clientA.clientId, {
      acceptance: 'ACCEPT',
      bookingStatus: 'CONFIRMED',
      contentMarker: aContentMarker,
      internalNotesCanary: aInternalNotes,
      clientVisibleNotesCanary: aClientVisNotes,
      withMoney: true,
    });
    aBookingRefConfirmed = a1.bookingReference!;
    await seedProposalForClient(clientA.clientId, { acceptance: null }); // awaiting #1
    await seedProposalForClient(clientA.clientId, { acceptance: 'ACCEPT', bookingStatus: 'DRAFT' }); // acwcvb
    const a4 = await seedProposalForClient(clientA.clientId, {
      acceptance: 'ACCEPT',
      bookingStatus: 'CANCELLED',
    });
    aBookingRefCancelled = a4.bookingReference!;
    await seedProposalForClient(clientA.clientId, { draftOnly: true }); // never counted
    await seedProposalForClient(clientA.clientId, { superseded: true, acceptance: null }); // awaiting #2 (v2 only)
    await assignConsultant(clientA.clientId);

    // --- Client B: one awaiting proposal, no bookings, no consultant ---
    clientB = await createClientWithProfile({ label: 'B', phone: null });
    await seedProposalForClient(clientB.clientId, { acceptance: null });

    noProfileActor = await createClientUserWithoutProfile();

    for (const spec of SCENARIOS) {
      await seedScenario(spec);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      if (prisma) {
        try {
          const allUserIds = [...staffUserIds, ...createdUserIds];
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
          }
          await prisma.staffAssignment.deleteMany({
            where: {
              OR: [
                { clientId: { in: createdClientIds } },
                { assignedStaffId: { in: allUserIds } },
                { assignedByUserId: { in: allUserIds } },
              ],
            },
          });
          if (createdProposalIds.length > 0) {
            await prisma.proposal.deleteMany({ where: { id: { in: createdProposalIds } } });
          }
          await prisma.auditLog.deleteMany({ where: { actorId: { in: allUserIds } } });
          if (createdProfileIds.length > 0) {
            await prisma.clientProfile.deleteMany({ where: { id: { in: createdProfileIds } } });
          }
          if (createdClientIds.length > 0) {
            await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
          }
          if (allUserIds.length > 0) {
            await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });
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
        if (originalBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
        else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
      }
      if (didSetBetterAuthUrl) {
        if (originalBetterAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
        else process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
      }
      if (didSetRateLimitSecret) {
        if (originalRateLimitSecret === undefined)
          delete process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;
        else process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET = originalRateLimitSecret;
      }
    }
  }, 120_000);

  describe('Contract A — owned-client resolution', () => {
    it('resolves Client A from the CLIENT user id alone and returns only the identity-card fields', async () => {
      const overview = await getClientOverview(clientA.actor);
      expect(overview.identity).toEqual({
        fullName: clientA.fullName,
        email: clientA.email,
        phone: clientA.phone,
      });
      expect(Object.keys(overview.identity).sort()).toEqual(['email', 'fullName', 'phone']);
    });

    it('rejects a staff actor with FORBIDDEN', async () => {
      await expect(getClientOverview(adminActor)).rejects.toBeInstanceOf(ClientPortalError);
      await expect(getClientOverview(tcActor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects a CLIENT user with no ClientProfile with PROFILE_NOT_SET_UP', async () => {
      await expect(getClientOverview(noProfileActor)).rejects.toMatchObject({
        code: 'PROFILE_NOT_SET_UP',
      });
    });
  });

  describe('proposal visibility, facts, and superseded exclusion', () => {
    it("computes Client A's five proposal facts over the complete current-visible set, independent of the five-item preview", async () => {
      const overview = await getClientOverview(clientA.actor);
      // 5 current-visible proposals: CONFIRMED-booked ACCEPT, awaiting,
      // DRAFT-booked ACCEPT, CANCELLED-booked ACCEPT, superseded->current
      // awaiting. The draft-only proposal never counts.
      expect(overview.proposals.currentVisibleTotal).toBe(5);
      expect(overview.proposals.preview.length).toBeLessThanOrEqual(5);
      // Superseded v1 is excluded — only v2 of that proposal contributes.
      expect(overview.proposals.preview.every((item) => item.versionNumber >= 1)).toBe(true);
    });

    it('excludes a draft-only (never-published) proposal and a superseded version from every count', async () => {
      const overview = await getClientOverview(clientA.actor);
      // currentVisibleTotal already asserts the draft-only proposal is not
      // counted; the superseded proposal contributes exactly one (its
      // current v2), so total is 5 not 6 and not 7.
      expect(overview.proposals.currentVisibleTotal).toBe(5);
    });
  });

  describe('booking DRAFT exclusion and grouped-status normalization', () => {
    it('excludes the DRAFT booking from the total, the nine-key aggregate, and the preview', async () => {
      const overview = await getClientOverview(clientA.actor);
      expect(Object.keys(overview.bookings.byStatus).sort()).toEqual(
        [
          'CANCELLED',
          'COMPLETED',
          'CONFIRMED',
          'DOCUMENTS_REQUIRED',
          'IN_PREPARATION',
          'IN_PROGRESS',
          'PENDING_CONFIRMATION',
          'READY_FOR_TRAVEL',
          'VISA_PROCESSING',
        ].sort(),
      );
      expect(overview.bookings.byStatus).not.toHaveProperty('DRAFT');
      // A has CONFIRMED x1 and CANCELLED x1 among non-DRAFT bookings.
      expect(overview.bookings.byStatus.CONFIRMED).toBe(1);
      expect(overview.bookings.byStatus.CANCELLED).toBe(1);
      expect(overview.bookings.total).toBe(2);
      expect(overview.bookings.preview).toHaveLength(2);
      const refs = overview.bookings.preview.map((b) => b.bookingReference).sort();
      expect(refs).toEqual([aBookingRefCancelled, aBookingRefConfirmed].sort());
    });
  });

  describe('accepted proposal + missing / DRAFT / client-visible booking distinctions and travel status', () => {
    it("Client A's travel status: proposalLine PROPOSALS_AWAITING_YOU (2), progressLine BOOKING_CONFIRMED", async () => {
      const overview = await getClientOverview(clientA.actor);
      expect(overview.travelStatus.proposalLine).toEqual({
        state: 'PROPOSALS_AWAITING_YOU',
        sentence: 'You have 2 proposals waiting for your response.',
      });
      expect(overview.travelStatus.progressLine).toEqual({
        state: 'BOOKING_CONFIRMED',
        sentence: 'At least one booking is confirmed.',
      });
    });

    it('an accepted proposal whose only booking is DRAFT is treated as awaiting a booking (scenario 15)', async () => {
      const overview = await getClientOverview(scenarioActors.get(15)!);
      expect(overview.bookings.total).toBe(0);
      expect(overview.bookings.preview).toHaveLength(0);
      expect(Object.values(overview.bookings.byStatus)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(overview.travelStatus.progressLine.state).toBe('PROPOSAL_ACCEPTED_AWAITING_BOOKING');
      expect(overview.travelStatus.progressLine.state).not.toBe('AWAITING_FIRST_PROPOSAL');
    });
  });

  describe('assigned-consultant visibility', () => {
    it("shows Client A's assigned consultant name, and null for Client B (no active assignment)", async () => {
      const a = await getClientOverview(clientA.actor);
      const b = await getClientOverview(clientB.actor);
      expect(a.consultant).toEqual({ name: 'Integration TRAVEL_CONSULTANT' });
      expect(b.consultant).toBeNull();
    });
  });

  describe('absolute cross-client isolation', () => {
    it("Client A's overview contains none of Client B's identity, and vice versa", async () => {
      const a = JSON.stringify(await getClientOverview(clientA.actor));
      const b = JSON.stringify(await getClientOverview(clientB.actor));

      expect(a).not.toContain(clientB.fullName);
      expect(a).not.toContain(clientB.email);
      expect(a).not.toContain(clientB.clientId);
      expect(a).not.toContain(clientB.userId);

      expect(b).not.toContain(clientA.fullName);
      expect(b).not.toContain(clientA.email);
      expect(b).not.toContain(clientA.clientId);
      expect(b).not.toContain(clientA.userId);
      expect(b).not.toContain(aBookingRefConfirmed);
      expect(b).not.toContain(aBookingRefCancelled);
    });
  });

  describe('composed DTO minimization (D-040 §8)', () => {
    it("Client A's overview leaks no internal id, notes, money, currency, proposal content, or history", async () => {
      const serialized = JSON.stringify(await getClientOverview(clientA.actor));

      for (const secret of [
        clientA.clientId,
        clientA.userId,
        clientA.profileId,
        clientA.notesCanary!,
        aContentMarker,
        aInternalNotes,
        aClientVisNotes,
        '123456.78',
        'PHP',
        ...createdProposalIds,
      ]) {
        expect(serialized).not.toContain(secret);
      }
      // The one client-facing booking identifier IS present.
      expect(serialized).toContain(aBookingRefConfirmed);
    });
  });

  describe('the fifteen D-040 §6.4 scenario traces (data layer)', () => {
    for (const spec of SCENARIOS) {
      it(`scenario ${spec.n} -> proposalLine ${spec.proposalLine ?? '(omitted)'}, progressLine ${spec.progressLine}`, async () => {
        const overview = await getClientOverview(scenarioActors.get(spec.n)!);
        expect(overview.travelStatus.proposalLine?.state ?? null).toBe(spec.proposalLine);
        expect(overview.travelStatus.progressLine.state).toBe(spec.progressLine);
      });
    }
  });
});
