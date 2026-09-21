import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/lib/auth/guards';

// Database-backed integration test satisfying
// docs/HERITAGE_V3_DECISIONS_LOG.md D-051 §13's real-PostgreSQL integration
// requirement for the Conversations feature (D-051 Stage 5): "the real
// `message_author_path_exclusive`, `message_client_author_not_internal_note`,
// and `conversation_participant_identity_role_match` CHECK constraints and
// the two partial unique indexes actually reject the writes they are
// designed to reject; absolute cross-client isolation for
// Conversations/Messages, proven the same way D-040 §9/D-047/D-049/D-050 §7
// already prove it for their own data; and a scan of the composed
// client-facing result for the exact plaintext `Conversation.id`/`Client.id`/
// `ClientProfile.id`/`User.id` values, confirming absence — never a
// UUID-shape regular expression." Every mocked test elsewhere in this
// feature (schemas.test.ts, errors.test.ts, repository.test.ts,
// service.test.ts) intentionally mocks Prisma — none of them can prove real
// database-level constraint/index/isolation behavior against an actual
// PostgreSQL database. This file proves it for real, against a dedicated,
// disposable PostgreSQL database — never the shared local `heritage_v3_dev`
// database — using this feature's own real, unmodified `service.ts` exports.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/proposals/, features/client-portal/, features/leads/,
// features/clients/, features/assignments/, and features/staff/'s own
// service.integration.test.ts files — see any of those files' own doc
// comment for the full rationale. In short: no `@/lib/db` or `./service`
// static import; everything real is imported dynamically inside `beforeAll`
// only after `TEST_DATABASE_URL` has been validated; the suite is
// `describe.skipIf`-skipped entirely (no import, no connection) whenever
// `TEST_DATABASE_URL` is unset, which is the default for `pnpm test` today.
//
// Fixture data is deliberately non-PII: synthetic names, `@example.test`
// emails, and opaque canary tokens only — no real personal data, and no
// credential is ever constructed or logged.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

