import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import {
  findClientById,
  findClientByIdForRead,
  findDuplicateClientMatches,
  findDuplicateLeadMatches,
  findOwnedClientForUser,
  insertAuditLog,
  listClientsForActor,
  updateClientFieldsIfUnstale,
} from './repository';

const ADMIN_MANAGER = { id: 'admin-1', role: 'ADMIN_MANAGER' as const };
const TRAVEL_CONSULTANT = { id: 'tc-1', role: 'TRAVEL_CONSULTANT' as const };

const TC_ASSIGNMENT_FILTER = {
  assignments: { some: { assignedStaffId: TRAVEL_CONSULTANT.id, endedAt: null } },
};

const ASSIGNMENT_SELECT = {
  where: { endedAt: null },
  take: 1,
  select: {
    assignedStaffId: true,
    assignedStaff: { select: { id: true, name: true } },
  },
};

// D-025 §3's exact, closed list-item field set.
const CLIENT_LIST_ITEM_KEYS = [
  'id',
  'fullName',
  'email',
  'phone',
  'createdAt',
  'assignment',
].sort();

// D-025 §4's exact, closed detail-response field set.
const CLIENT_DETAIL_KEYS = [
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

describe('listClientsForActor', () => {
  it('applies no assignment filter for ADMIN_MANAGER', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { client: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listClientsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where: {},
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: {} });
  });

  it('scopes the query to active Client assignments for TRAVEL_CONSULTANT — composed into the database where clause, never a per-row filter', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { client: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listClientsForActor(db, TRAVEL_CONSULTANT, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where: TC_ASSIGNMENT_FILTER,
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: TC_ASSIGNMENT_FILTER });
  });

  it('composes a case-insensitive search OR across fullName/email/phone, alongside the TC assignment filter', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { client: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listClientsForActor(db, TRAVEL_CONSULTANT, { skip: 0, take: 20, search: 'juan' });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        ...TC_ASSIGNMENT_FILTER,
        OR: [
          { fullName: { contains: 'juan', mode: 'insensitive' } },
          { email: { contains: 'juan', mode: 'insensitive' } },
          { phone: { contains: 'juan', mode: 'insensitive' } },
        ],
      },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
  });

  it('omits the OR clause entirely when no search is supplied', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { client: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listClientsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    const whereArg = findMany.mock.calls[0]![0].where;
    expect(whereArg).not.toHaveProperty('OR');
  });

  it('applies pagination skip/take and deterministic createdAt desc, id desc ordering', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { client: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listClientsForActor(db, ADMIN_MANAGER, { skip: 40, take: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 40,
        take: 20,
      }),
    );
  });

  it("selects exactly D-025 §3's closed list-item field set, plus the nested assignment lookup, and nothing else", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { client: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listClientsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    const selectArg = findMany.mock.calls[0]![0].select;
    expect(selectArg).toEqual({
      id: true,
      fullName: true,
      email: true,
      phone: true,
      createdAt: true,
      assignments: ASSIGNMENT_SELECT,
    });
    // Never normalizedEmail/normalizedPhone/address/nationality/dateOfBirth/
    // emergencyContact/notes/updatedAt/originatingLeads/audit fields.
    expect(selectArg).not.toHaveProperty('normalizedEmail');
    expect(selectArg).not.toHaveProperty('normalizedPhone');
    expect(selectArg).not.toHaveProperty('updatedAt');
    expect(selectArg).not.toHaveProperty('leads');
  });

  it('maps no active assignment to assignment: null and an active assignment to { staffId, staffName }, per row', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'client-1',
        fullName: 'Juan',
        email: null,
        phone: null,
        createdAt: new Date(0),
        assignments: [],
      },
      {
        id: 'client-2',
        fullName: 'Maria',
        email: null,
        phone: null,
        createdAt: new Date(0),
        assignments: [{ assignedStaffId: 'tc-1', assignedStaff: { id: 'tc-1', name: 'TC One' } }],
      },
    ]);
    const count = vi.fn().mockResolvedValue(2);
    const db = { client: { findMany, count } } as unknown as Prisma.TransactionClient;

    const { items } = await listClientsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    expect(items).toEqual([
      expect.objectContaining({ id: 'client-1', assignment: null }),
      expect.objectContaining({
        id: 'client-2',
        assignment: { staffId: 'tc-1', staffName: 'TC One' },
      }),
    ]);
    expect(Object.keys(items[0]!).sort()).toEqual(CLIENT_LIST_ITEM_KEYS);
  });

  it('propagates a rejected findMany rather than swallowing it', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const count = vi.fn().mockResolvedValue(0);
    const db = { client: { findMany, count } } as unknown as Prisma.TransactionClient;

    await expect(listClientsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 })).rejects.toThrow(
      'db unavailable',
    );
  });
});

