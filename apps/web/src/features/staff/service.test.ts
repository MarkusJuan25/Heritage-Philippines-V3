import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db`, which — like `./auth` in
// guards.test.ts — eagerly validates env vars and opens a real database
// adapter at import time. Mock it before `./service` is imported.
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: transactionMock } }));

const { hashPasswordMock, generateRandomStringMock } = vi.hoisted(() => ({
  hashPasswordMock: vi.fn(async (password: string) => `hashed:${password}`),
  generateRandomStringMock: vi.fn(() => 'generated-random-password'),
}));
vi.mock('better-auth/crypto', () => ({
  hashPassword: hashPasswordMock,
  generateRandomString: generateRandomStringMock,
}));

const repositoryMocks = vi.hoisted(() => ({
  findUserByEmail: vi.fn(),
  findStaffById: vi.fn(),
  countActiveSystemAdministrators: vi.fn(),
  createStaffUser: vi.fn(),
  updateUserRole: vi.fn(),
  setUserActive: vi.fn(),
  deleteSessionsForUser: vi.fn(),
  insertAuditLog: vi.fn(),
  listStaffAccounts: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import type { StaffAccountRecord } from './repository';
import {
  changeStaffRole,
  createStaffAccount,
  deactivateStaffAccount,
  getStaffAccountById,
  listStaffAccounts,
  reactivateStaffAccount,
} from './service';

const TX_CLIENT = { marker: 'tx-client' };

const ACTOR: AuthenticatedUser = {
  id: 'actor-id',
  email: 'actor@example.test',
  name: 'Actor Admin',
  role: 'SYSTEM_ADMINISTRATOR',
};

function staffRecord(overrides: Partial<StaffAccountRecord> = {}): StaffAccountRecord {
  return {
    id: 'target-id',
    name: 'Target Person',
    email: 'target@example.test',
    role: 'TRAVEL_CONSULTANT',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    staffProfile: null,
    ...overrides,
  };
}

function serializationConflictError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction.',
    { code: 'P2034', clientVersion: '7.8.0' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: run the callback against a fixed fake tx client, ignoring
  // any transaction options (isolationLevel etc.) — individual tests
  // override this to simulate serialization conflicts.
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
});

describe('getStaffAccountById', () => {
  it('returns the record when found', async () => {
    const record = staffRecord();
    repositoryMocks.findStaffById.mockResolvedValue(record);

    await expect(getStaffAccountById('target-id')).resolves.toEqual(record);
    expect(repositoryMocks.findStaffById).toHaveBeenCalledWith(prisma, 'target-id');
  });

  it('throws STAFF_ACCOUNT_NOT_FOUND when absent', async () => {
    repositoryMocks.findStaffById.mockResolvedValue(null);

    await expect(getStaffAccountById('missing-id')).rejects.toMatchObject({
      code: 'STAFF_ACCOUNT_NOT_FOUND',
      status: 404,
    });
  });
});

describe('listStaffAccounts', () => {
  it('computes skip from page/pageSize and wraps the repository result with pagination metadata', async () => {
    const items = [staffRecord()];
    repositoryMocks.listStaffAccounts.mockResolvedValue({ items, total: 41 });

    const result = await listStaffAccounts({ page: 3, pageSize: 10 });

    expect(repositoryMocks.listStaffAccounts).toHaveBeenCalledWith(prisma, {
      role: undefined,
      isActive: undefined,
      search: undefined,
      skip: 20,
      take: 10,
    });
    expect(result).toEqual({ items, page: 3, pageSize: 10, total: 41 });
  });
});

describe('createStaffAccount', () => {
  it('rejects when the email already exists, without hashing a password or opening a transaction', async () => {
    repositoryMocks.findUserByEmail.mockResolvedValue({ id: 'existing-id' });

    await expect(
      createStaffAccount(ACTOR, {
        name: 'New Person',
        email: 'taken@example.test',
        role: 'TRAVEL_CONSULTANT',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_EXISTS', status: 409 });

    expect(hashPasswordMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('generates a random password when none is supplied, hashes it, and returns the plaintext exactly once', async () => {
    repositoryMocks.findUserByEmail.mockResolvedValue(null);
    const created = staffRecord({ id: 'new-id', role: 'FINANCE_ACCOUNTING' });
    repositoryMocks.createStaffUser.mockResolvedValue(created);

    const result = await createStaffAccount(ACTOR, {
      name: 'New Person',
      email: 'new@example.test',
      role: 'FINANCE_ACCOUNTING',
    });

    expect(generateRandomStringMock).toHaveBeenCalledWith(24, 'a-z', 'A-Z', '0-9', '-_');
    expect(hashPasswordMock).toHaveBeenCalledWith('generated-random-password');
    expect(repositoryMocks.createStaffUser).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      name: 'New Person',
      email: 'new@example.test',
      role: 'FINANCE_ACCOUNTING',
      passwordHash: 'hashed:generated-random-password',
      title: undefined,
      phone: undefined,
    });
    expect(result).toEqual({ account: created, initialPassword: 'generated-random-password' });
  });

  it('hashes a caller-supplied password instead of generating one', async () => {
    repositoryMocks.findUserByEmail.mockResolvedValue(null);
    repositoryMocks.createStaffUser.mockResolvedValue(staffRecord());

    const result = await createStaffAccount(ACTOR, {
      name: 'New Person',
      email: 'new@example.test',
      role: 'FINANCE_ACCOUNTING',
      password: 'a-caller-supplied-password',
    });

    expect(generateRandomStringMock).not.toHaveBeenCalled();
    expect(hashPasswordMock).toHaveBeenCalledWith('a-caller-supplied-password');
    expect(result.initialPassword).toBe('a-caller-supplied-password');
  });

  it('writes an AuditLog entry sanitized to id/name/email/role/isActive, even if the created record carries extra fields', async () => {
    repositoryMocks.findUserByEmail.mockResolvedValue(null);
    const createdWithExtraFields = {
      ...staffRecord({ id: 'new-id' }),
      // Simulates an accidentally widened repository select.
      password: 'must-never-appear-in-audit-log',
    };
    repositoryMocks.createStaffUser.mockResolvedValue(createdWithExtraFields);

    await createStaffAccount(ACTOR, {
      name: 'New Person',
      email: 'new@example.test',
      role: 'FINANCE_ACCOUNTING',
    });

    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'STAFF_ACCOUNT_CREATED',
      entityType: 'User',
      entityId: 'new-id',
      afterState: {
        id: 'new-id',
        name: createdWithExtraFields.name,
        email: createdWithExtraFields.email,
        role: createdWithExtraFields.role,
        isActive: createdWithExtraFields.isActive,
      },
    });
    const auditCallArgs = repositoryMocks.insertAuditLog.mock.calls[0]?.[1];
    expect(JSON.stringify(auditCallArgs)).not.toContain('must-never-appear-in-audit-log');
  });
});

describe('changeStaffRole', () => {
  it('rejects a self-action without opening a transaction', async () => {
    await expect(changeStaffRole(ACTOR, ACTOR.id, 'ADMIN_MANAGER')).rejects.toMatchObject({
      code: 'SELF_ACTION_FORBIDDEN',
      status: 403,
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('throws STAFF_ACCOUNT_NOT_FOUND when the target does not exist', async () => {
    repositoryMocks.findStaffById.mockResolvedValue(null);

    await expect(changeStaffRole(ACTOR, 'missing-id', 'ADMIN_MANAGER')).rejects.toMatchObject({
      code: 'STAFF_ACCOUNT_NOT_FOUND',
    });
  });

  it('is idempotent: assigning the same role is a no-op with no session revocation or audit entry', async () => {
    const target = staffRecord({ role: 'FINANCE_ACCOUNTING' });
    repositoryMocks.findStaffById.mockResolvedValue(target);

    const result = await changeStaffRole(ACTOR, target.id, 'FINANCE_ACCOUNTING');

    expect(result).toEqual(target);
    expect(repositoryMocks.updateUserRole).not.toHaveBeenCalled();
    expect(repositoryMocks.deleteSessionsForUser).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('does not check the administrator count when the target is not currently SYSTEM_ADMINISTRATOR', async () => {
    const target = staffRecord({ role: 'TRAVEL_CONSULTANT' });
    repositoryMocks.findStaffById.mockResolvedValue(target);
    repositoryMocks.updateUserRole.mockResolvedValue({ ...target, role: 'FINANCE_ACCOUNTING' });

    await changeStaffRole(ACTOR, target.id, 'FINANCE_ACCOUNTING');

    expect(repositoryMocks.countActiveSystemAdministrators).not.toHaveBeenCalled();
  });

  it('rejects demoting the last active SYSTEM_ADMINISTRATOR', async () => {
    const target = staffRecord({ role: 'SYSTEM_ADMINISTRATOR' });
    repositoryMocks.findStaffById.mockResolvedValue(target);
    repositoryMocks.countActiveSystemAdministrators.mockResolvedValue(0);

    await expect(changeStaffRole(ACTOR, target.id, 'ADMIN_MANAGER')).rejects.toMatchObject({
      code: 'LAST_ADMINISTRATOR_PROTECTED',
      status: 409,
    });

    expect(repositoryMocks.countActiveSystemAdministrators).toHaveBeenCalledWith(
      TX_CLIENT,
      target.id,
    );
    expect(repositoryMocks.updateUserRole).not.toHaveBeenCalled();
  });

  it('allows demoting a SYSTEM_ADMINISTRATOR when another active one remains, revoking sessions and writing an audit entry', async () => {
    const target = staffRecord({ role: 'SYSTEM_ADMINISTRATOR' });
    repositoryMocks.findStaffById.mockResolvedValue(target);
    repositoryMocks.countActiveSystemAdministrators.mockResolvedValue(1);
    const updated = { ...target, role: 'ADMIN_MANAGER' as const };
    repositoryMocks.updateUserRole.mockResolvedValue(updated);

    const result = await changeStaffRole(ACTOR, target.id, 'ADMIN_MANAGER');

    expect(result).toEqual(updated);
    expect(repositoryMocks.updateUserRole).toHaveBeenCalledWith(
      TX_CLIENT,
      target.id,
      'ADMIN_MANAGER',
    );
    expect(repositoryMocks.deleteSessionsForUser).toHaveBeenCalledWith(TX_CLIENT, target.id);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'STAFF_ROLE_CHANGED',
      entityType: 'User',
      entityId: target.id,
      beforeState: { role: 'SYSTEM_ADMINISTRATOR' },
      afterState: { role: 'ADMIN_MANAGER' },
    });
  });

  it('retries once on a serialization conflict and succeeds on the second attempt', async () => {
    let attempt = 0;
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      attempt += 1;
      if (attempt === 1) {
        throw serializationConflictError();
      }
      return fn(TX_CLIENT);
    });

    const target = staffRecord({ role: 'TRAVEL_CONSULTANT' });
    repositoryMocks.findStaffById.mockResolvedValue(target);
    repositoryMocks.updateUserRole.mockResolvedValue({ ...target, role: 'FINANCE_ACCOUNTING' });

    await changeStaffRole(ACTOR, target.id, 'FINANCE_ACCOUNTING');

    expect(transactionMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries on repeated serialization conflicts', async () => {
    transactionMock.mockImplementation(async () => {
      throw serializationConflictError();
    });

    await expect(changeStaffRole(ACTOR, 'target-id', 'FINANCE_ACCOUNTING')).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(transactionMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a business-rule rejection (e.g. LAST_ADMINISTRATOR_PROTECTED)', async () => {
    const target = staffRecord({ role: 'SYSTEM_ADMINISTRATOR' });
    repositoryMocks.findStaffById.mockResolvedValue(target);
    repositoryMocks.countActiveSystemAdministrators.mockResolvedValue(0);

    await expect(changeStaffRole(ACTOR, target.id, 'ADMIN_MANAGER')).rejects.toMatchObject({
      code: 'LAST_ADMINISTRATOR_PROTECTED',
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});

describe('deactivateStaffAccount', () => {
  it('rejects a self-action', async () => {
    await expect(deactivateStaffAccount(ACTOR, ACTOR.id, 'testing')).rejects.toMatchObject({
      code: 'SELF_ACTION_FORBIDDEN',
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('is idempotent: deactivating an already-inactive account is a no-op', async () => {
    const target = staffRecord({ isActive: false });
    repositoryMocks.findStaffById.mockResolvedValue(target);

    const result = await deactivateStaffAccount(ACTOR, target.id, 'testing');

    expect(result).toEqual(target);
    expect(repositoryMocks.setUserActive).not.toHaveBeenCalled();
    expect(repositoryMocks.deleteSessionsForUser).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('rejects deactivating the last active SYSTEM_ADMINISTRATOR', async () => {
    const target = staffRecord({ role: 'SYSTEM_ADMINISTRATOR', isActive: true });
    repositoryMocks.findStaffById.mockResolvedValue(target);
    repositoryMocks.countActiveSystemAdministrators.mockResolvedValue(0);

    await expect(
      deactivateStaffAccount(ACTOR, target.id, 'Leaving the company'),
    ).rejects.toMatchObject({
      code: 'LAST_ADMINISTRATOR_PROTECTED',
    });
    expect(repositoryMocks.setUserActive).not.toHaveBeenCalled();
  });

  it('deactivates, revokes sessions, and writes an audit entry including the reason', async () => {
    const target = staffRecord({ role: 'TRAVEL_CONSULTANT', isActive: true });
    repositoryMocks.findStaffById.mockResolvedValue(target);
    repositoryMocks.setUserActive.mockResolvedValue({ ...target, isActive: false });

    const result = await deactivateStaffAccount(ACTOR, target.id, 'Leaving the company');

    expect(result.isActive).toBe(false);
    expect(repositoryMocks.setUserActive).toHaveBeenCalledWith(TX_CLIENT, target.id, false);
    expect(repositoryMocks.deleteSessionsForUser).toHaveBeenCalledWith(TX_CLIENT, target.id);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'STAFF_ACCOUNT_DEACTIVATED',
      entityType: 'User',
      entityId: target.id,
      beforeState: { isActive: true },
      afterState: { isActive: false, reason: 'Leaving the company' },
    });
  });
});

describe('reactivateStaffAccount', () => {
  it('rejects a self-action', async () => {
    await expect(reactivateStaffAccount(ACTOR, ACTOR.id)).rejects.toMatchObject({
      code: 'SELF_ACTION_FORBIDDEN',
    });
  });

  it('throws STAFF_ACCOUNT_NOT_FOUND when the target does not exist', async () => {
    repositoryMocks.findStaffById.mockResolvedValue(null);
    await expect(reactivateStaffAccount(ACTOR, 'missing-id')).rejects.toMatchObject({
      code: 'STAFF_ACCOUNT_NOT_FOUND',
    });
  });

  it('is idempotent: reactivating an already-active account is a no-op', async () => {
    const target = staffRecord({ isActive: true });
    repositoryMocks.findStaffById.mockResolvedValue(target);

    const result = await reactivateStaffAccount(ACTOR, target.id);

    expect(result).toEqual(target);
    expect(repositoryMocks.setUserActive).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('reactivates and writes an audit entry, without touching sessions', async () => {
    const target = staffRecord({ isActive: false });
    repositoryMocks.findStaffById.mockResolvedValue(target);
    repositoryMocks.setUserActive.mockResolvedValue({ ...target, isActive: true });

    const result = await reactivateStaffAccount(ACTOR, target.id);

    expect(result.isActive).toBe(true);
    expect(repositoryMocks.setUserActive).toHaveBeenCalledWith(TX_CLIENT, target.id, true);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'STAFF_ACCOUNT_REACTIVATED',
      entityType: 'User',
      entityId: target.id,
      beforeState: { isActive: false },
      afterState: { isActive: true },
    });
    expect(repositoryMocks.deleteSessionsForUser).not.toHaveBeenCalled();
  });
});
