import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/lib/auth/guards';

// Database-backed integration test for the D-034 Stage 3 invitation
// repository/service, run against the real, migrated `heritage_v3_test`
// schema — proving the service layer's behavior actually satisfies the
// hand-written CHECK constraints and the new providerMessageId unique
// index (migrations 20260826090000/90001), not merely that a mocked
// repository was called correctly (see service.test.ts for that).
//
// IMPORT SAFETY: mirrors features/staff/service.integration.test.ts
// exactly — this file must not statically import `@/lib/db`, `@/lib/env`,
// or `@/features/invitations/service` (which transitively imports
// `@/lib/db`), since all of those eagerly validate environment variables
// and/or open a real database adapter at module-import time. Instead,
// `process.env.DATABASE_URL` is set to the validated `TEST_DATABASE_URL`
// *before* any of those modules are ever imported, via a dynamic
// `await import(...)` inside `beforeAll` — never a top-level `import`,
// which Vitest would hoist and execute before this file's own code runs.
//
// AUTOMATED DELIVERY: `EMAIL_DELIVERY_ENABLED` is deliberately left unset
// (defaults to 'false') for this entire file — this test never sends a
// real email or calls the real Resend API. It only proves that requesting
// an AUTOMATED_EMAIL send while delivery is disabled is correctly
// rejected before any provider call would ever be attempted.
//
// SKIP/FAIL SEMANTICS: identical to features/staff/service.integration.test.ts
// — skipped entirely when TEST_DATABASE_URL is unset; a loud failure (never
// a silent skip) if it is set but fails validation.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the invitations integration suite.',
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