describe('findClientByIdForRead', () => {
  it('fetches by id (Client-level authorization already decided by canAccessClient)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1', assignments: [], leads: [] });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientByIdForRead(db, 'client-1', ADMIN_MANAGER);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'client-1' },
      select: expect.any(Object),
    });
  });

  it("selects exactly D-025 §4's closed detail field set for ADMIN_MANAGER — the complete select, not a partial match (fails if any extra Client scalar or relation is ever selected)", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1', assignments: [], leads: [] });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientByIdForRead(db, 'client-1', ADMIN_MANAGER);

    const selectArg = findUnique.mock.calls[0]![0].select;
    expect(selectArg).toEqual({
      id: true,
      fullName: true,
      email: true,
      phone: true,
      address: true,
      nationality: true,
      dateOfBirth: true,
      emergencyContact: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
      assignments: ASSIGNMENT_SELECT,
      leads: {
        where: undefined,
        select: {
          id: true,
          fullName: true,
          status: true,
          source: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      },
    });
  });

  it('applies no originatingLeads Lead-assignment filter for ADMIN_MANAGER', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1', assignments: [], leads: [] });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientByIdForRead(db, 'client-1', ADMIN_MANAGER);

    const selectArg = findUnique.mock.calls[0]![0].select;
    expect(selectArg.leads.where).toBeUndefined();
  });

  it("scopes originatingLeads to the Travel Consultant's own active Lead assignments (D-025 §2/§4) — a per-query filter, not a post-fetch filter", async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1', assignments: [], leads: [] });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientByIdForRead(db, 'client-1', TRAVEL_CONSULTANT);

    const selectArg = findUnique.mock.calls[0]![0].select;
    expect(selectArg.leads.where).toEqual({
      assignments: { some: { assignedStaffId: TRAVEL_CONSULTANT.id, endedAt: null } },
    });
  });

  it('orders originatingLeads by createdAt desc, id desc and selects only id/fullName/status/source/createdAt', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1', assignments: [], leads: [] });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientByIdForRead(db, 'client-1', ADMIN_MANAGER);

    const selectArg = findUnique.mock.calls[0]![0].select;
    expect(selectArg.leads.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(selectArg.leads.select).toEqual({
      id: true,
      fullName: true,
      status: true,
      source: true,
      createdAt: true,
    });
  });

  it('maps no active assignment to assignment: null and an empty leads array to originatingLeads: []', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'client-1',
      fullName: 'Juan',
      email: null,
      phone: null,
      address: null,
      nationality: null,
      dateOfBirth: null,
      emergencyContact: null,
      notes: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      assignments: [],
      leads: [],
    });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientByIdForRead(db, 'client-1', ADMIN_MANAGER);

    expect(result?.assignment).toBeNull();
    expect(result?.originatingLeads).toEqual([]);
    expect(Object.keys(result!).sort()).toEqual(CLIENT_DETAIL_KEYS);
  });

  it('maps an active assignment and a populated originatingLeads array', async () => {
    const lead = {
      id: 'lead-1',
      fullName: 'Juan',
      status: 'CONVERTED_TO_CLIENT',
      source: 'Contact page',
      createdAt: new Date(0),
    };
    const findUnique = vi.fn().mockResolvedValue({
      id: 'client-1',
      fullName: 'Juan',
      email: null,
      phone: null,
      address: null,
      nationality: null,
      dateOfBirth: null,
      emergencyContact: null,
      notes: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      assignments: [{ assignedStaffId: 'tc-1', assignedStaff: { id: 'tc-1', name: 'TC One' } }],
      leads: [lead],
    });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientByIdForRead(db, 'client-1', ADMIN_MANAGER);

    expect(result?.assignment).toEqual({ staffId: 'tc-1', staffName: 'TC One' });
    expect(result?.originatingLeads).toEqual([lead]);
  });

  it('converts a stored UTC-midnight dateOfBirth to an exact YYYY-MM-DD string, never a timestamp (D-025 §4)', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'client-1',
      fullName: 'Juan',
      email: null,
      phone: null,
      address: null,
      nationality: null,
      dateOfBirth: new Date('1990-05-15T00:00:00.000Z'),
      emergencyContact: null,
      notes: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      assignments: [],
      leads: [],
    });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientByIdForRead(db, 'client-1', ADMIN_MANAGER);

    expect(result?.dateOfBirth).toBe('1990-05-15');
    expect(typeof result?.dateOfBirth).toBe('string');
    expect(result?.dateOfBirth).not.toContain('T');
  });

  it('leaves a null dateOfBirth as null (never a converted string)', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'client-1',
      fullName: 'Juan',
      email: null,
      phone: null,
      address: null,
      nationality: null,
      dateOfBirth: null,
      emergencyContact: null,
      notes: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      assignments: [],
      leads: [],
    });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientByIdForRead(db, 'client-1', ADMIN_MANAGER);

    expect(result?.dateOfBirth).toBeNull();
  });

  it('returns null unchanged when the Client does not exist (never maps a null row)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientByIdForRead(db, 'missing-client', ADMIN_MANAGER);

    expect(result).toBeNull();
  });
});

