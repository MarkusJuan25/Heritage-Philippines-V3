import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db`, which eagerly opens a real
// database adapter at import time — mock it before `./service` is
// imported, mirroring features/invitations/service.test.ts exactly.
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: transactionMock } }));

const repositoryMocks = vi.hoisted(() => ({
  findUserByEmail: vi.fn(),
  findClientProfileByClientId: vi.fn(),
  findClientNameById: vi.fn(),
  createActivatedAccount: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

const invitationRepositoryMocks = vi.hoisted(() => ({
  findInvitationByTokenHash: vi.fn(),
  markInvitationOpened: vi.fn(),
  markInvitationActivated: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('@/features/invitations/repository', () => invitationRepositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import type { InvitationRecord } from '@/features/invitations/repository';

import { activateAccount, computeEmailVerified, continueInvitation } from './service';
import { ActivationError } from './errors';

const TX_CLIENT = { marker: 'tx-client' };
const RAW_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1L2';
const NOW = new Date('2026-08-28T00:00:00.000Z');
const FUTURE = new Date('2026-09-01T00:00:00.000Z');
const PAST = new Date('2026-08-01T00:00:00.000Z');

function invitation(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  return {
    id: 'invitation-1',
    clientId: 'client-1',
    status: 'INVITATION_SENT',
    tokenHash: 'some-hash',
    expiresAt: FUTURE,
    destinationEmail: 'client@example.test',
    deliveryMethod: 'AUTOMATED_EMAIL',
    deliveryState: 'AUTOMATED_ACCEPTED',
    sendOperationId: 'send-op-1',
    providerMessageId: 'provider-msg-1',
    deliveryConfirmedAt: null,
    deliveryConfirmedByStaffId: null,
    sentAt: new Date('2026-08-20T00:00:00Z'),
    openedAt: null,
    activatedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('computeEmailVerified', () => {
  it.each([
    ['AUTOMATED_EMAIL', 'AUTOMATED_ACCEPTED', true],
    ['AUTOMATED_EMAIL', 'PROVIDER_DELIVERED', true],
    ['AUTOMATED_EMAIL', 'AUTOMATED_UNCONFIRMED', false],
    ['AUTOMATED_EMAIL', 'PROVIDER_FAILED', false],
    ['AUTOMATED_EMAIL', 'PROVIDER_BOUNCED', false],
    ['AUTOMATED_EMAIL', 'PROVIDER_COMPLAINED', false],
    ['AUTOMATED_EMAIL', 'PROVIDER_SUPPRESSED', false],
    ['MANUAL_EMAIL', 'MANUALLY_CONFIRMED', true],
    ['MANUAL_EMAIL', 'NOT_ATTEMPTED', false],
    [null, 'NOT_ATTEMPTED', false],
  ] as const)('deliveryMethod=%s deliveryState=%s -> %s', (method, state, expected) => {
    expect(computeEmailVerified(method, state)).toBe(expected);
  });
});

describe('continueInvitation', () => {
  it('transitions SENT -> OPENED and records exactly one ANONYMOUS audit row', async () => {
    const current = invitation({ status: 'INVITATION_SENT' });
    const updated = invitation({ status: 'INVITATION_OPENED', openedAt: NOW });
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(current);
    invitationRepositoryMocks.markInvitationOpened.mockResolvedValue(updated);

    const result = await continueInvitation(RAW_TOKEN);

    expect(result).toEqual({ opened: true });
    expect(invitationRepositoryMocks.markInvitationOpened).toHaveBeenCalledWith(
      TX_CLIENT,
      current.id,
      NOW,
    );
    expect(invitationRepositoryMocks.insertAuditLog).toHaveBeenCalledTimes(1);
    expect(invitationRepositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        actorKind: 'ANONYMOUS',
        action: 'PORTAL_INVITATION_OPENED',
        entityType: 'PortalInvitation',
        entityId: updated.id,
      }),
    );
    const auditCallArg = invitationRepositoryMocks.insertAuditLog.mock.calls[0]![1];
    expect(auditCallArg).not.toHaveProperty('actorId');
  });

  it('is an idempotent no-op when already INVITATION_OPENED — no update, no audit row', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_OPENED' }),
    );

    const result = await continueInvitation(RAW_TOKEN);

    expect(result).toEqual({ opened: true });
    expect(invitationRepositoryMocks.markInvitationOpened).not.toHaveBeenCalled();
    expect(invitationRepositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('rejects when no invitation matches the token', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(null);
    await expect(continueInvitation(RAW_TOKEN)).rejects.toBeInstanceOf(ActivationError);
    expect(invitationRepositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    'INVITATION_PREPARED',
    'INVITATION_EXPIRED',
    'INVITATION_REVOKED',
    'ACCOUNT_ACTIVATED',
  ] as const)('rejects %s with no audit row', async (status) => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(invitation({ status }));
    await expect(continueInvitation(RAW_TOKEN)).rejects.toBeInstanceOf(ActivationError);
    expect(invitationRepositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('rejects an effectively-expired SENT invitation', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT', expiresAt: PAST }),
    );
    await expect(continueInvitation(RAW_TOKEN)).rejects.toBeInstanceOf(ActivationError);
  });

  it('rejects (defensively) if markInvitationOpened unexpectedly matches no row', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );
    invitationRepositoryMocks.markInvitationOpened.mockResolvedValue(null);
    await expect(continueInvitation(RAW_TOKEN)).rejects.toBeInstanceOf(ActivationError);
    expect(invitationRepositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });
});

describe('activateAccount', () => {
  const PASSWORD_HASH = 'hashed-password-value';

  beforeEach(() => {
    repositoryMocks.findUserByEmail.mockResolvedValue(null);
    repositoryMocks.findClientProfileByClientId.mockResolvedValue(null);
    repositoryMocks.findClientNameById.mockResolvedValue({ fullName: 'Juan Dela Cruz' });
    repositoryMocks.createActivatedAccount.mockResolvedValue({
      userId: 'new-user-1',
      clientProfileId: 'new-profile-1',
    });
    invitationRepositoryMocks.markInvitationActivated.mockResolvedValue(
      invitation({ status: 'ACCOUNT_ACTIVATED', activatedAt: NOW }),
    );
  });

  it('activates from INVITATION_SENT, creates the account with the frozen destination email, and audits USER/new-user-id', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT', destinationEmail: 'client@example.test' }),
    );

    const result = await activateAccount(RAW_TOKEN, PASSWORD_HASH);

    expect(result).toEqual({ activated: true });
    expect(repositoryMocks.createActivatedAccount).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        clientId: 'client-1',
        name: 'Juan Dela Cruz',
        email: 'client@example.test',
        passwordHash: PASSWORD_HASH,
        emailVerified: true, // AUTOMATED_EMAIL + AUTOMATED_ACCEPTED
      }),
    );
    expect(invitationRepositoryMocks.markInvitationActivated).toHaveBeenCalledWith(
      TX_CLIENT,
      'invitation-1',
      NOW,
    );
    expect(invitationRepositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        actorKind: 'USER',
        actorId: 'new-user-1',
        action: 'PORTAL_INVITATION_ACTIVATED',
      }),
    );
  });

  it('activates from INVITATION_OPENED too', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_OPENED' }),
    );
    await expect(activateAccount(RAW_TOKEN, PASSWORD_HASH)).resolves.toEqual({ activated: true });
  });

  it('computes emailVerified: false for a MANUAL_EMAIL send that was never confirmed', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({
        status: 'INVITATION_SENT',
        deliveryMethod: null,
        deliveryState: 'NOT_ATTEMPTED',
      }),
    );
    await activateAccount(RAW_TOKEN, PASSWORD_HASH);
    expect(repositoryMocks.createActivatedAccount).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ emailVerified: false }),
    );
  });

  it.each([
    'INVITATION_PREPARED',
    'INVITATION_EXPIRED',
    'INVITATION_REVOKED',
    'ACCOUNT_ACTIVATED',
  ] as const)('rejects %s with no account created', async (status) => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(invitation({ status }));
    await expect(activateAccount(RAW_TOKEN, PASSWORD_HASH)).rejects.toBeInstanceOf(ActivationError);
    expect(repositoryMocks.createActivatedAccount).not.toHaveBeenCalled();
  });

  it('rejects on an any-role existing User email collision, with no account created', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );
    repositoryMocks.findUserByEmail.mockResolvedValue({ id: 'existing-user' });

    await expect(activateAccount(RAW_TOKEN, PASSWORD_HASH)).rejects.toBeInstanceOf(ActivationError);
    expect(repositoryMocks.createActivatedAccount).not.toHaveBeenCalled();
  });

  it('rejects on an existing ClientProfile for the same Client, with no account created', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );
    repositoryMocks.findClientProfileByClientId.mockResolvedValue({ id: 'existing-profile' });

    await expect(activateAccount(RAW_TOKEN, PASSWORD_HASH)).rejects.toBeInstanceOf(ActivationError);
    expect(repositoryMocks.createActivatedAccount).not.toHaveBeenCalled();
  });

  it('translates a P2002 unique-constraint violation at insert time into the generic ActivationError', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );
    repositoryMocks.createActivatedAccount.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(activateAccount(RAW_TOKEN, PASSWORD_HASH)).rejects.toBeInstanceOf(ActivationError);
  });

  it('never signs the resulting response with any identity, invitation, token, or password field', async () => {
    invitationRepositoryMocks.findInvitationByTokenHash.mockResolvedValue(
      invitation({ status: 'INVITATION_SENT' }),
    );
    const result = await activateAccount(RAW_TOKEN, PASSWORD_HASH);
    expect(result).toEqual({ activated: true });
    expect(Object.keys(result)).toEqual(['activated']);
  });
});