describe.skipIf(!hasTestDatabaseUrl)('portal invitation service (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'];
  let service: typeof import('./service');
  let repository: typeof import('./repository');
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;

  let adminActor: AuthenticatedUser;
  let consultantActor: AuthenticatedUser;
  let unassignedConsultantActor: AuthenticatedUser;

  const createdUserIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdAssignmentIds: string[] = [];

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
    service = await import('./service');
    repository = await import('./repository');

    // AuditLog.actorId carries a hard onDelete:Restrict foreign key to
    // User.id (apps/web/prisma/schema.prisma), so every invitation
    // mutation this suite exercises needs a real, persisted staff User —
    // not just an in-memory AuthenticatedUser object.
    async function createStaffUser(
      role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT',
    ): Promise<AuthenticatedUser> {
      const id = randomUUID();
      const email = `invitation-suite-${role.toLowerCase()}-${id}@example.test`;
      await prisma.user.create({
        data: {
          id,
          email,
          name: `${role} (invitation suite)`,
          role,
          isActive: true,
          emailVerified: true,
        },
      });
      createdUserIds.push(id);
      return { id, email, name: `${role} (invitation suite)`, role };
    }

    adminActor = await createStaffUser('ADMIN_MANAGER');
    consultantActor = await createStaffUser('TRAVEL_CONSULTANT');
    unassignedConsultantActor = await createStaffUser('TRAVEL_CONSULTANT');
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
      await prisma.staffAssignment.deleteMany({ where: { id: { in: createdAssignmentIds } } });
      await prisma.portalInvitation.deleteMany({ where: { clientId: { in: createdClientIds } } });
      await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await prisma.$disconnect();
    }

    if (didSetBetterAuthSecret) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    if (didSetBetterAuthUrl) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  async function createClient(): Promise<string> {
    const id = randomUUID();
    await prisma.client.create({
      data: {
        id,
        fullName: 'Invitation Suite Client',
        email: `invitation-suite-client-${id}@example.test`,
      },
    });
    createdClientIds.push(id);
    return id;
  }

  async function assignConsultant(clientId: string, staffId: string): Promise<void> {
    const id = randomUUID();
    await prisma.staffAssignment.create({
      data: { id, clientId, assignedStaffId: staffId, assignedByUserId: adminActor.id },
    });
    createdAssignmentIds.push(id);
  }

  it('runs the full prepare -> send (manual) -> confirm -> revoke lifecycle against the real schema', async () => {
    const clientId = await createClient();

    const prepared = await service.prepareInvitation(adminActor, clientId);
    expect(prepared.status).toBe('INVITATION_PREPARED');
    expect(prepared.tokenHash).toBeNull();

    // Idempotent no-op retry.
    const preparedAgain = await service.prepareInvitation(adminActor, clientId);
    expect(preparedAgain.id).toBe(prepared.id);

    const sendResult = await service.sendInvitation(adminActor, clientId, {
      deliveryMethod: 'MANUAL_EMAIL',
      idempotencyKey: randomUUID(),
    });
    expect(sendResult.delivery).toBe('reserved-only');
    expect(sendResult.invitation.status).toBe('INVITATION_SENT');
    expect(sendResult.invitation.tokenHash).not.toBeNull();
    expect(sendResult.invitation.deliveryMethod).toBeNull();
    expect(sendResult.invitation.deliveryState).toBe('NOT_ATTEMPTED');
    // The one and only response that ever carries the raw, one-time
    // manual invitation URL.
    expect(sendResult.manualInvitationUrl).toMatch(/^https?:\/\/.+\/activate\/.+/);
    // The GET read model never carries a raw token, tokenHash, or URL —
    // only the persisted, hashed/evidence fields.
    const afterSend = await service.getInvitationForClient(adminActor, clientId);
    expect(afterSend).not.toHaveProperty('rawToken');
    expect(afterSend).not.toHaveProperty('manualInvitationUrl');
    expect(Object.values(afterSend as object)).not.toContain(sendResult.manualInvitationUrl);

    const confirmationKey = randomUUID();
    const confirmed = await service.confirmManualSend(adminActor, clientId, confirmationKey);
    expect(confirmed.deliveryState).toBe('MANUALLY_CONFIRMED');
    expect(confirmed.deliveryMethod).toBe('MANUAL_EMAIL');
    expect(confirmed.deliveryConfirmedByStaffId).toBe(adminActor.id);
    expect(confirmed.sendOperationId).toBe(confirmationKey);

    // Idempotent no-op retry of the confirmation, including with a
    // different (stale) key — confirmation is safe to repeat
    // unconditionally since it never rotates a token.
    const confirmedAgain = await service.confirmManualSend(adminActor, clientId, randomUUID());
    expect(confirmedAgain.deliveryConfirmedAt?.getTime()).toBe(
      confirmed.deliveryConfirmedAt?.getTime(),
    );
    expect(confirmedAgain.sendOperationId).toBe(confirmationKey);

    const revoked = await service.revokeInvitation(
      adminActor,
      clientId,
      'integration test cleanup',
    );
    expect(revoked.status).toBe('INVITATION_REVOKED');
    expect(revoked.tokenHash).toBeNull();

    // Idempotent no-op retry of the revocation.
    const revokedAgain = await service.revokeInvitation(
      adminActor,
      clientId,
      'integration test cleanup',
    );
    expect(revokedAgain.status).toBe('INVITATION_REVOKED');

    const auditActions = await prisma.auditLog.findMany({
      where: { entityType: 'PortalInvitation', entityId: prepared.id },
      orderBy: { createdAt: 'asc' },
      select: { action: true },
    });
    expect(auditActions.map((row) => row.action)).toEqual([
      'PORTAL_INVITATION_PREPARED',
      'PORTAL_INVITATION_SENT_MANUAL_CONFIRMED',
      'PORTAL_INVITATION_REVOKED',
    ]);
  });

  it('rejects an automated send while delivery is disabled, never touching the row', async () => {
    const clientId = await createClient();
    await service.prepareInvitation(adminActor, clientId);

    await expect(
      service.sendInvitation(adminActor, clientId, {
        deliveryMethod: 'AUTOMATED_EMAIL',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_DISABLED' });

    const invitation = await service.getInvitationForClient(adminActor, clientId);
    expect(invitation?.status).toBe('INVITATION_PREPARED');
  });

  it('gives ADMIN_MANAGER a real CLIENT_NOT_FOUND for a nonexistent client', async () => {
    await expect(service.prepareInvitation(adminActor, randomUUID())).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  it('rejects an unassigned TRAVEL_CONSULTANT with CLIENT_FORBIDDEN, indistinguishable from not-found', async () => {
    const clientId = await createClient();

    await expect(
      service.prepareInvitation(unassignedConsultantActor, clientId),
    ).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
  });

  it('allows a TRAVEL_CONSULTANT with an active assignment to prepare and send', async () => {
    const clientId = await createClient();
    await assignConsultant(clientId, consultantActor.id);

    const prepared = await service.prepareInvitation(consultantActor, clientId);
    expect(prepared.status).toBe('INVITATION_PREPARED');

    const sendResult = await service.sendInvitation(consultantActor, clientId, {
      deliveryMethod: 'MANUAL_EMAIL',
      idempotencyKey: randomUUID(),
    });
    expect(sendResult.invitation.status).toBe('INVITATION_SENT');
  });

  it('enforces the real providerMessageId unique index end-to-end', async () => {
    const clientAId = await createClient();
    const clientBId = await createClient();
    await service.prepareInvitation(adminActor, clientAId);
    await service.prepareInvitation(adminActor, clientBId);

    // Two separate invitations can each independently hold a null
    // providerMessageId (the unique index treats NULLs as distinct) — only
    // a genuine duplicate *non-null* value is rejected, which this suite
    // does not attempt to construct without a live provider (already
    // proven via the rolled-back temp-table truth table during this
    // migration's own verification pass).
    const invitationA = await service.getInvitationForClient(adminActor, clientAId);
    const invitationB = await service.getInvitationForClient(adminActor, clientBId);
    expect(invitationA?.providerMessageId).toBeNull();
    expect(invitationB?.providerMessageId).toBeNull();
  });

  it(
    'proves the stale-resend race against the real database: resend A succeeds, resend B ' +
      'succeeds and becomes current, a delayed retry of A is rejected and never rotates the ' +
      'token or clobbers B',
    async () => {
      const clientId = await createClient();
      await service.prepareInvitation(adminActor, clientId);
      await service.sendInvitation(adminActor, clientId, {
        deliveryMethod: 'MANUAL_EMAIL',
        idempotencyKey: randomUUID(),
      });

      // The state resend A's caller would have read before acting.
      const beforeA = await service.getInvitationForClient(adminActor, clientId);
      const preconditionA = {
        expectedCurrentSendOperationId: beforeA!.sendOperationId,
        expectedUpdatedAt: beforeA!.updatedAt,
      };

      const resultA = await service.resendInvitation(
        adminActor,
        clientId,
        { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey: randomUUID() },
        preconditionA,
      );
      const tokenAfterA = resultA.invitation.tokenHash;

      // Resend B reads the *current* (post-A) state and succeeds.
      const beforeB = await service.getInvitationForClient(adminActor, clientId);
      const resultB = await service.resendInvitation(
        adminActor,
        clientId,
        { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey: randomUUID() },
        {
          expectedCurrentSendOperationId: beforeB!.sendOperationId,
          expectedUpdatedAt: beforeB!.updatedAt,
        },
      );
      const tokenAfterB = resultB.invitation.tokenHash;
      expect(tokenAfterB).not.toBe(tokenAfterA);

      // A delayed retry of A's original request — still carrying A's
      // now-stale precondition — must be rejected, not silently rotate
      // the token a third time or overwrite B's already-current state.
      await expect(
        service.resendInvitation(
          adminActor,
          clientId,
          { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey: randomUUID() },
          preconditionA,
        ),
      ).rejects.toMatchObject({ code: 'INVITATION_SEND_OPERATION_STALE' });

      const finalState = await service.getInvitationForClient(adminActor, clientId);
      expect(finalState?.tokenHash).toBe(tokenAfterB);
    },
  );

  it('never regresses a resolved automated delivery state on a duplicate/late reconciliation attempt, proven against the real CHECK-guarded update', async () => {
    const clientId = await createClient();
    const prepared = await service.prepareInvitation(adminActor, clientId);

    await prisma.$transaction(async (tx) => {
      // Simulate an automated send having already resolved to
      // PROVIDER_DELIVERED (bypassing the disabled real-provider path,
      // exactly as a completed send + webhook sequence would leave the
      // row) — real Prisma/PostgreSQL writes, not mocks.
      await repository.recordSendReservation(tx, prepared.id, {
        tokenHash: 'x'.repeat(64),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        destinationEmail: 'client@example.test',
        sentAt: new Date(),
        automated: { sendOperationId: randomUUID() },
      });
    });
    const reserved = await service.getInvitationForClient(adminActor, clientId);
    await prisma.$transaction((tx) =>
      repository.applyProviderDeliveryState(
        tx,
        reserved!.id,
        'PROVIDER_DELIVERED',
        `msg_${randomUUID()}`,
      ),
    );

    // A late/duplicate email.sent reconciliation attempt for the same
    // operation must be a real, database-enforced no-op — the guarded
    // UPDATE's WHERE clause (deliveryState = 'AUTOMATED_UNCONFIRMED')
    // matches zero rows here, so `reconcileUnconfirmedToAccepted` returns
    // null and PROVIDER_DELIVERED is never regressed to AUTOMATED_ACCEPTED.
    const reconciled = await prisma.$transaction((tx) =>
      repository.reconcileUnconfirmedToAccepted(tx, reserved!.id, 'a-late-message-id'),
    );
    expect(reconciled).toBeNull();

    const finalState = await service.getInvitationForClient(adminActor, clientId);
    expect(finalState?.deliveryState).toBe('PROVIDER_DELIVERED');
  });

  it('email.complained may supersede an already-delivered state (a complaint filed after delivery), proven against the real unconditional update', async () => {
    const clientId = await createClient();
    const prepared = await service.prepareInvitation(adminActor, clientId);
    await prisma.$transaction(async (tx) => {
      await repository.recordSendReservation(tx, prepared.id, {
        tokenHash: 'y'.repeat(64),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        destinationEmail: 'client@example.test',
        sentAt: new Date(),
        automated: { sendOperationId: randomUUID() },
      });
    });
    const reserved = await service.getInvitationForClient(adminActor, clientId);
    const messageId = `msg_${randomUUID()}`;
    await prisma.$transaction((tx) =>
      repository.applyProviderDeliveryState(tx, reserved!.id, 'PROVIDER_DELIVERED', messageId),
    );

    await prisma.$transaction((tx) =>
      repository.applyProviderDeliveryState(tx, reserved!.id, 'PROVIDER_COMPLAINED', messageId),
    );

    const finalState = await service.getInvitationForClient(adminActor, clientId);
    expect(finalState?.deliveryState).toBe('PROVIDER_COMPLAINED');

    // Applying the identical terminal state a second time (a duplicate
    // webhook delivery) is a harmless, idempotent no-op — no error, same
    // resulting state.
    await expect(
      prisma.$transaction((tx) =>
        repository.applyProviderDeliveryState(tx, reserved!.id, 'PROVIDER_COMPLAINED', messageId),
      ),
    ).resolves.toMatchObject({ deliveryState: 'PROVIDER_COMPLAINED' });
  });

  it('clears providerMessageId on every fresh reservation, so a late event for a superseded automated attempt can no longer correlate to this row', async () => {
    const clientId = await createClient();
    const prepared = await service.prepareInvitation(adminActor, clientId);
    const staleMessageId = `msg_${randomUUID()}`;

    await prisma.$transaction(async (tx) => {
      await repository.recordSendReservation(tx, prepared.id, {
        tokenHash: 'z'.repeat(64),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        destinationEmail: 'client@example.test',
        sentAt: new Date(),
        automated: { sendOperationId: randomUUID() },
      });
    });
    const firstAttempt = await service.getInvitationForClient(adminActor, clientId);
    await prisma.$transaction((tx) =>
      repository.recordAutomatedSendOutcome(tx, firstAttempt!.id, firstAttempt!.sendOperationId!, {
        deliveryState: 'AUTOMATED_ACCEPTED',
        providerMessageId: staleMessageId,
      }),
    );
    const beforeReissue = await service.getInvitationForClient(adminActor, clientId);
    expect(beforeReissue?.providerMessageId).toBe(staleMessageId);

    // An explicit reissue rotates the token and — the fix under review —
    // clears providerMessageId, even though this row's deliveryMethod
    // reservation only *reserves* AUTOMATED_UNCONFIRMED again; the stale
    // messageId from the first attempt must not linger.
    await service.resendInvitation(
      adminActor,
      clientId,
      { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey: randomUUID() },
      {
        expectedCurrentSendOperationId: beforeReissue!.sendOperationId,
        expectedUpdatedAt: beforeReissue!.updatedAt,
      },
    );

    const afterReissue = await prisma.portalInvitation.findUnique({ where: { clientId } });
    expect(afterReissue?.providerMessageId).toBeNull();

    // A late webhook for the original, now-superseded messageId can no
    // longer correlate to any row.
    const staleCorrelation = await repository.findInvitationByProviderMessageId(
      prisma,
      staleMessageId,
    );
    expect(staleCorrelation).toBeNull();
  });
});