describe('findClientById', () => {
  it('fetches unscoped by id, selecting the full editable-field set including normalized contact fields', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1' });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientById(db, 'client-1');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'client-1' },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        normalizedEmail: true,
        normalizedPhone: true,
        address: true,
        nationality: true,
        dateOfBirth: true,
        emergencyContact: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it('never selects assignment or originatingLeads data (mutation/existence-check use only)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1' });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientById(db, 'client-1');

    const selectArg = findUnique.mock.calls[0]![0].select;
    expect(selectArg).not.toHaveProperty('assignments');
    expect(selectArg).not.toHaveProperty('leads');
  });

  it('returns null unchanged when the Client does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientById(db, 'missing-client');

    expect(result).toBeNull();
  });
});

describe('findDuplicateClientMatches (Client-vs-Client, D-025 §6)', () => {
  it('returns no query when neither normalized field is supplied', async () => {
    const findMany = vi.fn();
    const db = { client: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await findDuplicateClientMatches(db, { excludeClientId: 'client-1' });

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('excludes the Client being edited via id: { not }, composed directly into the query', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { client: { findMany } } as unknown as Prisma.TransactionClient;

    await findDuplicateClientMatches(db, {
      normalizedEmail: 'juan@example.com',
      normalizedPhone: '639171234567',
      excludeClientId: 'client-1',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ normalizedEmail: 'juan@example.com' }, { normalizedPhone: '639171234567' }],
        id: { not: 'client-1' },
      },
      select: { id: true, fullName: true, normalizedEmail: true, normalizedPhone: true },
    });
  });

  it('returns only the permitted duplicate metadata (id, fullName, matchedOn) — never email/phone/notes/assignment', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'client-2',
        fullName: 'Maria',
        normalizedEmail: 'juan@example.com',
        normalizedPhone: '639171234567',
      },
    ]);
    const db = { client: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await findDuplicateClientMatches(db, {
      normalizedEmail: 'juan@example.com',
      normalizedPhone: '639171234567',
      excludeClientId: 'client-1',
    });

    expect(result).toEqual([{ id: 'client-2', fullName: 'Maria', matchedOn: ['EMAIL', 'PHONE'] }]);
    expect(Object.keys(result[0]!).sort()).toEqual(['fullName', 'id', 'matchedOn']);
  });

  it('reports only the matched channel(s) actually supplied', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'client-2',
        fullName: 'Maria',
        normalizedEmail: 'juan@example.com',
        normalizedPhone: null,
      },
    ]);
    const db = { client: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await findDuplicateClientMatches(db, {
      normalizedEmail: 'juan@example.com',
      excludeClientId: 'client-1',
    });

    expect(result).toEqual([{ id: 'client-2', fullName: 'Maria', matchedOn: ['EMAIL'] }]);
  });
});

