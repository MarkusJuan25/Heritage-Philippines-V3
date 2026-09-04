import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db`, which eagerly validates env
// vars and opens a real database adapter at import time. Mock it before
// `./service` is imported — the same reason
// features/leads/service.test.ts mocks it.
const TX_CLIENT = { marker: 'tx-client' };
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { $transaction: transactionMock, marker: 'prisma-singleton' },
}));

const repositoryMocks = vi.hoisted(() => ({
  listClientsForActor: vi.fn(),
  findClientByIdForRead: vi.fn(),
  findClientById: vi.fn(),
  findDuplicateClientMatches: vi.fn(),
  findDuplicateLeadMatches: vi.fn(),
  findOwnedClientForUser: vi.fn(),
  updateClientFieldsIfUnstale: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

const authorizationMocks = vi.hoisted(() => ({
  canAccessLead: vi.fn(),
  canAccessClient: vi.fn(),
}));
vi.mock('@/features/assignments/authorization', () => authorizationMocks);

const assignmentRepositoryMocks = vi.hoisted(() => ({
  findActiveAssignmentForClient: vi.fn(),
}));
vi.mock('@/features/assignments/repository', () => assignmentRepositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { ClientError } from './errors';
import type { ClientDetailRecord, ClientRecord } from './repository';
import { getClientById, getOwnClientForUser, listClients, updateClient } from './service';

const ADMIN_MANAGER: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};
const TRAVEL_CONSULTANT: AuthenticatedUser = {
  id: 'tc-1',
  email: 'tc@example.test',
  name: 'TC',
  role: 'TRAVEL_CONSULTANT',
};

const VALID_UPDATED_AT = new Date('2026-07-30T12:34:56.789Z');
const VALID_EXPECTED_UPDATED_AT = '2026-07-30T12:34:56.789Z';

function clientRecord(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: 'client-1',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: null,
    normalizedEmail: 'juan@example.com',
    normalizedPhone: null,
    address: null,
    nationality: null,
    dateOfBirth: null,
    emergencyContact: null,
    notes: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: VALID_UPDATED_AT,
    ...overrides,
  };
}

function clientDetailRecord(overrides: Partial<ClientDetailRecord> = {}): ClientDetailRecord {
  return {
    id: 'client-1',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: null,
    address: null,
    nationality: null,
    dateOfBirth: null,
    emergencyContact: null,
    notes: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: VALID_UPDATED_AT,
    assignment: null,
    originatingLeads: [],
    ...overrides,
  };
}

type AssignmentRecordFixture = {
  id: string;
  assignedStaffId: string;
  assignedByUserId: string;
  leadId: string | null;
  clientId: string | null;
  bookingId: string | null;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
};

function assignmentRecord(
  overrides: Partial<AssignmentRecordFixture> = {},
): AssignmentRecordFixture {
  return {
    id: 'assignment-1',
    assignedStaffId: TRAVEL_CONSULTANT.id,
    assignedByUserId: ADMIN_MANAGER.id,
    leadId: null,
    clientId: 'client-1',
    bookingId: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    endedAt: null,
    ...overrides,
  };
}

// D-031 F-01 — mirrors features/leads/service.test.ts's identical helper.
function conflictError(code: 'P2034' | 'P2002' | 'P2004'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Simulated database conflict', {
    code,
    clientVersion: '7.8.0',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
  authorizationMocks.canAccessLead.mockResolvedValue({ allowed: true });
  authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
  repositoryMocks.findDuplicateClientMatches.mockResolvedValue([]);
  repositoryMocks.findDuplicateLeadMatches.mockResolvedValue([]);
  assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(
    assignmentRecord({ assignedStaffId: TRAVEL_CONSULTANT.id }),
  );
});

describe('role gating', () => {
  const REJECTED_ROLES = [
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'SYSTEM_ADMINISTRATOR',
    'CLIENT',
  ];

  it.each(REJECTED_ROLES)('listClients rejects role %s with ROLE_NOT_PERMITTED', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(listClients(actor, { page: 1, pageSize: 20 })).rejects.toMatchObject({
      code: 'ROLE_NOT_PERMITTED',
    });
    expect(repositoryMocks.listClientsForActor).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)('getClientById rejects role %s with ROLE_NOT_PERMITTED', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(getClientById(actor, 'client-1')).rejects.toMatchObject({
      code: 'ROLE_NOT_PERMITTED',
    });
    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)('updateClient rejects role %s with ROLE_NOT_PERMITTED', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(
      updateClient(actor, 'client-1', {
        fullName: 'X',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized role with a ClientError instance', async () => {
    const actor = { ...ADMIN_MANAGER, role: 'CLIENT' as AuthenticatedUser['role'] };
    await expect(listClients(actor, { page: 1, pageSize: 20 })).rejects.toBeInstanceOf(ClientError);
  });
});

describe('listClients', () => {
  it('delegates to the actor-scoped repository query for ADMIN_MANAGER', async () => {
    repositoryMocks.listClientsForActor.mockResolvedValue({ items: [], total: 0 });

    const result = await listClients(ADMIN_MANAGER, { page: 2, pageSize: 10 });

    expect(repositoryMocks.listClientsForActor).toHaveBeenCalledWith(
      prisma,
      { id: ADMIN_MANAGER.id, role: 'ADMIN_MANAGER' },
      { skip: 10, take: 10, search: undefined },
    );
    expect(result).toEqual({ items: [], page: 2, pageSize: 10, total: 0 });
  });

  it('delegates to the actor-scoped repository query for TRAVEL_CONSULTANT, computing skip from page/pageSize', async () => {
    repositoryMocks.listClientsForActor.mockResolvedValue({ items: [], total: 0 });

    await listClients(TRAVEL_CONSULTANT, { page: 3, pageSize: 5, search: 'juan' });

    expect(repositoryMocks.listClientsForActor).toHaveBeenCalledWith(
      prisma,
      { id: TRAVEL_CONSULTANT.id, role: 'TRAVEL_CONSULTANT' },
      { skip: 10, take: 5, search: 'juan' },
    );
  });

  it('never calls canAccessClient per row — scoping is the repository query alone', async () => {
    repositoryMocks.listClientsForActor.mockResolvedValue({
      items: [{ id: 'client-1' }, { id: 'client-2' }],
      total: 2,
    });

    await listClients(ADMIN_MANAGER, { page: 1, pageSize: 20 });

    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
  });

  it('returns exactly { items, page, pageSize, total }', async () => {
    const items = [{ id: 'client-1' }];
    repositoryMocks.listClientsForActor.mockResolvedValue({ items, total: 1 });

    const result = await listClients(ADMIN_MANAGER, { page: 1, pageSize: 20 });

    expect(Object.keys(result).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    expect(result.items).toBe(items);
  });
});

describe('getClientById', () => {
  it('returns CLIENT_NOT_FOUND for ADMIN_MANAGER when canAccessClient rejects', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(getClientById(ADMIN_MANAGER, 'client-1')).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  it('returns CLIENT_FORBIDDEN for TRAVEL_CONSULTANT when canAccessClient rejects', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(getClientById(TRAVEL_CONSULTANT, 'client-1')).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
  });

  it('returns CLIENT_NOT_FOUND for ADMIN_MANAGER when the Client does not exist despite unconditional access', async () => {
    repositoryMocks.findClientByIdForRead.mockResolvedValue(null);

    await expect(getClientById(ADMIN_MANAGER, 'client-missing')).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  it('returns the exact detail shape (bare YYYY-MM-DD dateOfBirth, no normalized fields) when authorized and found', async () => {
    const record = clientDetailRecord({
      dateOfBirth: '1990-05-15',
      assignment: { staffId: 'tc-1', staffName: 'TC One' },
    });
    repositoryMocks.findClientByIdForRead.mockResolvedValue(record);

    const result = await getClientById(ADMIN_MANAGER, 'client-1');

    expect(result).toBe(record);
    expect(result.dateOfBirth).toBe('1990-05-15');
    expect(result).not.toHaveProperty('normalizedEmail');
    expect(result).not.toHaveProperty('normalizedPhone');
    expect(repositoryMocks.findClientById).not.toHaveBeenCalled();
  });

  it('passes the resolved ClientActor through to findClientByIdForRead', async () => {
    repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

    await getClientById(TRAVEL_CONSULTANT, 'client-1');

    expect(repositoryMocks.findClientByIdForRead).toHaveBeenCalledWith(prisma, 'client-1', {
      id: TRAVEL_CONSULTANT.id,
      role: 'TRAVEL_CONSULTANT',
    });
  });
});

describe('updateClient', () => {
  describe('pre-transaction authorization', () => {
    it('returns CLIENT_NOT_FOUND for ADMIN_MANAGER before opening a transaction when canAccessClient rejects', async () => {
      authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'X',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('returns CLIENT_FORBIDDEN for TRAVEL_CONSULTANT before opening a transaction when canAccessClient rejects', async () => {
      authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

      await expect(
        updateClient(TRAVEL_CONSULTANT, 'client-1', {
          fullName: 'X',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });

  describe('transaction-local Travel Consultant assignment recheck', () => {
    it('succeeds when the TC holds the current active Client assignment', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(TRAVEL_CONSULTANT, 'client-1', {
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenCalledWith(
        TX_CLIENT,
        'client-1',
      );
      expect(repositoryMocks.updateClientFieldsIfUnstale).toHaveBeenCalled();
    });

    it('rejects with CLIENT_FORBIDDEN when no active assignment exists, before reading Client state', async () => {
      assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

      await expect(
        updateClient(TRAVEL_CONSULTANT, 'client-1', {
          fullName: 'New Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
      expect(repositoryMocks.findClientById).not.toHaveBeenCalled();
      expect(repositoryMocks.updateClientFieldsIfUnstale).not.toHaveBeenCalled();
    });

    it('rejects with CLIENT_FORBIDDEN when the active assignment belongs to a different staff member', async () => {
      assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(
        assignmentRecord({ assignedStaffId: 'other-tc' }),
      );

      await expect(
        updateClient(TRAVEL_CONSULTANT, 'client-1', {
          fullName: 'New Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
      expect(repositoryMocks.findClientById).not.toHaveBeenCalled();
    });

    it('never performs the assignment lookup for ADMIN_MANAGER', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(assignmentRepositoryMocks.findActiveAssignmentForClient).not.toHaveBeenCalled();
    });
  });

  describe('D-031 F-01: transaction-local recheck and retry behavior', () => {
    it("returns CLIENT_FORBIDDEN when a fresh retry's transaction-local recheck observes the assignment lost after an initial P2034 conflict, without retrying the forbidden result", async () => {
      assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

      let attempt = 0;
      transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => {
        attempt += 1;
        if (attempt === 1) {
          throw conflictError('P2034');
        }
        return fn(TX_CLIENT);
      });

      await expect(
        updateClient(TRAVEL_CONSULTANT, 'client-1', {
          fullName: 'Should never persist',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });

      expect(transactionMock).toHaveBeenCalledTimes(2);
      expect(repositoryMocks.updateClientFieldsIfUnstale).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('maps a serialization conflict that survives every retry to CLIENT_CONFLICT, never a raw Prisma error', async () => {
      transactionMock.mockImplementation(async () => {
        throw conflictError('P2034');
      });

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'Should never persist',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_CONFLICT' });

      expect(transactionMock).toHaveBeenCalledTimes(3);
      expect(repositoryMocks.updateClientFieldsIfUnstale).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });
  });

  describe('initial expectedUpdatedAt verification (D-025 §7 ordering)', () => {
    it('returns CLIENT_CONFLICT immediately for an already-stale changed request, before any duplicate query, updateClientFieldsIfUnstale, or audit work', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ fullName: 'Old Name', updatedAt: new Date('2026-08-01T00:00:00.000Z') }),
      );

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'New Name',
          email: 'new@example.com',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_CONFLICT' });

      expect(repositoryMocks.findDuplicateClientMatches).not.toHaveBeenCalled();
      expect(repositoryMocks.findDuplicateLeadMatches).not.toHaveBeenCalled();
      expect(repositoryMocks.updateClientFieldsIfUnstale).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('returns CLIENT_CONFLICT for an already-stale contact no-op, before duplicate detection ever runs', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({
          email: 'same@example.com',
          normalizedEmail: 'same@example.com',
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      );

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          email: 'same@example.com',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_CONFLICT' });

      expect(repositoryMocks.findDuplicateClientMatches).not.toHaveBeenCalled();
      expect(repositoryMocks.findDuplicateLeadMatches).not.toHaveBeenCalled();
    });

    it('returns CLIENT_CONFLICT — not VALIDATION_ERROR — for an already-stale request that would also violate the combined email/phone retention invariant, since D-025 §7 checks staleness first', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({
          email: 'juan@example.com',
          phone: null,
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      );

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          email: null,
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_CONFLICT' });
    });
  });

  describe('combined email/phone retention invariant', () => {
    it('rejects a patch that would leave both final email and phone absent', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ email: 'juan@example.com', phone: null }),
      );

      // `null` here mirrors what the schema layer's blank->null transform
      // already produces before the service ever sees the patch — never a
      // raw blank string.
      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          email: null,
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(repositoryMocks.updateClientFieldsIfUnstale).not.toHaveBeenCalled();
    });

    it('allows clearing email when phone remains present in the final state', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ email: 'juan@example.com', phone: '639171234567' }),
      );
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(
        clientDetailRecord({ email: null, phone: '639171234567' }),
      );

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        email: null,
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.updateClientFieldsIfUnstale).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({ email: null, normalizedEmail: null }),
      );
      expect(result.client.email).toBeNull();
    });

    it('does not validate contact presence from the partial request alone (existing phone covers an email-only patch)', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ email: 'old@example.com', phone: '639171234567' }),
      );
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        email: 'new@example.com',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.updateClientFieldsIfUnstale).toHaveBeenCalled();
    });
  });

  describe('omitted versus explicit-clear semantics and field-change detection', () => {
    it('leaves an omitted field out of the update payload entirely', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ notes: 'existing note' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      const dataArg = repositoryMocks.updateClientFieldsIfUnstale.mock.calls[0]![1];
      expect(dataArg).not.toHaveProperty('notes');
    });

    it('does not include dateOfBirth in the update payload when the stored Client has a non-null dateOfBirth and the patch omits dateOfBirth entirely (Stage C correction regression test)', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({
          dateOfBirth: new Date('1990-05-15T00:00:00.000Z'),
          notes: 'Old notes',
        }),
      );
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        notes: 'New notes',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      const dataArg = repositoryMocks.updateClientFieldsIfUnstale.mock.calls[0]![1];
      expect(dataArg).not.toHaveProperty('dateOfBirth');
      expect(dataArg).toEqual(expect.objectContaining({ notes: 'New notes' }));
    });

    it('treats an explicit null as a genuine change from an existing non-null value', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ address: '123 Rizal St.' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        address: null,
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.updateClientFieldsIfUnstale).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({ address: null }),
      );
    });

    it('compares dateOfBirth by timestamp value, never by Date object identity, and detects no change for an equal-value new Date instance', async () => {
      const sameInstant = new Date('1990-05-15T00:00:00.000Z');
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ dateOfBirth: new Date('1990-05-15T00:00:00.000Z') }),
      );
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        dateOfBirth: sameInstant,
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      const dataArg = repositoryMocks.updateClientFieldsIfUnstale.mock.calls[0]![1];
      expect(dataArg).not.toHaveProperty('dateOfBirth');
      expect(dataArg).toEqual(expect.objectContaining({ fullName: 'New Name' }));
    });

    it('detects a genuine dateOfBirth change by differing timestamp value', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ dateOfBirth: new Date('1990-05-15T00:00:00.000Z') }),
      );
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        dateOfBirth: new Date('1991-06-20T00:00:00.000Z'),
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.updateClientFieldsIfUnstale).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({ dateOfBirth: new Date('1991-06-20T00:00:00.000Z') }),
      );
    });

    it('preserves the contracted field-detection order in changedFields (fullName, email, phone, address, nationality, dateOfBirth, emergencyContact, notes)', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({
          fullName: 'Old Name',
          email: 'old@example.com',
          phone: null,
          address: 'Old address',
          nationality: 'Old nationality',
          dateOfBirth: new Date('1980-01-01T00:00:00.000Z'),
          emergencyContact: 'Old contact',
          notes: 'Old notes',
        }),
      );
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        notes: 'New notes',
        fullName: 'New Name',
        emergencyContact: 'New contact',
        email: 'new@example.com',
        dateOfBirth: new Date('1990-05-15T00:00:00.000Z'),
        nationality: 'New nationality',
        address: 'New address',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({
          afterState: expect.objectContaining({
            changedFields: [
              'fullName',
              'email',
              'address',
              'nationality',
              'dateOfBirth',
              'emergencyContact',
              'notes',
            ],
          }),
        }),
      );
    });

    it('sets normalizedEmail atomically with email in the same data payload', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ email: 'old@example.com' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        email: 'Juan.New@Example.COM',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.updateClientFieldsIfUnstale).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({
          email: 'Juan.New@Example.COM',
          normalizedEmail: 'juan.new@example.com',
        }),
      );
    });

    it('sets normalizedPhone atomically with phone in the same data payload', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ phone: null }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        phone: '0917 123 4567',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.updateClientFieldsIfUnstale).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({ phone: '0917 123 4567', normalizedPhone: '639171234567' }),
      );
    });

    it("never includes assignment, originatingLeads, createdAt, or updatedAt anywhere in the repository call — id/expectedUpdatedAt legitimately appear as that call's own top-level fields, never inside the changed-fields data", async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      const callArg = repositoryMocks.updateClientFieldsIfUnstale.mock.calls[0]![1];
      for (const forbidden of ['assignment', 'originatingLeads', 'createdAt', 'updatedAt']) {
        expect(callArg).not.toHaveProperty(forbidden);
      }
      // `id`/`expectedUpdatedAt` are `updateClientFieldsIfUnstale`'s own
      // required top-level fields (repository.ts's contract, already
      // verified at the Prisma level in repository.test.ts) — legitimately
      // present here, never smuggled into a separate `data` sub-object.
      expect(callArg).toEqual(
        expect.objectContaining({ id: 'client-1', expectedUpdatedAt: VALID_UPDATED_AT }),
      );
    });
  });

  describe('duplicate detection and visibility shaping', () => {
    it('reruns duplicate detection whenever email is supplied, even when unchanged from the existing value', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ email: 'same@example.com', normalizedEmail: 'same@example.com' }),
      );
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        email: 'same@example.com',
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.findDuplicateClientMatches).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          normalizedEmail: 'same@example.com',
          excludeClientId: 'client-1',
        }),
      );
      expect(repositoryMocks.findDuplicateLeadMatches).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          normalizedEmail: 'same@example.com',
          excludeClientId: 'client-1',
        }),
      );
    });

    it('does not rerun duplicate detection when neither email nor phone is in the patch', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        notes: 'a note',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.findDuplicateClientMatches).not.toHaveBeenCalled();
      expect(repositoryMocks.findDuplicateLeadMatches).not.toHaveBeenCalled();
    });

    it('always passes excludeClientId: id to both duplicate queries', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        phone: '0917 123 4567',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.findDuplicateClientMatches.mock.calls[0]?.[1]?.excludeClientId).toBe(
        'client-1',
      );
      expect(repositoryMocks.findDuplicateLeadMatches.mock.calls[0]?.[1]?.excludeClientId).toBe(
        'client-1',
      );
    });

    it('uses canAccessClient for Client matches and canAccessLead for Lead matches — never cross-applied', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
        { id: 'client-2', fullName: 'Maria', matchedOn: ['EMAIL'] },
      ]);
      repositoryMocks.findDuplicateLeadMatches.mockResolvedValue([
        { id: 'lead-2', fullName: 'Pedro', status: 'NEW', matchedOn: ['EMAIL'] },
      ]);

      await updateClient(ADMIN_MANAGER, 'client-1', {
        email: 'shared@example.com',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(authorizationMocks.canAccessClient).toHaveBeenCalledWith(ADMIN_MANAGER, 'client-2');
      expect(authorizationMocks.canAccessLead).toHaveBeenCalledWith(ADMIN_MANAGER, 'lead-2');
      expect(authorizationMocks.canAccessLead).not.toHaveBeenCalledWith(ADMIN_MANAGER, 'client-2');
      expect(authorizationMocks.canAccessClient).not.toHaveBeenCalledWith(ADMIN_MANAGER, 'lead-2');
    });

    it('returns only the allow-listed fields for an authorized Client match and an authorized Lead match', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
        { id: 'client-2', fullName: 'Maria', matchedOn: ['EMAIL'] },
      ]);
      repositoryMocks.findDuplicateLeadMatches.mockResolvedValue([
        { id: 'lead-2', fullName: 'Pedro', status: 'NEW', matchedOn: ['PHONE'] },
      ]);

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        email: 'shared@example.com',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(result.duplicateMatches).toEqual([
        { type: 'CLIENT', id: 'client-2', fullName: 'Maria', matchedOn: ['EMAIL'] },
        { type: 'LEAD', id: 'lead-2', fullName: 'Pedro', status: 'NEW', matchedOn: ['PHONE'] },
      ]);
    });

    it('collapses an unauthorized match into restrictedMatchDetected without leaking its identity', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
        { id: 'client-hidden', fullName: 'Hidden Client', matchedOn: ['PHONE'] },
      ]);
      authorizationMocks.canAccessClient.mockImplementation(async (_actor, targetId) =>
        targetId === 'client-1' ? { allowed: true } : { allowed: false, status: 403 },
      );

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        phone: '0917 123 4567',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(result.duplicateMatches).toEqual([]);
      expect(result.restrictedMatchDetected).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('client-hidden');
      expect(serialized).not.toContain('Hidden Client');
    });

    it("never surfaces the Client's own originating Lead as a duplicate or restricted match (already excluded by the repository query)", async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());
      // The repository's own self-exclusion already omits the Client's
      // originating Lead — the service has no additional filtering to do,
      // and must not invent any.
      repositoryMocks.findDuplicateLeadMatches.mockResolvedValue([]);

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        email: 'juan@example.com',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(result.duplicateMatches).toEqual([]);
      expect(result.restrictedMatchDetected).toBe(false);
    });

    it('includes both duplicateMatches and restrictedMatchDetected together when contact was supplied, even when there are no matches', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        email: 'juan@example.com',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(result.duplicateMatches).toEqual([]);
      expect(result.restrictedMatchDetected).toBe(false);
      expect(Object.hasOwn(result, 'duplicateMatches')).toBe(true);
      expect(Object.hasOwn(result, 'restrictedMatchDetected')).toBe(true);
    });

    it('omits both duplicateMatches and restrictedMatchDetected when neither email nor phone was supplied', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord());
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        notes: 'a note',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(Object.hasOwn(result, 'duplicateMatches')).toBe(false);
      expect(Object.hasOwn(result, 'restrictedMatchDetected')).toBe(false);
    });
  });

  describe('no-op behavior', () => {
    it('is a no-op (no write, no audit) when the patch changes nothing', async () => {
      const record = clientRecord({ fullName: 'Same Name' });
      repositoryMocks.findClientById.mockResolvedValue(record);
      const detail = clientDetailRecord({ fullName: 'Same Name' });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(detail);

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        fullName: 'Same Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(result.client).toBe(detail);
      expect(repositoryMocks.updateClientFieldsIfUnstale).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('returns CLIENT_CONFLICT for a stale no-op (expectedUpdatedAt does not match stored updatedAt)', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ fullName: 'Same Name', updatedAt: new Date('2026-08-01T00:00:00.000Z') }),
      );

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'Same Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_CONFLICT' });
      expect(repositoryMocks.updateClientFieldsIfUnstale).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('still runs duplicate detection and returns the result pair for a no-op when contact was supplied', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ email: 'same@example.com', normalizedEmail: 'same@example.com' }),
      );
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        email: 'same@example.com',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.findDuplicateClientMatches).toHaveBeenCalled();
      expect(Object.hasOwn(result, 'duplicateMatches')).toBe(true);
      expect(Object.hasOwn(result, 'restrictedMatchDetected')).toBe(true);
    });

    it("throws the role-aware controlled error, never a non-null assertion crash, when the no-op branch's detail reread unexpectedly returns null", async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ fullName: 'Same Name' }));
      repositoryMocks.findClientByIdForRead.mockResolvedValue(null);

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'Same Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
    });
  });

  describe('changed write, staleness, and concurrency', () => {
    it('calls the atomic repository primitive with id, expectedUpdatedAt, and only changed fields', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ fullName: 'Old Name' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.updateClientFieldsIfUnstale).toHaveBeenCalledWith(TX_CLIENT, {
        id: 'client-1',
        expectedUpdatedAt: VALID_UPDATED_AT,
        fullName: 'New Name',
      });
    });

    it('returns CLIENT_CONFLICT for a stale changed write (count 0, Client still exists)', async () => {
      repositoryMocks.findClientById
        .mockResolvedValueOnce(clientRecord({ fullName: 'Old Name' }))
        .mockResolvedValueOnce(clientRecord({ fullName: 'Old Name' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 0 });

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'New Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_CONFLICT' });
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('returns CLIENT_NOT_FOUND for ADMIN_MANAGER when count is 0 because the Client no longer exists', async () => {
      repositoryMocks.findClientById
        .mockResolvedValueOnce(clientRecord({ fullName: 'Old Name' }))
        .mockResolvedValueOnce(null);
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 0 });

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'New Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
    });

    it('returns CLIENT_FORBIDDEN for TRAVEL_CONSULTANT when count is 0 because the Client no longer exists', async () => {
      repositoryMocks.findClientById
        .mockResolvedValueOnce(clientRecord({ fullName: 'Old Name' }))
        .mockResolvedValueOnce(null);
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 0 });

      await expect(
        updateClient(TRAVEL_CONSULTANT, 'client-1', {
          fullName: 'New Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
    });

    it('writes the CLIENT_UPDATED audit entry inside the same transaction, with only allow-listed, PII-free content', async () => {
      repositoryMocks.findClientById.mockResolvedValue(
        clientRecord({ fullName: 'Old Name', email: 'old@example.com' }),
      );
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        fullName: 'New Name',
        email: 'new@example.com',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
        actorId: ADMIN_MANAGER.id,
        action: 'CLIENT_UPDATED',
        entityType: 'Client',
        entityId: 'client-1',
        afterState: {
          changedFields: ['fullName', 'email'],
          hasEmail: true,
          hasPhone: false,
        },
      });
      const serialized = JSON.stringify(repositoryMocks.insertAuditLog.mock.calls[0]);
      expect(serialized).not.toContain('New Name');
      expect(serialized).not.toContain('new@example.com');
    });

    it('re-reads the authoritative persisted result through findClientByIdForRead, returning fresh updatedAt and the exact detail shape', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ fullName: 'Old Name' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      const freshDetail = clientDetailRecord({
        fullName: 'New Name',
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        dateOfBirth: '1990-05-15',
      });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(freshDetail);

      const result = await updateClient(ADMIN_MANAGER, 'client-1', {
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      expect(repositoryMocks.findClientByIdForRead).toHaveBeenCalledWith(TX_CLIENT, 'client-1', {
        id: ADMIN_MANAGER.id,
        role: 'ADMIN_MANAGER',
      });
      expect(result.client).toBe(freshDetail);
      expect(result.client.updatedAt).toEqual(new Date('2026-08-01T00:00:00.000Z'));
      expect(result.client.dateOfBirth).toBe('1990-05-15');
      expect(result.client).not.toHaveProperty('normalizedEmail');
    });

    it('propagates a rejected transaction and never calls insertAuditLog with a non-transaction client', async () => {
      transactionMock.mockRejectedValue(new Error('db unavailable'));

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'New Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toThrow('db unavailable');
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalledWith(prisma, expect.anything());
    });

    it('invokes findClientByIdForRead before insertAuditLog on a changed success (D-025 §7 post-write ordering)', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ fullName: 'Old Name' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(clientDetailRecord());

      await updateClient(ADMIN_MANAGER, 'client-1', {
        fullName: 'New Name',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      });

      const readOrder = repositoryMocks.findClientByIdForRead.mock.invocationCallOrder[0]!;
      const auditOrder = repositoryMocks.insertAuditLog.mock.invocationCallOrder[0]!;
      expect(readOrder).toBeLessThan(auditOrder);
    });

    it('throws CLIENT_NOT_FOUND for ADMIN_MANAGER when the post-write detail reread unexpectedly returns null, without calling insertAuditLog', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ fullName: 'Old Name' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(null);

      await expect(
        updateClient(ADMIN_MANAGER, 'client-1', {
          fullName: 'New Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND' });
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('throws CLIENT_FORBIDDEN for TRAVEL_CONSULTANT when the post-write detail reread unexpectedly returns null, without calling insertAuditLog', async () => {
      repositoryMocks.findClientById.mockResolvedValue(clientRecord({ fullName: 'Old Name' }));
      repositoryMocks.updateClientFieldsIfUnstale.mockResolvedValue({ count: 1 });
      repositoryMocks.findClientByIdForRead.mockResolvedValue(null);

      await expect(
        updateClient(TRAVEL_CONSULTANT, 'client-1', {
          fullName: 'New Name',
          expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });
  });
});

// --- Client-portal owned-client resolution (D-040 §§2, 3 Contract A) ---

const CLIENT_PORTAL_USER: AuthenticatedUser = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client One',
  role: 'CLIENT',
};

const OWNED_IDENTITY = {
  clientId: 'client-row-1',
  fullName: 'Ana Reyes',
  email: 'ana@example.com',
  phone: null,
};

describe('getOwnClientForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a non-CLIENT actor with ROLE_NOT_PERMITTED and never touches the repository', async () => {
    for (const actor of [ADMIN_MANAGER, TRAVEL_CONSULTANT]) {
      await expect(getOwnClientForUser(actor)).rejects.toMatchObject({
        name: 'ClientError',
        code: 'ROLE_NOT_PERMITTED',
        status: 403,
      });
    }
    expect(repositoryMocks.findOwnedClientForUser).not.toHaveBeenCalled();
  });

  it('resolves the owned Client from actor.id alone — never a clientId, never canAccessClient', async () => {
    repositoryMocks.findOwnedClientForUser.mockResolvedValue(OWNED_IDENTITY);

    const result = await getOwnClientForUser(CLIENT_PORTAL_USER);

    expect(result).toEqual(OWNED_IDENTITY);
    expect(repositoryMocks.findOwnedClientForUser).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.findOwnedClientForUser).toHaveBeenCalledWith(
      prisma,
      CLIENT_PORTAL_USER.id,
    );
    expect(repositoryMocks.findOwnedClientForUser.mock.calls[0]).toHaveLength(2);
    // Contract A must not consult canAccessClient — its job is to *produce*
    // the owned clientId the other contracts then re-check.
    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
  });

  it('passes a missing profile through as null ("account setup in progress")', async () => {
    repositoryMocks.findOwnedClientForUser.mockResolvedValue(null);

    expect(await getOwnClientForUser(CLIENT_PORTAL_USER)).toBeNull();
  });
});