/**
 * Parses and validates `TEST_DATABASE_URL` without ever interpolating the
 * raw connection string into a thrown message — a deliberate, self-contained
 * copy of the identical guard already established in features/proposals/,
 * features/client-portal/, features/leads/, features/clients/,
 * features/assignments/, and features/staff/'s own
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
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the conversations integration suite.',
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
const originalRateLimitSecret = process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;

describe.skipIf(!hasTestDatabaseUrl)('conversations service integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let createConversationAsClient: (typeof import('./service'))['createConversationAsClient'];
  let createConversationAsStaff: (typeof import('./service'))['createConversationAsStaff'];
  let listConversationsForClient: (typeof import('./service'))['listConversationsForClient'];

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;

  const actorUserIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdProfileIds: string[] = [];
  const createdConversationIds: string[] = [];

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
    ({ createConversationAsClient, createConversationAsStaff, listConversationsForClient } =
      await import('./service'));

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
      const email = `conversations-integration-${role.toLowerCase()}-${randomUUID()}@example.test`;
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
          const allUserIds = [...actorUserIds, ...createdUserIds];

          // Deletion order respects onDelete: Restrict throughout
          // schema.prisma — Message and ConversationParticipant both
          // reference Conversation (Restrict); Conversation references
          // Client (Restrict); ClientProfile references both Client and
          // User (Restrict, both); StaffAssignment references Client and
          // the assigning/assigned User. Deepest dependents are removed
          // first.
          if (createdConversationIds.length > 0) {
            await prisma.message.deleteMany({
              where: { conversationId: { in: createdConversationIds } },
            });
            await prisma.conversationParticipant.deleteMany({
              where: { conversationId: { in: createdConversationIds } },
            });
            await prisma.conversation.deleteMany({
              where: { id: { in: createdConversationIds } },
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

          // --- Zero-residue proof (this checkpoint's own explicit
          // requirement): re-query every exact tracked identifier after
          // cleanup and confirm none remain. Never a broad/unscoped query —
          // every check below is scoped to this suite's own recorded ids. ---
          if (createdConversationIds.length > 0) {
            expect(
              await prisma.message.findMany({
                where: { conversationId: { in: createdConversationIds } },
                select: { id: true },
              }),
              'Message residue',
            ).toEqual([]);
            expect(
              await prisma.conversationParticipant.findMany({
                where: { conversationId: { in: createdConversationIds } },
                select: { id: true },
              }),
              'ConversationParticipant residue',
            ).toEqual([]);
            expect(
              await prisma.conversation.findMany({
                where: { id: { in: createdConversationIds } },
                select: { id: true },
              }),
              'Conversation residue',
            ).toEqual([]);
          }
          expect(
            await prisma.staffAssignment.findMany({
              where: {
                OR: [
                  { clientId: { in: createdClientIds } },
                  { assignedStaffId: { in: allUserIds } },
                  { assignedByUserId: { in: allUserIds } },
                ],
              },
              select: { id: true },
            }),
            'StaffAssignment residue',
          ).toEqual([]);
          if (createdProfileIds.length > 0) {
            expect(
              await prisma.clientProfile.findMany({
                where: { id: { in: createdProfileIds } },
                select: { id: true },
              }),
              'ClientProfile residue',
            ).toEqual([]);
          }
          if (createdClientIds.length > 0) {
            expect(
              await prisma.client.findMany({
                where: { id: { in: createdClientIds } },
                select: { id: true },
              }),
              'Client residue',
            ).toEqual([]);
          }
          if (allUserIds.length > 0) {
            expect(
              await prisma.user.findMany({
                where: { id: { in: allUserIds } },
                select: { id: true },
              }),
              'User (fixture) residue',
            ).toEqual([]);
          }
        } finally {
          await prisma.$disconnect();
        }
      }
    } finally {
      // Restored unconditionally — even when `prisma` was never assigned
      // (e.g. `validateTestDatabaseUrl` threw) or when cleanup above throws
      // — so this suite never leaves a stale
      // DATABASE_URL/BETTER_AUTH_SECRET/BETTER_AUTH_URL/
      // ACTIVATION_RATE_LIMIT_HMAC_SECRET behind in the shared Vitest
      // worker's process environment.
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
  }, 60_000);

  // --- Shared fixture helpers ---

  type ConversationClientFixture = {
    userId: string;
    clientId: string;
    profileId: string;
    actor: AuthenticatedUser;
  };

  /** Inserts a real, activated Client (User + Client + ClientProfile) —
   * tracked for cleanup. Mirrors features/client-portal/service.
   * integration.test.ts's identical `createClientWithProfile` fixture. */
  async function createClientWithProfile(label: string): Promise<ConversationClientFixture> {
    const userId = randomUUID();
    const clientId = randomUUID();
    const profileId = randomUUID();
    const fullName = `Conversations Integration ${label} ${randomUUID()}`;
    const email = `conversations-integration-${randomUUID()}@example.test`;

    await prisma!.user.create({
      data: { id: userId, name: fullName, email, role: 'CLIENT', isActive: true },
    });
    createdUserIds.push(userId);
    await prisma!.client.create({ data: { id: clientId, fullName, email } });
    createdClientIds.push(clientId);
    await prisma!.clientProfile.create({ data: { id: profileId, userId, clientId } });
    createdProfileIds.push(profileId);

    return {
      userId,
      clientId,
      profileId,
      actor: { id: userId, email, name: fullName, role: 'CLIENT' },
    };
  }

  /** Inserts an active StaffAssignment linking `staffId` to `clientId`
   * directly — mirrors every existing integration suite's identical
   * "insert the assignment fixture directly, never through the untouched
   * features/assignments module" precedent (e.g.
   * features/proposals/service.integration.test.ts's own
   * `assignClientToStaff`). */
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

  /** A bare, message-less, participant-less Conversation row for the
   * constraint/index tests below — each test creates its own fresh
   * Conversation so no test's persisted row can collide with another
   * test's partial-unique-index scenario. */
  async function createBareConversation(clientId: string): Promise<string> {
    const id = randomUUID();
    await prisma!.conversation.create({ data: { id, clientId, category: 'GENERAL_INQUIRY' } });
    createdConversationIds.push(id);
    return id;
  }

  // ---------------------------------------------------------------------
  // Group A — CHECK constraint: message_author_path_exclusive
  // ---------------------------------------------------------------------

  it('rejects a Message with neither authorStaffUserId nor authorClientProfileId set — message_author_path_exclusive', async () => {
    const constraintClient = await createClientWithProfile('Constraint Author Neither');
    const conversationId = await createBareConversation(constraintClient.clientId);

    await expect(
      prisma!.message.create({
        data: {
          id: randomUUID(),
          conversationId,
          body: 'orphan author message',
          visibility: 'CLIENT_VISIBLE',
          authorStaffUserId: null,
          authorClientProfileId: null,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a Message with both authorStaffUserId and authorClientProfileId set — message_author_path_exclusive', async () => {
    const constraintClient = await createClientWithProfile('Constraint Author Both');
    const conversationId = await createBareConversation(constraintClient.clientId);

    await expect(
      prisma!.message.create({
        data: {
          id: randomUUID(),
          conversationId,
          body: 'dual author message',
          visibility: 'CLIENT_VISIBLE',
          authorStaffUserId: tcActor.id,
          authorClientProfileId: constraintClient.profileId,
        },
      }),
    ).rejects.toThrow();
  });

  it('permits a valid staff-authored Message — message_author_path_exclusive valid shape', async () => {
    const constraintClient = await createClientWithProfile('Constraint Valid Staff Author');
    const conversationId = await createBareConversation(constraintClient.clientId);

    const created = await prisma!.message.create({
      data: {
        id: randomUUID(),
        conversationId,
        body: 'valid staff-authored message',
        visibility: 'CLIENT_VISIBLE',
        authorStaffUserId: tcActor.id,
        authorClientProfileId: null,
      },
    });
    expect(created.authorStaffUserId).toBe(tcActor.id);
    expect(created.authorClientProfileId).toBeNull();
  });

  it('permits a valid client-authored, CLIENT_VISIBLE Message — message_author_path_exclusive valid shape; also the valid-case proof for message_client_author_not_internal_note', async () => {
    const constraintClient = await createClientWithProfile('Constraint Valid Client Author');
    const conversationId = await createBareConversation(constraintClient.clientId);

    const created = await prisma!.message.create({
      data: {
        id: randomUUID(),
        conversationId,
        body: 'valid client-authored message',
        visibility: 'CLIENT_VISIBLE',
        authorStaffUserId: null,
        authorClientProfileId: constraintClient.profileId,
      },
    });
    expect(created.authorClientProfileId).toBe(constraintClient.profileId);
    expect(created.authorStaffUserId).toBeNull();
    expect(created.visibility).toBe('CLIENT_VISIBLE');
  });

  // ---------------------------------------------------------------------
  // Group B — CHECK constraint: message_client_author_not_internal_note
  // ---------------------------------------------------------------------

  it('rejects a client-authored Message with visibility INTERNAL_NOTE — message_client_author_not_internal_note (the valid client-authored CLIENT_VISIBLE case is already proven in Group A above)', async () => {
    const constraintClient = await createClientWithProfile('Constraint Client Internal Note');
    const conversationId = await createBareConversation(constraintClient.clientId);

    await expect(
      prisma!.message.create({
        data: {
          id: randomUUID(),
          conversationId,
          body: 'client attempting an internal note',
          visibility: 'INTERNAL_NOTE',
          authorStaffUserId: null,
          authorClientProfileId: constraintClient.profileId,
        },
      }),
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------------------
  // Group C — CHECK constraint: conversation_participant_identity_role_match
  // ---------------------------------------------------------------------

  it('rejects a CLIENT-role participant carrying a staff identity instead of a ClientProfile — conversation_participant_identity_role_match', async () => {
    const constraintClient = await createClientWithProfile('Constraint Client Role Mismatch');
    const conversationId = await createBareConversation(constraintClient.clientId);

    await expect(
      prisma!.conversationParticipant.create({
        data: {
          id: randomUUID(),
          conversationId,
          role: 'CLIENT',
          staffUserId: tcActor.id,
          clientProfileId: null,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a staff-role participant carrying a ClientProfile identity instead of a staff user — conversation_participant_identity_role_match', async () => {
    const constraintClient = await createClientWithProfile('Constraint Staff Role Mismatch');
    const conversationId = await createBareConversation(constraintClient.clientId);

    await expect(
      prisma!.conversationParticipant.create({
        data: {
          id: randomUUID(),
          conversationId,
          role: 'TRAVEL_CONSULTANT',
          staffUserId: null,
          clientProfileId: constraintClient.profileId,
        },
      }),
    ).rejects.toThrow();
  });

  it('permits a valid CLIENT participant row — conversation_participant_identity_role_match valid shape', async () => {
    const constraintClient = await createClientWithProfile('Constraint Valid Client Participant');
    const conversationId = await createBareConversation(constraintClient.clientId);

    const created = await prisma!.conversationParticipant.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: 'CLIENT',
        staffUserId: null,
        clientProfileId: constraintClient.profileId,
      },
    });
    expect(created.role).toBe('CLIENT');
    expect(created.clientProfileId).toBe(constraintClient.profileId);
    expect(created.staffUserId).toBeNull();
  });

  it('permits a valid staff participant row — conversation_participant_identity_role_match valid shape', async () => {
    const constraintClient = await createClientWithProfile('Constraint Valid Staff Participant');
    const conversationId = await createBareConversation(constraintClient.clientId);

    const created = await prisma!.conversationParticipant.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: 'TRAVEL_CONSULTANT',
        staffUserId: tcActor.id,
        clientProfileId: null,
      },
    });
    expect(created.role).toBe('TRAVEL_CONSULTANT');
    expect(created.staffUserId).toBe(tcActor.id);
    expect(created.clientProfileId).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Group D — partial unique index: conversation_participant_active_staff_key
  // ---------------------------------------------------------------------

  it('rejects a duplicate active staff participant, then permits a new active row once the earlier one is removedAt-marked — conversation_participant_active_staff_key (proves the partial predicate, not an unconditional unique constraint)', async () => {
    const constraintClient = await createClientWithProfile('Constraint Active Staff Key');
    const conversationId = await createBareConversation(constraintClient.clientId);

    const first = await prisma!.conversationParticipant.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: 'TRAVEL_CONSULTANT',
        staffUserId: tcActor.id,
        clientProfileId: null,
      },
    });
    expect(first.removedAt).toBeNull();

    await expect(
      prisma!.conversationParticipant.create({
        data: {
          id: randomUUID(),
          conversationId,
          role: 'TRAVEL_CONSULTANT',
          staffUserId: tcActor.id,
          clientProfileId: null,
        },
      }),
    ).rejects.toThrow();

    // Marking the earlier row removed lifts the partial index's own
    // predicate (`WHERE "removedAt" IS NULL`) for that row — a genuinely
    // unconditional unique constraint would still reject the row below.
    await prisma!.conversationParticipant.update({
      where: { id: first.id },
      data: { removedAt: new Date() },
    });

    const rejoined = await prisma!.conversationParticipant.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: 'TRAVEL_CONSULTANT',
        staffUserId: tcActor.id,
        clientProfileId: null,
      },
    });
    expect(rejoined.removedAt).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Group E — partial unique index:
  // conversation_participant_active_client_profile_key
  // ---------------------------------------------------------------------

  it('rejects a duplicate active client participant, then permits a new active row once the earlier one is removedAt-marked — conversation_participant_active_client_profile_key (proves the partial predicate, not an unconditional unique constraint)', async () => {
    const constraintClient = await createClientWithProfile('Constraint Active Client Key');
    const conversationId = await createBareConversation(constraintClient.clientId);

    const first = await prisma!.conversationParticipant.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: 'CLIENT',
        staffUserId: null,
        clientProfileId: constraintClient.profileId,
      },
    });
    expect(first.removedAt).toBeNull();

    await expect(
      prisma!.conversationParticipant.create({
        data: {
          id: randomUUID(),
          conversationId,
          role: 'CLIENT',
          staffUserId: null,
          clientProfileId: constraintClient.profileId,
        },
      }),
    ).rejects.toThrow();

    await prisma!.conversationParticipant.update({
      where: { id: first.id },
      data: { removedAt: new Date() },
    });

    const rejoined = await prisma!.conversationParticipant.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: 'CLIENT',
        staffUserId: null,
        clientProfileId: constraintClient.profileId,
      },
    });
    expect(rejoined.removedAt).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Group F — cross-client isolation, the CONVERSATION_FORBIDDEN outcome,
  // and exact-plaintext identifier absence (D-051 §13/§9/§15)
  // ---------------------------------------------------------------------

  it('D-051 §13: real cross-client isolation, the CONVERSATION_FORBIDDEN outcome for a mismatched clientId, and exact-plaintext identifier absence from the client-facing render', async () => {
    const clientA = await createClientWithProfile('Isolation A');
    const clientB = await createClientWithProfile('Isolation B');

    // Client A's Travel Consultant assignment is established through the
    // same real, direct-insert fixture pattern every sibling integration
    // suite already uses (D-051 §5) — never through a raw
    // ConversationParticipant insert, and never weakening authorization.
    await assignClientToStaff(clientA.clientId, tcActor.id);

    const canaryA = `CONV-INTEGRATION-A-${randomUUID()}`;
    const canaryB = `CONV-INTEGRATION-B-${randomUUID()}`;

    // Client A's Conversation is created through the real staff-side
    // service (createConversationAsStaff), exercising the real, just-
    // established TC assignment (D-051 §3/§16) — never a raw participant
    // insert.
    await createConversationAsStaff(tcActor, {
      clientId: clientA.clientId,
      category: 'GENERAL_INQUIRY',
      body: canaryA,
    });

    // Client B's Conversation is created through the real client-side
    // service (createConversationAsClient) — the plain client-initiated
    // path, D-051 §3 — with no Travel Consultant assignment at all.
    await createConversationAsClient(clientB.actor, clientB.clientId, {
      category: 'BOOKING',
      body: canaryB,
    });

    // Recover each real Conversation.id — a plain read, never a production
    // code path under test — tracked for cleanup and for the
    // identifier-absence proof below.
    const conversationARow = await prisma!.conversation.findFirstOrThrow({
      where: { clientId: clientA.clientId },
      select: { id: true },
    });
    const conversationBRow = await prisma!.conversation.findFirstOrThrow({
      where: { clientId: clientB.clientId },
      select: { id: true },
    });
    createdConversationIds.push(conversationARow.id, conversationBRow.id);

    // --- Cross-client isolation (D-051 §13; .claude/rules/client-portal.md
    //     Absolute Client Isolation). Every check below is an exact-string
    //     predicate — never a UUID-shape or generic-pattern match. ---
    const resultA = await listConversationsForClient(clientA.actor, clientA.clientId);
    const resultB = await listConversationsForClient(clientB.actor, clientB.clientId);

    expect(resultA.render).toHaveLength(1);
    expect(resultB.render).toHaveLength(1);

    const renderedA = JSON.stringify(resultA.render);
    const renderedB = JSON.stringify(resultB.render);

    expect(renderedA.includes(canaryA), "A's own list contains A's canary").toBe(true);
    expect(renderedA.includes(canaryB), "A's list must not contain B's canary").toBe(false);
    expect(renderedB.includes(canaryB), "B's own list contains B's canary").toBe(true);
    expect(renderedB.includes(canaryA), "B's list must not contain A's canary").toBe(false);

    // --- The single generic CONVERSATION_FORBIDDEN outcome (D-051 §7/§15)
    //     for a CLIENT actor calling the client-list service with another
    //     client's clientId. ---
    await expect(listConversationsForClient(clientA.actor, clientB.clientId)).rejects.toMatchObject(
      { code: 'CONVERSATION_FORBIDDEN', status: 403 },
    );

    // The inverse direction (Client B's actor against Client A's clientId)
    // would exercise the identical `canAccessClient` CLIENT branch
    // (`findClientProfileOwnership(actor.id, clientId)`,
    // features/assignments/authorization.ts) with only the actor/clientId
    // values swapped — the same code path already proven above adds no
    // further evidence, so it is deliberately not repeated here.

    // --- Exact plaintext identifier-absence proof (D-051 §13/§9) — never a
    //     UUID-shape regular expression. ---
    const forbiddenValuesA = [
      conversationARow.id, // Conversation.id
      clientA.clientId, // Client.id
      clientA.profileId, // ClientProfile.id
      clientA.userId, // User.id (the client's own)
    ];
    for (const value of forbiddenValuesA) {
      expect(renderedA.includes(value), `render must not contain "${value}"`).toBe(false);
    }
    // The assigned Travel Consultant's own raw User.id must also never
    // appear — only their real display name (D-040 §7's disclosure
    // precedent, reused by D-051 §9) is an allowed field on the
    // client-facing render.
    expect(renderedA.includes(tcActor.id), 'render must not contain the staff User.id').toBe(false);

    // --- serverModel: the ONLY place Conversation.id is ever exposed,
    //     index-aligned with the corresponding render entry (D-051 §15). ---
    expect(resultA.serverModel).toHaveLength(resultA.render.length);
    expect(resultA.serverModel[0]!.id).toBe(conversationARow.id);
    expect(
      JSON.stringify(resultA.render[0]).includes(conversationARow.id),
      'the matching render entry must not itself contain Conversation.id',
    ).toBe(false);
  });
});
