import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db`, which eagerly opens a real
// database adapter at import time — mock it before `./service` is
// imported, mirroring features/staff/service.test.ts and
// features/clients/service.test.ts exactly.
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: transactionMock } }));

const repositoryMocks = vi.hoisted(() => ({
  findInvitationByClientId: vi.fn(),
  findInvitationByProviderMessageId: vi.fn(),
  findInvitationBySendOperationId: vi.fn(),
  findClientEmailById: vi.fn(),
  findClientById: vi.fn(),
  createInvitation: vi.fn(),
  recordSendReservation: vi.fn(),
  recordSendReservationIfUnstale: vi.fn(),
  recordAutomatedSendOutcome: vi.fn(),
  reconcileUnconfirmedToAccepted: vi.fn(),
  applyProviderDeliveryState: vi.fn(),
  recordManualConfirmation: vi.fn(),
  recordRevocation: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

const authorizationMocks = vi.hoisted(() => ({ canAccessClient: vi.fn() }));
vi.mock('@/features/assignments/authorization', () => authorizationMocks);

const assignmentRepositoryMocks = vi.hoisted(() => ({ findActiveAssignmentForClient: vi.fn() }));
vi.mock('@/features/assignments/repository', () => assignmentRepositoryMocks);

const adapterMocks = vi.hoisted(() => ({
  isAutomatedDeliveryEnabled: vi.fn(),
  sendInvitationEmail: vi.fn(),
  verifyResendWebhook: vi.fn(),
  buildActivationUrl: vi.fn(() => 'http://localhost:3000/activate/mock-token'),
}));
vi.mock('./resend-adapter', () => adapterMocks);

import type { AuthenticatedUser } from '@/lib/auth/guards';

import type { InvitationRecord } from './repository';
import {
  confirmManualSend,
  handleResendWebhookEvent,
  prepareInvitation,
  resendInvitation,
  revokeInvitation,
  sendInvitation,
} from './service';

const TX_CLIENT = { marker: 'tx-client' };
const CLIENT_ID = 'client-1';

const ADMIN: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};

const CONSULTANT: AuthenticatedUser = {
  id: 'consultant-1',
  email: 'consultant@example.test',
  name: 'Travel Consultant',
  role: 'TRAVEL_CONSULTANT',
};

function invitation(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  return {
    id: 'invitation-1',
    clientId: CLIENT_ID,
    status: 'INVITATION_PREPARED',
    tokenHash: null,
    expiresAt: null,
    destinationEmail: null,
    deliveryMethod: null,
    deliveryState: 'NOT_ATTEMPTED',
    sendOperationId: null,
    providerMessageId: null,
    deliveryConfirmedAt: null,
    deliveryConfirmedByStaffId: null,
    sentAt: null,
    openedAt: null,
    activatedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
  authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
  adapterMocks.isAutomatedDeliveryEnabled.mockReturnValue(true);
  repositoryMocks.findClientById.mockResolvedValue({ id: CLIENT_ID });
});

describe('prepareInvitation', () => {
  it('creates a new invitation and writes an audit entry when none exists', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(null);
    const created = invitation();
    repositoryMocks.createInvitation.mockResolvedValue(created);

    const result = await prepareInvitation(ADMIN, CLIENT_ID);

    expect(result).toEqual(created);
    expect(repositoryMocks.createInvitation).toHaveBeenCalledWith(TX_CLIENT, CLIENT_ID);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ actorId: ADMIN.id, action: 'PORTAL_INVITATION_PREPARED' }),
    );
  });

  it('is an idempotent no-op when already INVITATION_PREPARED', async () => {
    const existing = invitation();
    repositoryMocks.findInvitationByClientId.mockResolvedValue(existing);

    const result = await prepareInvitation(ADMIN, CLIENT_ID);

    expect(result).toEqual(existing);
    expect(repositoryMocks.createInvitation).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('gives ADMIN_MANAGER a clean CLIENT_NOT_FOUND for a nonexistent client, never attempting the insert', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(null);
    repositoryMocks.findClientById.mockResolvedValue(null);

    await expect(prepareInvitation(ADMIN, CLIENT_ID)).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
    expect(repositoryMocks.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects re-preparing an invitation that has already progressed', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );

    await expect(prepareInvitation(ADMIN, CLIENT_ID)).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_EXISTS',
    });
  });

  it('rejects an unauthorized actor before ever touching the transaction', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(prepareInvitation(CONSULTANT, CLIENT_ID)).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('gives ADMIN_MANAGER a CLIENT_NOT_FOUND and every other role CLIENT_FORBIDDEN for the same unauthorized outcome', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(prepareInvitation(ADMIN, CLIENT_ID)).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  it("re-checks a TRAVEL_CONSULTANT's active assignment transaction-locally, even after the pre-check passed", async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

    await expect(prepareInvitation(CONSULTANT, CLIENT_ID)).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenCalledWith(
      TX_CLIENT,
      CLIENT_ID,
    );
    expect(repositoryMocks.findInvitationByClientId).not.toHaveBeenCalled();
  });
});

describe('sendInvitation', () => {
  const idempotencyKey = '11111111-1111-1111-1111-111111111111';

  it('rejects automated delivery when it is disabled', async () => {
    adapterMocks.isAutomatedDeliveryEnabled.mockReturnValue(false);

    await expect(
      sendInvitation(ADMIN, CLIENT_ID, { deliveryMethod: 'AUTOMATED_EMAIL', idempotencyKey }),
    ).rejects.toMatchObject({ code: 'DELIVERY_DISABLED' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('throws INVITATION_NOT_FOUND when no invitation has been prepared', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(null);

    await expect(
      sendInvitation(ADMIN, CLIENT_ID, { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey }),
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_FOUND' });
  });

  it('rejects a client with no email on file', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(invitation());
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: null });

    await expect(
      sendInvitation(ADMIN, CLIENT_ID, { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey }),
    ).rejects.toMatchObject({ code: 'CLIENT_EMAIL_MISSING' });
  });

  it('reserves a manual send without ever calling the provider', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(invitation());
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    const reserved = invitation({ status: 'INVITATION_SENT' });
    repositoryMocks.recordSendReservation.mockResolvedValue(reserved);

    const result = await sendInvitation(ADMIN, CLIENT_ID, {
      deliveryMethod: 'MANUAL_EMAIL',
      idempotencyKey,
    });

    expect(result).toEqual({
      invitation: reserved,
      delivery: 'reserved-only',
      manualInvitationUrl: 'http://localhost:3000/activate/mock-token',
    });
    expect(adapterMocks.sendInvitationEmail).not.toHaveBeenCalled();
    expect(repositoryMocks.recordSendReservation).toHaveBeenCalledWith(
      TX_CLIENT,
      'invitation-1',
      expect.not.objectContaining({ automated: expect.anything() }),
    );
    // No audit entry for an unconfirmed manual send — only confirm-manual-sent writes one.
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('never persists, logs, or otherwise leaks the raw token or the full manual URL anywhere but this one response', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(invitation());
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    const reserved = invitation({ status: 'INVITATION_SENT' });
    repositoryMocks.recordSendReservation.mockResolvedValue(reserved);

    await sendInvitation(ADMIN, CLIENT_ID, { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey });

    // The repository write call never receives a raw token or URL field —
    // only tokenHash/expiresAt/destinationEmail, matching the persisted
    // schema exactly.
    const [, , writeInput] = repositoryMocks.recordSendReservation.mock.calls[0]!;
    expect(Object.keys(writeInput)).toEqual(
      expect.arrayContaining(['tokenHash', 'expiresAt', 'destinationEmail', 'sentAt']),
    );
    expect(writeInput).not.toHaveProperty('rawToken');
    expect(writeInput).not.toHaveProperty('manualInvitationUrl');
    // The audit writer is never called at all for an unconfirmed manual
    // reservation (asserted above), so there is no audit snapshot to leak
    // it into either.
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('reserves an automated send as AUTOMATED_UNCONFIRMED, then resolves it to AUTOMATED_ACCEPTED on a positive provider response', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(invitation());
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    const reserved = invitation({
      status: 'INVITATION_SENT',
      deliveryMethod: 'AUTOMATED_EMAIL',
      deliveryState: 'AUTOMATED_UNCONFIRMED',
      sendOperationId: idempotencyKey,
      destinationEmail: 'client@example.test',
    });
    repositoryMocks.recordSendReservation.mockResolvedValue(reserved);
    adapterMocks.sendInvitationEmail.mockResolvedValue({
      outcome: 'accepted',
      messageId: 'msg_123',
    });
    const resolved = invitation({
      ...reserved,
      deliveryState: 'AUTOMATED_ACCEPTED',
      providerMessageId: 'msg_123',
    });
    repositoryMocks.recordAutomatedSendOutcome.mockResolvedValue(resolved);

    const result = await sendInvitation(ADMIN, CLIENT_ID, {
      deliveryMethod: 'AUTOMATED_EMAIL',
      idempotencyKey,
    });

    expect(repositoryMocks.recordSendReservation).toHaveBeenCalledWith(
      TX_CLIENT,
      'invitation-1',
      expect.objectContaining({ automated: { sendOperationId: idempotencyKey } }),
    );
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ action: 'PORTAL_INVITATION_SENT_AUTOMATED' }),
    );
    expect(adapterMocks.sendInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'client@example.test', sendOperationId: idempotencyKey }),
      { idempotencyKey: `portal-invitation/${idempotencyKey}` },
    );
    expect(repositoryMocks.recordAutomatedSendOutcome).toHaveBeenCalledWith(
      expect.anything(),
      'invitation-1',
      idempotencyKey,
      { deliveryState: 'AUTOMATED_ACCEPTED', providerMessageId: 'msg_123' },
    );
    expect(result).toEqual({ invitation: resolved, delivery: 'AUTOMATED_ACCEPTED' });
  });

  it('never marks an ambiguous provider outcome as failed, and leaves the row AUTOMATED_UNCONFIRMED', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(invitation());
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    const reserved = invitation({
      status: 'INVITATION_SENT',
      deliveryMethod: 'AUTOMATED_EMAIL',
      deliveryState: 'AUTOMATED_UNCONFIRMED',
      sendOperationId: idempotencyKey,
    });
    repositoryMocks.recordSendReservation.mockResolvedValue(reserved);
    adapterMocks.sendInvitationEmail.mockResolvedValue({
      outcome: 'ambiguous',
      message: 'timeout',
    });

    const result = await sendInvitation(ADMIN, CLIENT_ID, {
      deliveryMethod: 'AUTOMATED_EMAIL',
      idempotencyKey,
    });

    expect(repositoryMocks.recordAutomatedSendOutcome).not.toHaveBeenCalled();
    expect(result).toEqual({ invitation: reserved, delivery: 'unconfirmed' });
  });

  it('classifies a definite provider error as PROVIDER_FAILED', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(invitation());
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    const reserved = invitation({
      status: 'INVITATION_SENT',
      deliveryMethod: 'AUTOMATED_EMAIL',
      deliveryState: 'AUTOMATED_UNCONFIRMED',
      sendOperationId: idempotencyKey,
    });
    repositoryMocks.recordSendReservation.mockResolvedValue(reserved);
    adapterMocks.sendInvitationEmail.mockResolvedValue({
      outcome: 'definite-failure',
      message: 'invalid_from_address',
    });
    const failed = invitation({ ...reserved, deliveryState: 'PROVIDER_FAILED' });
    repositoryMocks.recordAutomatedSendOutcome.mockResolvedValue(failed);

    const result = await sendInvitation(ADMIN, CLIENT_ID, {
      deliveryMethod: 'AUTOMATED_EMAIL',
      idempotencyKey,
    });

    expect(repositoryMocks.recordAutomatedSendOutcome).toHaveBeenCalledWith(
      expect.anything(),
      'invitation-1',
      idempotencyKey,
      { deliveryState: 'PROVIDER_FAILED', providerMessageId: null },
    );
    expect(result.delivery).toBe('PROVIDER_FAILED');
  });

  it('never re-derives or re-sends email content on a cross-request retry of an already-reserved automated operation', async () => {
    const alreadyReserved = invitation({
      status: 'INVITATION_SENT',
      deliveryMethod: 'AUTOMATED_EMAIL',
      deliveryState: 'AUTOMATED_UNCONFIRMED',
      sendOperationId: idempotencyKey,
    });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(alreadyReserved);

    const result = await sendInvitation(ADMIN, CLIENT_ID, {
      deliveryMethod: 'AUTOMATED_EMAIL',
      idempotencyKey,
    });

    expect(adapterMocks.sendInvitationEmail).not.toHaveBeenCalled();
    expect(repositoryMocks.recordSendReservation).not.toHaveBeenCalled();
    expect(result).toEqual({ invitation: alreadyReserved, delivery: 'already-reserved' });
  });

  it('rejects sending from any status other than INVITATION_PREPARED', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );

    await expect(
      sendInvitation(ADMIN, CLIENT_ID, { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey }),
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_SENDABLE' });
  });
});

describe('resendInvitation', () => {
  const idempotencyKey = '22222222-2222-2222-2222-222222222222';

  function concurrencyFor(inv: InvitationRecord) {
    return {
      expectedCurrentSendOperationId: inv.sendOperationId,
      expectedUpdatedAt: inv.updatedAt,
    };
  }

  it('rejects resending an invitation that was never sent', async () => {
    const current = invitation({ status: 'INVITATION_PREPARED' });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(current);

    await expect(
      resendInvitation(
        ADMIN,
        CLIENT_ID,
        { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey },
        concurrencyFor(current),
      ),
    ).rejects.toMatchObject({ code: 'INVITATION_NOT_SENDABLE' });
  });

  it('rotates the token and writes a RESENT audit entry from INVITATION_EXPIRED', async () => {
    const current = invitation({ status: 'INVITATION_EXPIRED' });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(current);
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    const reserved = invitation({ status: 'INVITATION_SENT' });
    repositoryMocks.recordSendReservationIfUnstale.mockResolvedValue(reserved);

    await resendInvitation(
      ADMIN,
      CLIENT_ID,
      { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey },
      concurrencyFor(current),
    );

    expect(repositoryMocks.recordSendReservationIfUnstale).toHaveBeenCalledWith(
      TX_CLIENT,
      'invitation-1',
      { sendOperationId: current.sendOperationId, updatedAt: current.updatedAt },
      expect.anything(),
    );
    // The plain, unconditional writer is never used for a concurrency-
    // checked resend — only the atomic conditional variant.
    expect(repositoryMocks.recordSendReservation).not.toHaveBeenCalled();
  });

  it('writes PORTAL_INVITATION_RESENT (not SENT_AUTOMATED) for an automated reissue', async () => {
    const current = invitation({ status: 'INVITATION_OPENED' });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(current);
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    repositoryMocks.recordSendReservationIfUnstale.mockResolvedValue(
      invitation({
        status: 'INVITATION_SENT',
        deliveryMethod: 'AUTOMATED_EMAIL',
        deliveryState: 'AUTOMATED_UNCONFIRMED',
      }),
    );
    adapterMocks.sendInvitationEmail.mockResolvedValue({
      outcome: 'accepted',
      messageId: 'msg_456',
    });
    repositoryMocks.recordAutomatedSendOutcome.mockResolvedValue(invitation());

    await resendInvitation(
      ADMIN,
      CLIENT_ID,
      { deliveryMethod: 'AUTOMATED_EMAIL', idempotencyKey },
      concurrencyFor(current),
    );

    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ action: 'PORTAL_INVITATION_RESENT' }),
    );
  });

  it('returns the raw manual URL on a fresh manual reissue', async () => {
    const current = invitation({ status: 'INVITATION_SENT' });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(current);
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    repositoryMocks.recordSendReservationIfUnstale.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );

    const result = await resendInvitation(
      ADMIN,
      CLIENT_ID,
      { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey },
      concurrencyFor(current),
    );

    expect(result.manualInvitationUrl).toBe('http://localhost:3000/activate/mock-token');
  });

  it(
    'proves the stale-resend race: resend A succeeds, resend B succeeds and becomes current, ' +
      'a delayed retry of A (still carrying A-era precondition values) is rejected without ' +
      'rotating the token or calling the provider again',
    async () => {
      // Resend A's caller read the invitation in its INVITATION_SENT state
      // (never-yet-resent) and is about to submit with that stale
      // precondition — but by the time A's request reaches the service,
      // B has already run and changed sendOperationId/updatedAt.
      const staleAsOfA = invitation({
        status: 'INVITATION_SENT',
        sendOperationId: null,
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const currentAfterB = invitation({
        status: 'INVITATION_SENT',
        deliveryMethod: 'AUTOMATED_EMAIL',
        deliveryState: 'AUTOMATED_UNCONFIRMED',
        sendOperationId: 'operation-B',
        updatedAt: new Date('2026-01-01T00:05:00Z'),
      });
      // The service's own read (inside the transaction) sees B's current
      // state, not what A's caller last observed.
      repositoryMocks.findInvitationByClientId.mockResolvedValue(currentAfterB);

      await expect(
        resendInvitation(
          ADMIN,
          CLIENT_ID,
          { deliveryMethod: 'AUTOMATED_EMAIL', idempotencyKey: 'operation-A-retry' },
          concurrencyFor(staleAsOfA),
        ),
      ).rejects.toMatchObject({ code: 'INVITATION_SEND_OPERATION_STALE' });

      expect(repositoryMocks.recordSendReservationIfUnstale).not.toHaveBeenCalled();
      expect(repositoryMocks.recordSendReservation).not.toHaveBeenCalled();
      expect(adapterMocks.sendInvitationEmail).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    },
  );

  it('rejects with INVITATION_SEND_OPERATION_STALE when the atomic conditional write itself finds no matching row (narrow race window)', async () => {
    const current = invitation({ status: 'INVITATION_SENT' });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(current);
    repositoryMocks.findClientEmailById.mockResolvedValue({ email: 'client@example.test' });
    // The up-front comparison passed (matches `current`), but the atomic
    // write's own WHERE clause found nothing — e.g. a concurrent
    // serializable transaction committed between the read and this write.
    repositoryMocks.recordSendReservationIfUnstale.mockResolvedValue(null);

    await expect(
      resendInvitation(
        ADMIN,
        CLIENT_ID,
        { deliveryMethod: 'MANUAL_EMAIL', idempotencyKey },
        concurrencyFor(current),
      ),
    ).rejects.toMatchObject({ code: 'INVITATION_SEND_OPERATION_STALE' });
  });

  it('returns the current result idempotently when the idempotency key already equals the current sendOperationId, never consulting the precondition', async () => {
    const alreadyReserved = invitation({
      status: 'INVITATION_SENT',
      deliveryMethod: 'AUTOMATED_EMAIL',
      deliveryState: 'AUTOMATED_UNCONFIRMED',
      sendOperationId: idempotencyKey,
    });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(alreadyReserved);

    const result = await resendInvitation(
      ADMIN,
      CLIENT_ID,
      { deliveryMethod: 'AUTOMATED_EMAIL', idempotencyKey },
      // Deliberately wrong/stale precondition values — must be irrelevant
      // once the idempotency key itself already matches.
      { expectedCurrentSendOperationId: 'something-else', expectedUpdatedAt: new Date(0) },
    );

    expect(result).toEqual({ invitation: alreadyReserved, delivery: 'already-reserved' });
    expect(repositoryMocks.recordSendReservationIfUnstale).not.toHaveBeenCalled();
  });
});

describe('confirmManualSend', () => {
  const idempotencyKey = '33333333-3333-3333-3333-333333333333';

  it('is an idempotent no-op when already MANUALLY_CONFIRMED, regardless of which key the retry supplies', async () => {
    const existing = invitation({
      deliveryState: 'MANUALLY_CONFIRMED',
      deliveryMethod: 'MANUAL_EMAIL',
    });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(existing);

    const result = await confirmManualSend(ADMIN, CLIENT_ID, idempotencyKey);

    expect(result).toEqual(existing);
    expect(repositoryMocks.recordManualConfirmation).not.toHaveBeenCalled();
  });

  it('rejects confirming an invitation that was never sent', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(
      invitation({ status: 'INVITATION_PREPARED' }),
    );

    await expect(confirmManualSend(ADMIN, CLIENT_ID, idempotencyKey)).rejects.toMatchObject({
      code: 'INVITATION_NOT_SENDABLE',
    });
  });

  it('rejects confirming an invitation already recorded as an automated send', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(
      invitation({
        status: 'INVITATION_SENT',
        deliveryMethod: 'AUTOMATED_EMAIL',
        deliveryState: 'AUTOMATED_UNCONFIRMED',
      }),
    );

    await expect(confirmManualSend(ADMIN, CLIENT_ID, idempotencyKey)).rejects.toMatchObject({
      code: 'INVITATION_NOT_SENDABLE',
    });
  });

  it('records confirmation evidence attributed to the confirming actor, storing the validated idempotency key as sendOperationId', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );
    const confirmed = invitation({
      status: 'INVITATION_SENT',
      deliveryMethod: 'MANUAL_EMAIL',
      deliveryState: 'MANUALLY_CONFIRMED',
      deliveryConfirmedByStaffId: ADMIN.id,
      sendOperationId: idempotencyKey,
    });
    repositoryMocks.recordManualConfirmation.mockResolvedValue(confirmed);

    const result = await confirmManualSend(ADMIN, CLIENT_ID, idempotencyKey);

    expect(result).toEqual(confirmed);
    expect(repositoryMocks.recordManualConfirmation).toHaveBeenCalledWith(
      TX_CLIENT,
      'invitation-1',
      expect.objectContaining({
        deliveryConfirmedByStaffId: ADMIN.id,
        sendOperationId: idempotencyKey,
      }),
    );
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ action: 'PORTAL_INVITATION_SENT_MANUAL_CONFIRMED' }),
    );
  });
});

describe('revokeInvitation', () => {
  it('is an idempotent no-op when already revoked', async () => {
    const existing = invitation({ status: 'INVITATION_REVOKED' });
    repositoryMocks.findInvitationByClientId.mockResolvedValue(existing);

    const result = await revokeInvitation(ADMIN, CLIENT_ID, 'client requested cancellation');

    expect(result).toEqual(existing);
    expect(repositoryMocks.recordRevocation).not.toHaveBeenCalled();
  });

  it('rejects revoking an already-activated invitation', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(
      invitation({ status: 'ACCOUNT_ACTIVATED' }),
    );

    await expect(revokeInvitation(ADMIN, CLIENT_ID, 'reason')).rejects.toMatchObject({
      code: 'INVITATION_ALREADY_ACTIVATED',
    });
  });

  it('revokes and records the reason in the audit afterState', async () => {
    repositoryMocks.findInvitationByClientId.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );
    const revoked = invitation({ status: 'INVITATION_REVOKED' });
    repositoryMocks.recordRevocation.mockResolvedValue(revoked);

    await revokeInvitation(ADMIN, CLIENT_ID, 'client requested cancellation');

    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        action: 'PORTAL_INVITATION_REVOKED',
        afterState: expect.objectContaining({ reason: 'client requested cancellation' }),
      }),
    );
  });
});

describe('handleResendWebhookEvent', () => {
  const headers = { id: 'msg-id', timestamp: '123', signature: 'v1,sig' };

  it('rejects an invalid signature without processing anything', async () => {
    adapterMocks.verifyResendWebhook.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    const result = await handleResendWebhookEvent('{}', headers);

    expect(result).toEqual({ status: 401 });
    expect(repositoryMocks.findInvitationByProviderMessageId).not.toHaveBeenCalled();
  });

  it('reconciles AUTOMATED_UNCONFIRMED to AUTOMATED_ACCEPTED on email.sent, correlated by providerMessageId', async () => {
    adapterMocks.verifyResendWebhook.mockReturnValue({
      type: 'email.sent',
      data: { email_id: 'msg_1' },
    });
    repositoryMocks.findInvitationByProviderMessageId.mockResolvedValue(
      invitation({ id: 'row-1' }),
    );

    const result = await handleResendWebhookEvent('{}', headers);

    expect(result).toEqual({ status: 200 });
    expect(repositoryMocks.reconcileUnconfirmedToAccepted).toHaveBeenCalledWith(
      TX_CLIENT,
      'row-1',
      'msg_1',
    );
  });

  it('falls back to the signed sendOperationId tag when providerMessageId has no match', async () => {
    adapterMocks.verifyResendWebhook.mockReturnValue({
      type: 'email.delivery_delayed',
      data: { email_id: 'msg_2', tags: { sendOperationId: 'op-1' } },
    });
    repositoryMocks.findInvitationByProviderMessageId.mockResolvedValue(null);
    repositoryMocks.findInvitationBySendOperationId.mockResolvedValue(
      invitation({ id: 'row-2', providerMessageId: null }),
    );

    await handleResendWebhookEvent('{}', headers);

    expect(repositoryMocks.findInvitationBySendOperationId).toHaveBeenCalledWith(TX_CLIENT, 'op-1');
    expect(repositoryMocks.reconcileUnconfirmedToAccepted).toHaveBeenCalledWith(
      TX_CLIENT,
      'row-2',
      'msg_2',
    );
  });

  it('rejects an ambiguous correlation without mutating anything when the messageId lookup fails but the fallback row disagrees', async () => {
    adapterMocks.verifyResendWebhook.mockReturnValue({
      type: 'email.delivered',
      data: { email_id: 'msg_3', tags: { sendOperationId: 'op-2' } },
    });
    repositoryMocks.findInvitationByProviderMessageId.mockResolvedValue(null);
    repositoryMocks.findInvitationBySendOperationId.mockResolvedValue(
      invitation({ id: 'row-3', providerMessageId: 'msg_DIFFERENT' }),
    );

    const result = await handleResendWebhookEvent('{}', headers);

    expect(result).toEqual({ status: 200 });
    expect(repositoryMocks.applyProviderDeliveryState).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous correlation without mutating anything when providerMessageId and the sendOperationId tag BOTH independently resolve, but to different rows', async () => {
    adapterMocks.verifyResendWebhook.mockReturnValue({
      type: 'email.delivered',
      data: { email_id: 'msg_A', tags: { sendOperationId: 'op-B' } },
    });
    // Both lookups succeed on their own — this is the case the earlier,
    // fallback-only correlation design could never detect (it never even
    // attempted the tag lookup once the messageId lookup had already
    // succeeded).
    repositoryMocks.findInvitationByProviderMessageId.mockResolvedValue(
      invitation({ id: 'row-A' }),
    );
    repositoryMocks.findInvitationBySendOperationId.mockResolvedValue(invitation({ id: 'row-B' }));

    const result = await handleResendWebhookEvent('{}', headers);

    expect(result).toEqual({ status: 200 });
    expect(repositoryMocks.applyProviderDeliveryState).not.toHaveBeenCalled();
    expect(repositoryMocks.reconcileUnconfirmedToAccepted).not.toHaveBeenCalled();
  });

  it('never mutates the current resend when a late event belongs to an older, superseded sendOperationId (neither the message id nor the tag correlates to any row after a resend rotated/cleared them)', async () => {
    adapterMocks.verifyResendWebhook.mockReturnValue({
      type: 'email.delivered',
      // The original automated attempt's providerMessageId and
      // sendOperationId — both have since been cleared/rotated by a
      // resend (repository.recordSendReservation/IfUnstale always clears
      // providerMessageId to null, and rotates sendOperationId, on every
      // fresh reservation).
      data: { email_id: 'msg_stale', tags: { sendOperationId: 'operation-stale' } },
    });
    repositoryMocks.findInvitationByProviderMessageId.mockResolvedValue(null);
    repositoryMocks.findInvitationBySendOperationId.mockResolvedValue(null);

    const result = await handleResendWebhookEvent('{}', headers);

    expect(result).toEqual({ status: 200 });
    expect(repositoryMocks.applyProviderDeliveryState).not.toHaveBeenCalled();
    expect(repositoryMocks.reconcileUnconfirmedToAccepted).not.toHaveBeenCalled();
  });

  it('runs correlation and mutation inside the same serializable transaction (racing resend/revoke must be transactionally rechecked)', async () => {
    adapterMocks.verifyResendWebhook.mockReturnValue({
      type: 'email.delivered',
      data: { email_id: 'msg_race' },
    });
    repositoryMocks.findInvitationByProviderMessageId.mockResolvedValue(
      invitation({ id: 'row-race' }),
    );

    await handleResendWebhookEvent('{}', headers);

    // transactionMock is the mocked `prisma.$transaction` that both
    // runSerializableWithRetry (resend/revoke) and this webhook handler
    // now share — asserting it was invoked, and that the correlation call
    // itself received TX_CLIENT (not the bare prisma singleton), proves
    // correlation and mutation share one transaction rather than two
    // independent, race-prone steps.
    expect(transactionMock).toHaveBeenCalled();
    expect(repositoryMocks.findInvitationByProviderMessageId).toHaveBeenCalledWith(
      TX_CLIENT,
      'msg_race',
    );
    expect(repositoryMocks.applyProviderDeliveryState).toHaveBeenCalledWith(
      TX_CLIENT,
      'row-race',
      'PROVIDER_DELIVERED',
      'msg_race',
    );
  });

  it.each([
    ['email.delivered', 'PROVIDER_DELIVERED'],
    ['email.bounced', 'PROVIDER_BOUNCED'],
    ['email.complained', 'PROVIDER_COMPLAINED'],
    ['email.failed', 'PROVIDER_FAILED'],
    ['email.suppressed', 'PROVIDER_SUPPRESSED'],
  ])('maps %s to %s', async (type, expectedState) => {
    adapterMocks.verifyResendWebhook.mockReturnValue({ type, data: { email_id: 'msg_4' } });
    repositoryMocks.findInvitationByProviderMessageId.mockResolvedValue(
      invitation({ id: 'row-4' }),
    );

    await handleResendWebhookEvent('{}', headers);

    expect(repositoryMocks.applyProviderDeliveryState).toHaveBeenCalledWith(
      TX_CLIENT,
      'row-4',
      expectedState,
      'msg_4',
    );
  });

  it('never mutates on a terminal-state event with no email_id (providerMessageId is required by the schema for every terminal state but PROVIDER_FAILED)', async () => {
    adapterMocks.verifyResendWebhook.mockReturnValue({
      type: 'email.delivered',
      data: { tags: { sendOperationId: 'op-x' } },
    });

    const result = await handleResendWebhookEvent('{}', headers);

    expect(result).toEqual({ status: 200 });
    expect(repositoryMocks.applyProviderDeliveryState).not.toHaveBeenCalled();
    expect(repositoryMocks.findInvitationByProviderMessageId).not.toHaveBeenCalled();
    expect(repositoryMocks.findInvitationBySendOperationId).not.toHaveBeenCalled();
  });

  it.each(['email.opened', 'email.clicked', 'email.received', 'email.scheduled'])(
    'acknowledges %s with no lifecycle mutation',
    async (type) => {
      adapterMocks.verifyResendWebhook.mockReturnValue({ type, data: { email_id: 'msg_5' } });

      const result = await handleResendWebhookEvent('{}', headers);

      expect(result).toEqual({ status: 200 });
      expect(repositoryMocks.reconcileUnconfirmedToAccepted).not.toHaveBeenCalled();
      expect(repositoryMocks.applyProviderDeliveryState).not.toHaveBeenCalled();
      expect(repositoryMocks.findInvitationByProviderMessageId).not.toHaveBeenCalled();
    },
  );
});