describe('findDuplicateLeadMatches (Client-vs-Lead, D-025 §6 corrected self-exclusion)', () => {
  it('returns no query when neither normalized field is supplied', async () => {
    const findMany = vi.fn();
    const db = { lead: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await findDuplicateLeadMatches(db, { excludeClientId: 'client-1' });

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("excludes only Leads whose clientId equals the Client being edited (the Client's own originating Lead), never unlinked or differently-linked Leads, composed directly into the query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { lead: { findMany } } as unknown as Prisma.TransactionClient;

    await findDuplicateLeadMatches(db, {
      normalizedEmail: 'juan@example.com',
      normalizedPhone: '639171234567',
      excludeClientId: 'client-1',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { OR: [{ normalizedEmail: 'juan@example.com' }, { normalizedPhone: '639171234567' }] },
          { OR: [{ clientId: null }, { clientId: { not: 'client-1' } }] },
        ],
      },
      select: {
        id: true,
        fullName: true,
        status: true,
        normalizedEmail: true,
        normalizedPhone: true,
      },
    });
  });

  it('returns only the permitted duplicate metadata (id, fullName, status, matchedOn) — never email/phone/notes/assignment', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'lead-2',
        fullName: 'Maria',
        status: 'NEW',
        normalizedEmail: 'juan@example.com',
        normalizedPhone: '639171234567',
      },
    ]);
    const db = { lead: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await findDuplicateLeadMatches(db, {
      normalizedEmail: 'juan@example.com',
      normalizedPhone: '639171234567',
      excludeClientId: 'client-1',
    });

    expect(result).toEqual([
      { id: 'lead-2', fullName: 'Maria', status: 'NEW', matchedOn: ['EMAIL', 'PHONE'] },
    ]);
    expect(Object.keys(result[0]!).sort()).toEqual(['fullName', 'id', 'matchedOn', 'status']);
  });

  it('propagates a rejected findMany rather than swallowing it', async () => {
    const findMany = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const db = { lead: { findMany } } as unknown as Prisma.TransactionClient;

    await expect(
      findDuplicateLeadMatches(db, {
        normalizedEmail: 'juan@example.com',
        excludeClientId: 'client-1',
      }),
    ).rejects.toThrow('db unavailable');
  });
});

describe('updateClientFieldsIfUnstale (D-025 §7)', () => {
  it('includes both the Client id and the expected updatedAt in the atomic update predicate', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { client: { updateMany } } as unknown as Prisma.TransactionClient;

    const expectedUpdatedAt = new Date('2026-07-30T12:34:56.789Z');
    await updateClientFieldsIfUnstale(db, {
      id: 'client-1',
      expectedUpdatedAt,
      fullName: 'New Name',
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'client-1', updatedAt: expectedUpdatedAt },
      data: { fullName: 'New Name' },
    });
  });

  it('never includes id or expectedUpdatedAt inside the data payload itself', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { client: { updateMany } } as unknown as Prisma.TransactionClient;

    await updateClientFieldsIfUnstale(db, {
      id: 'client-1',
      expectedUpdatedAt: new Date('2026-07-30T12:34:56.789Z'),
      notes: 'VIP',
    });

    const dataArg = updateMany.mock.calls[0]![0].data;
    expect(dataArg).not.toHaveProperty('id');
    expect(dataArg).not.toHaveProperty('expectedUpdatedAt');
    expect(dataArg).not.toHaveProperty('updatedAt');
    expect(dataArg).toEqual({ notes: 'VIP' });
  });

  it("returns Prisma's own { count } unchanged — count 1 for an applied write", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { client: { updateMany } } as unknown as Prisma.TransactionClient;

    const result = await updateClientFieldsIfUnstale(db, {
      id: 'client-1',
      expectedUpdatedAt: new Date('2026-07-30T12:34:56.789Z'),
      fullName: 'New Name',
    });

    expect(result).toEqual({ count: 1 });
  });

  it('returns count 0 unchanged when the predicate matches no row (missing Client or stale updatedAt) — the caller distinguishes the two', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const db = { client: { updateMany } } as unknown as Prisma.TransactionClient;

    const result = await updateClientFieldsIfUnstale(db, {
      id: 'client-1',
      expectedUpdatedAt: new Date('2026-07-30T12:34:56.789Z'),
      fullName: 'New Name',
    });

    expect(result).toEqual({ count: 0 });
  });

  it('is suitable for a transaction client — accepts the same Prisma.TransactionClient shape as every other repository function here', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { client: { updateMany } } as unknown as Prisma.TransactionClient;

    await expect(
      updateClientFieldsIfUnstale(tx, {
        id: 'client-1',
        expectedUpdatedAt: new Date('2026-07-30T12:34:56.789Z'),
        email: 'new@example.com',
        normalizedEmail: 'new@example.com',
      }),
    ).resolves.toEqual({ count: 1 });
  });

  it('propagates a rejected updateMany rather than swallowing it', async () => {
    const updateMany = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const db = { client: { updateMany } } as unknown as Prisma.TransactionClient;

    await expect(
      updateClientFieldsIfUnstale(db, {
        id: 'client-1',
        expectedUpdatedAt: new Date('2026-07-30T12:34:56.789Z'),
        fullName: 'New Name',
      }),
    ).rejects.toThrow('db unavailable');
  });
});

describe('insertAuditLog (D-025 §8)', () => {
  it('writes the supplied entry with a server-generated id', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'CLIENT_UPDATED',
      entityType: 'Client',
      entityId: 'client-1',
      afterState: { changedFields: ['fullName'], hasEmail: true, hasPhone: false },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'actor-1',
        action: 'CLIENT_UPDATED',
        entityType: 'Client',
        entityId: 'client-1',
        afterState: { changedFields: ['fullName'], hasEmail: true, hasPhone: false },
      }),
    });
    const dataArg = create.mock.calls[0]![0].data;
    expect(typeof dataArg.id).toBe('string');
    expect(dataArg.id.length).toBeGreaterThan(0);
  });

  it('generates a different id on every call — never caller-supplied', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'CLIENT_UPDATED',
      entityType: 'Client',
      entityId: 'client-1',
    });
    await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'CLIENT_UPDATED',
      entityType: 'Client',
      entityId: 'client-1',
    });

    const firstId = create.mock.calls[0]![0].data.id;
    const secondId = create.mock.calls[1]![0].data.id;
    expect(firstId).not.toBe(secondId);
  });

  it('does not open a transaction — writes through whatever db client it is given', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'CLIENT_UPDATED',
      entityType: 'Client',
      entityId: 'client-1',
    });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('propagates a rejected create rather than swallowing it', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await expect(
      insertAuditLog(db, {
        actorId: 'actor-1',
        action: 'CLIENT_UPDATED',
        entityType: 'Client',
        entityId: 'client-1',
      }),
    ).rejects.toThrow('db unavailable');
  });
});

// --- Client-portal owned-client resolution (D-040 §§2, 3 Contract A) ---

describe('findOwnedClientForUser', () => {
  it('scopes the query by userId alone via findUnique on the @unique column, selecting only the identity-card fields', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      client: { id: 'client-9', fullName: 'Ana Reyes', email: 'ana@example.com', phone: null },
    });
    const db = { clientProfile: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findOwnedClientForUser(db, 'user-9');

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-9' },
      select: { client: { select: { id: true, fullName: true, email: true, phone: true } } },
    });
    expect(result).toEqual({
      clientId: 'client-9',
      fullName: 'Ana Reyes',
      email: 'ana@example.com',
      phone: null,
    });
  });

  it('never selects dateOfBirth, nationality, address, emergencyContact, notes, normalized contact, timestamps, ClientProfile.id, or userId', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { clientProfile: { findUnique } } as unknown as Prisma.TransactionClient;

    await findOwnedClientForUser(db, 'user-9');

    const select = findUnique.mock.calls[0]![0].select as {
      client: { select: Record<string, unknown> };
    };
    const clientKeys = Object.keys(select.client.select).sort();
    expect(clientKeys).toEqual(['email', 'fullName', 'id', 'phone']);
    for (const forbidden of [
      'dateOfBirth',
      'nationality',
      'address',
      'emergencyContact',
      'notes',
      'normalizedEmail',
      'normalizedPhone',
      'createdAt',
      'updatedAt',
      'userId',
    ]) {
      expect(clientKeys).not.toContain(forbidden);
    }
    expect(select).not.toHaveProperty('id');
  });

  it('returns null when the user has no ClientProfile row', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { clientProfile: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await findOwnedClientForUser(db, 'user-none')).toBeNull();
  });

  it('accepts no clientId parameter — the signature is (db, userId) only', () => {
    expect(findOwnedClientForUser).toHaveLength(2);
  });
});
