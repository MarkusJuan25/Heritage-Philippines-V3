import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import {
  convertLeadWithHistory,
  createClientFromLead,
  createLeadWithInitialHistory,
  findClientSummaryById,
  findDuplicateClientMatches,
  findDuplicateLeadMatches,
  findLeadById,
  findLeadByIdForRead,
  findLeadConversionAudit,
  insertAuditLog,
  listLeadsForActor,
  listLeadStatusHistory,
  updateLeadFields,
  updateLeadStatusWithHistory,
  type CreateClientFromLeadInput,
} from './repository';

// The exact 12 fields LeadRecord (afe1201) carries — used to prove
// createLeadWithInitialHistory/updateLeadFields/updateLeadStatusWithHistory
// never gain an `assignment` key (Stage 2 correction: D-023's additive
// `assignment` field is authorized only for GET /api/leads and
// GET /api/leads/[id], never for the mutation-backing functions below).
const LEAD_RECORD_KEYS = [
  'id',
  'status',
  'fullName',
  'email',
  'phone',
  'normalizedEmail',
  'normalizedPhone',
  'source',
  'notes',
  'clientId',
  'createdAt',
  'updatedAt',
].sort();

const ADMIN_MANAGER = { id: 'admin-1', role: 'ADMIN_MANAGER' as const };
const TRAVEL_CONSULTANT = { id: 'tc-1', role: 'TRAVEL_CONSULTANT' as const };

const TC_ASSIGNMENT_FILTER = {
  assignments: { some: { assignedStaffId: TRAVEL_CONSULTANT.id, endedAt: null } },
};

describe('findLeadById', () => {
  it('fetches unscoped by id (authorization already decided by canAccessLead)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'lead-1' });
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    await findLeadById(db, 'lead-1');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      select: expect.any(Object),
    });
  });

  it('returns the Prisma row unchanged — never carries assignment (Stage 2 correction: reused directly by updateLead/updateLeadStatus/getLeadStatusHistory, whose responses must never gain assignment)', async () => {
    const row = {
      id: 'lead-1',
      status: 'NEW',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
      source: 'Walk-in',
      notes: null,
      clientId: null,
      createdAt: new Date('2026-07-23T00:00:00Z'),
      updatedAt: new Date('2026-07-23T00:00:00Z'),
    };
    const findUnique = vi.fn().mockResolvedValue(row);
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findLeadById(db, 'lead-1');

    expect(result).toBe(row);
    expect(Object.keys(result!).sort()).toEqual(LEAD_RECORD_KEYS);
  });

  it('returns null unchanged when the Lead does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findLeadById(db, 'missing-lead');

    expect(result).toBeNull();
  });
});

describe('findLeadByIdForRead', () => {
  it('fetches unscoped by id (authorization already decided by canAccessLead)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'lead-1', assignments: [] });
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    await findLeadByIdForRead(db, 'lead-1');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      select: expect.any(Object),
    });
  });

  it('composes the select with the nested active-assignment clause (D-023 §5)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'lead-1', assignments: [] });
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    await findLeadByIdForRead(db, 'lead-1');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      select: expect.objectContaining({
        assignments: {
          where: { endedAt: null },
          take: 1,
          select: {
            assignedStaffId: true,
            assignedStaff: { select: { id: true, name: true } },
          },
        },
      }),
    });
  });

  it('maps no active assignment to assignment: null', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'lead-1', assignments: [] });
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findLeadByIdForRead(db, 'lead-1');

    expect(result?.assignment).toBeNull();
  });

  it('maps an active assignment to { staffId, staffName }', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'lead-1',
      assignments: [{ assignedStaffId: 'tc-1', assignedStaff: { id: 'tc-1', name: 'TC One' } }],
    });
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findLeadByIdForRead(db, 'lead-1');

    expect(result?.assignment).toEqual({ staffId: 'tc-1', staffName: 'TC One' });
  });

  it('returns null unchanged when the Lead does not exist (never maps a null row)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findLeadByIdForRead(db, 'missing-lead');

    expect(result).toBeNull();
  });
});

describe('listLeadsForActor', () => {
  it('applies no assignment filter for ADMIN_MANAGER', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { lead: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listLeadsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where: {},
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: {} });
  });

  it('scopes the query to active assignments for TRAVEL_CONSULTANT', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { lead: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listLeadsForActor(db, TRAVEL_CONSULTANT, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where: TC_ASSIGNMENT_FILTER,
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
  });

  it('composes status, source, and search filters into the where clause', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { lead: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listLeadsForActor(db, ADMIN_MANAGER, {
      skip: 0,
      take: 20,
      status: 'QUALIFIED',
      source: 'Contact page',
      search: 'juan',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: 'QUALIFIED',
        source: 'Contact page',
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

  it('applies pagination skip/take', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { lead: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listLeadsForActor(db, ADMIN_MANAGER, { skip: 40, take: 20 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
  });

  it('maps each row active assignment independently (D-023 §5)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'lead-1', assignments: [] },
      {
        id: 'lead-2',
        assignments: [{ assignedStaffId: 'tc-1', assignedStaff: { id: 'tc-1', name: 'TC One' } }],
      },
    ]);
    const count = vi.fn().mockResolvedValue(2);
    const db = { lead: { findMany, count } } as unknown as Prisma.TransactionClient;

    const { items } = await listLeadsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    expect(items).toEqual([
      expect.objectContaining({ id: 'lead-1', assignment: null }),
      expect.objectContaining({
        id: 'lead-2',
        assignment: { staffId: 'tc-1', staffName: 'TC One' },
      }),
    ]);
  });
});

describe('createLeadWithInitialHistory', () => {
  it('nests the initial NEW LeadStatusHistory row inside the Lead create', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'lead-1' });
    const db = { lead: { create } } as unknown as Prisma.TransactionClient;

    await createLeadWithInitialHistory(db, {
      id: 'lead-1',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
      source: 'Walk-in',
      notes: null,
      changedByUserId: 'actor-1',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'lead-1',
        status: 'NEW',
        statusHistory: {
          create: expect.objectContaining({
            previousStatus: null,
            newStatus: 'NEW',
            changedByUserId: 'actor-1',
          }),
        },
      }),
      select: expect.any(Object),
    });
  });

  it('returns the exact pre-D-023 (afe1201) shape, with no assignment key (Stage 2 correction: POST /api/leads must never gain assignment)', async () => {
    const row = {
      id: 'lead-1',
      status: 'NEW',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
      source: 'Walk-in',
      notes: null,
      clientId: null,
      createdAt: new Date('2026-07-23T00:00:00Z'),
      updatedAt: new Date('2026-07-23T00:00:00Z'),
    };
    const create = vi.fn().mockResolvedValue(row);
    const db = { lead: { create } } as unknown as Prisma.TransactionClient;

    const result = await createLeadWithInitialHistory(db, {
      id: 'lead-1',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
      source: 'Walk-in',
      notes: null,
      changedByUserId: 'actor-1',
    });

    expect(result).toBe(row);
    expect(Object.keys(result).sort()).toEqual(LEAD_RECORD_KEYS);
  });
});

describe('updateLeadFields', () => {
  it('updates only the provided fields, excluding id from data', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'lead-1' });
    const db = { lead: { update } } as unknown as Prisma.TransactionClient;

    await updateLeadFields(db, { id: 'lead-1', fullName: 'New Name' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { fullName: 'New Name' },
      select: expect.any(Object),
    });
  });

  it('returns the exact pre-D-023 (afe1201) shape, with no assignment key (Stage 2 correction: PATCH /api/leads/[id] must never gain assignment)', async () => {
    const row = {
      id: 'lead-1',
      status: 'NEW',
      fullName: 'New Name',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
      source: 'Walk-in',
      notes: null,
      clientId: null,
      createdAt: new Date('2026-07-23T00:00:00Z'),
      updatedAt: new Date('2026-07-23T00:00:00Z'),
    };
    const update = vi.fn().mockResolvedValue(row);
    const db = { lead: { update } } as unknown as Prisma.TransactionClient;

    const result = await updateLeadFields(db, { id: 'lead-1', fullName: 'New Name' });

    expect(result).toBe(row);
    expect(Object.keys(result).sort()).toEqual(LEAD_RECORD_KEYS);
  });
});

describe('updateLeadStatusWithHistory', () => {
  it('nests the LeadStatusHistory row inside the status update', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'lead-1', status: 'QUALIFIED' });
    const db = { lead: { update } } as unknown as Prisma.TransactionClient;

    await updateLeadStatusWithHistory(db, {
      id: 'lead-1',
      previousStatus: 'CONTACTED',
      newStatus: 'QUALIFIED',
      changedByUserId: 'actor-1',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: {
        status: 'QUALIFIED',
        statusHistory: {
          create: expect.objectContaining({
            previousStatus: 'CONTACTED',
            newStatus: 'QUALIFIED',
            changedByUserId: 'actor-1',
          }),
        },
      },
      select: expect.any(Object),
    });
  });

  it('returns the exact pre-D-023 (afe1201) shape, with no assignment key (Stage 2 correction: PUT /api/leads/[id]/status must never gain assignment)', async () => {
    const row = {
      id: 'lead-1',
      status: 'QUALIFIED',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
      source: 'Walk-in',
      notes: null,
      clientId: null,
      createdAt: new Date('2026-07-23T00:00:00Z'),
      updatedAt: new Date('2026-07-23T00:00:00Z'),
    };
    const update = vi.fn().mockResolvedValue(row);
    const db = { lead: { update } } as unknown as Prisma.TransactionClient;

    const result = await updateLeadStatusWithHistory(db, {
      id: 'lead-1',
      previousStatus: 'CONTACTED',
      newStatus: 'QUALIFIED',
      changedByUserId: 'actor-1',
    });

    expect(result).toBe(row);
    expect(Object.keys(result).sort()).toEqual(LEAD_RECORD_KEYS);
  });
});

describe('findDuplicateLeadMatches', () => {
  it('returns no query when neither normalizedEmail nor normalizedPhone is supplied', async () => {
    const findMany = vi.fn();
    const db = { lead: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await findDuplicateLeadMatches(db, {});

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('composes an OR across supplied normalized fields and excludes the current lead on edit', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { lead: { findMany } } as unknown as Prisma.TransactionClient;

    await findDuplicateLeadMatches(db, {
      normalizedEmail: 'juan@example.com',
      normalizedPhone: '639171234567',
      excludeId: 'lead-1',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ normalizedEmail: 'juan@example.com' }, { normalizedPhone: '639171234567' }],
        id: { not: 'lead-1' },
      },
      select: expect.any(Object),
    });
  });

  it('collapses a record matching both email and phone into a single row with both channels', async () => {
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
    });

    expect(result).toEqual([
      { id: 'lead-2', fullName: 'Maria', status: 'NEW', matchedOn: ['EMAIL', 'PHONE'] },
    ]);
  });

  it('does not include excludeId in the where clause at creation time (omitted)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { lead: { findMany } } as unknown as Prisma.TransactionClient;

    await findDuplicateLeadMatches(db, { normalizedEmail: 'juan@example.com' });

    expect(findMany).toHaveBeenCalledWith({
      where: { OR: [{ normalizedEmail: 'juan@example.com' }] },
      select: expect.any(Object),
    });
  });
});

describe('findDuplicateClientMatches', () => {
  it('returns no query when neither normalized field is supplied', async () => {
    const findMany = vi.fn();
    const db = { client: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await findDuplicateClientMatches(db, {});

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('never applies an excludeId filter (Client rows are never excluded)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { client: { findMany } } as unknown as Prisma.TransactionClient;

    await findDuplicateClientMatches(db, { normalizedPhone: '639171234567' });

    expect(findMany).toHaveBeenCalledWith({
      where: { OR: [{ normalizedPhone: '639171234567' }] },
      select: expect.any(Object),
    });
  });
});

describe('insertAuditLog', () => {
  it('writes the supplied entry', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'LEAD_CREATED',
      entityType: 'Lead',
      entityId: 'lead-1',
      afterState: { status: 'NEW' },
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'actor-1',
        action: 'LEAD_CREATED',
        entityType: 'Lead',
        entityId: 'lead-1',
        afterState: { status: 'NEW' },
      }),
    });
  });
});

describe('listLeadStatusHistory', () => {
  it('scopes the query by leadId and orders createdAt desc, id desc (D-023 §8)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = {
      leadStatusHistory: { findMany, count },
    } as unknown as Prisma.TransactionClient;

    await listLeadStatusHistory(db, { leadId: 'lead-1', skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where: { leadId: 'lead-1' },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 0,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: { leadId: 'lead-1' } });
  });

  it('applies pagination skip/take', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = {
      leadStatusHistory: { findMany, count },
    } as unknown as Prisma.TransactionClient;

    await listLeadStatusHistory(db, { leadId: 'lead-1', skip: 40, take: 20 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
  });

  it('maps changedBy to changedByName, never including a reason field', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'history-1',
        previousStatus: null,
        newStatus: 'NEW',
        changedByUserId: 'actor-1',
        changedBy: { name: 'Admin Manager' },
        createdAt: new Date('2026-07-23T00:00:00Z'),
      },
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const db = {
      leadStatusHistory: { findMany, count },
    } as unknown as Prisma.TransactionClient;

    const { items } = await listLeadStatusHistory(db, { leadId: 'lead-1', skip: 0, take: 20 });

    expect(items).toEqual([
      {
        id: 'history-1',
        previousStatus: null,
        newStatus: 'NEW',
        changedByUserId: 'actor-1',
        changedByName: 'Admin Manager',
        createdAt: new Date('2026-07-23T00:00:00Z'),
      },
    ]);
    expect(Object.keys(items[0]!)).not.toContain('reason');
  });

  it('maps a null changedBy (no attributable actor) to changedByName: null', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'history-1',
        previousStatus: 'NEW',
        newStatus: 'UNDER_REVIEW',
        changedByUserId: null,
        changedBy: null,
        createdAt: new Date('2026-07-23T00:00:00Z'),
      },
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const db = {
      leadStatusHistory: { findMany, count },
    } as unknown as Prisma.TransactionClient;

    const { items } = await listLeadStatusHistory(db, { leadId: 'lead-1', skip: 0, take: 20 });

    expect(items[0]?.changedByName).toBeNull();
  });
});

describe('createClientFromLead', () => {
  it('sends exactly the authorized mapped fields and explicit null profile fields to Prisma', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'client-1', fullName: 'Juan' });
    const db = { client: { create } } as unknown as Prisma.TransactionClient;

    await createClientFromLead(db, {
      id: 'client-1',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        id: 'client-1',
        fullName: 'Juan',
        email: 'juan@example.com',
        phone: null,
        normalizedEmail: 'juan@example.com',
        normalizedPhone: null,
        notes: null,
        address: null,
        nationality: null,
        dateOfBirth: null,
        emergencyContact: null,
      },
      select: { id: true, fullName: true },
    });
  });

  it('never writes Lead notes or any other field beyond the allow-list, even if supplied', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'client-1', fullName: 'Juan' });
    const db = { client: { create } } as unknown as Prisma.TransactionClient;

    // Deliberately smuggling fields the declared parameter type forbids
    // (Lead.notes, a caller-supplied status) to prove the implementation's
    // explicit field-by-field mapping — never a spread of `input` — drops
    // them regardless of what a caller passes.
    const maliciousInput = {
      id: 'client-1',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
      notes: 'Called back once',
      status: 'QUALIFIED',
    } as unknown as CreateClientFromLeadInput;

    await createClientFromLead(db, maliciousInput);

    const dataArg = create.mock.calls[0]![0].data;
    expect(dataArg.notes).toBeNull();
    expect(Object.keys(dataArg).sort()).toEqual([
      'address',
      'dateOfBirth',
      'email',
      'emergencyContact',
      'fullName',
      'id',
      'nationality',
      'normalizedEmail',
      'normalizedPhone',
      'notes',
      'phone',
    ]);
  });

  it('returns only { id, fullName }', async () => {
    const row = { id: 'client-1', fullName: 'Juan' };
    const create = vi.fn().mockResolvedValue(row);
    const db = { client: { create } } as unknown as Prisma.TransactionClient;

    const result = await createClientFromLead(db, {
      id: 'client-1',
      fullName: 'Juan',
      email: null,
      phone: '639171234567',
      normalizedEmail: null,
      normalizedPhone: '639171234567',
    });

    expect(result).toBe(row);
    expect(Object.keys(result).sort()).toEqual(['fullName', 'id']);
  });
});

describe('findClientSummaryById', () => {
  it('selects only { id, fullName }', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1', fullName: 'Juan' });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientSummaryById(db, 'client-1');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'client-1' },
      select: { id: true, fullName: true },
    });
  });

  it('returns an existing row unchanged', async () => {
    const row = { id: 'client-1', fullName: 'Juan' };
    const findUnique = vi.fn().mockResolvedValue(row);
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientSummaryById(db, 'client-1');

    expect(result).toBe(row);
  });

  it('returns null unchanged when the Client does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientSummaryById(db, 'missing-client');

    expect(result).toBeNull();
  });
});

describe('convertLeadWithHistory', () => {
  it('performs the exact status/clientId/history nested write, hardcoding QUALIFIED -> CONVERTED_TO_CLIENT', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT' });
    const db = { lead: { update } } as unknown as Prisma.TransactionClient;

    await convertLeadWithHistory(db, {
      id: 'lead-1',
      clientId: 'client-1',
      changedByUserId: 'actor-1',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: {
        clientId: 'client-1',
        status: 'CONVERTED_TO_CLIENT',
        statusHistory: {
          create: expect.objectContaining({
            previousStatus: 'QUALIFIED',
            newStatus: 'CONVERTED_TO_CLIENT',
            changedByUserId: 'actor-1',
          }),
        },
      },
      select: expect.any(Object),
    });
  });

  it('returns the existing assignment-free LeadRecord shape, with no assignment key', async () => {
    const row = {
      id: 'lead-1',
      status: 'CONVERTED_TO_CLIENT',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
      source: 'Walk-in',
      notes: null,
      clientId: 'client-1',
      createdAt: new Date('2026-07-28T00:00:00Z'),
      updatedAt: new Date('2026-07-28T00:00:00Z'),
    };
    const update = vi.fn().mockResolvedValue(row);
    const db = { lead: { update } } as unknown as Prisma.TransactionClient;

    const result = await convertLeadWithHistory(db, {
      id: 'lead-1',
      clientId: 'client-1',
      changedByUserId: 'actor-1',
    });

    expect(result).toBe(row);
    expect(Object.keys(result).sort()).toEqual(LEAD_RECORD_KEYS);
  });
});

describe('findLeadConversionAudit', () => {
  it('filters by entityType Lead, entityId, and action LEAD_CONVERTED_TO_CLIENT, ordered createdAt desc then id desc', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { auditLog: { findFirst } } as unknown as Prisma.TransactionClient;

    await findLeadConversionAudit(db, 'lead-1');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        entityType: 'Lead',
        entityId: 'lead-1',
        action: 'LEAD_CONVERTED_TO_CLIENT',
      },
      select: { afterState: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('returns the row unchanged when found', async () => {
    const row = {
      afterState: { status: 'CONVERTED_TO_CLIENT', clientId: 'client-1', clientCreated: true },
    };
    const findFirst = vi.fn().mockResolvedValue(row);
    const db = { auditLog: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findLeadConversionAudit(db, 'lead-1');

    expect(result).toBe(row);
  });

  it('returns null unchanged when no conversion audit entry exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { auditLog: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findLeadConversionAudit(db, 'lead-1');

    expect(result).toBeNull();
  });
});

describe('Lead-to-Client conversion primitives never touch unrelated models', () => {
  it('never call staffAssignment, auditLog.create, user, proposal, booking, paymentPlan, visaCase, notification, portalInvitation, or clientProfile', async () => {
    const forbidden = {
      staffAssignmentCreate: vi.fn(),
      auditLogCreate: vi.fn(),
      userCreate: vi.fn(),
      proposalCreate: vi.fn(),
      bookingCreate: vi.fn(),
      paymentPlanCreate: vi.fn(),
      visaCaseCreate: vi.fn(),
      notificationCreate: vi.fn(),
      portalInvitationCreate: vi.fn(),
      clientProfileCreate: vi.fn(),
    };

    const db = {
      client: {
        create: vi.fn().mockResolvedValue({ id: 'client-1', fullName: 'Juan' }),
        findUnique: vi.fn().mockResolvedValue({ id: 'client-1', fullName: 'Juan' }),
      },
      lead: {
        update: vi.fn().mockResolvedValue({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT' }),
      },
      auditLog: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: forbidden.auditLogCreate,
      },
      staffAssignment: { create: forbidden.staffAssignmentCreate },
      user: { create: forbidden.userCreate },
      proposal: { create: forbidden.proposalCreate },
      booking: { create: forbidden.bookingCreate },
      paymentPlan: { create: forbidden.paymentPlanCreate },
      visaCase: { create: forbidden.visaCaseCreate },
      notification: { create: forbidden.notificationCreate },
      portalInvitation: { create: forbidden.portalInvitationCreate },
      clientProfile: { create: forbidden.clientProfileCreate },
    } as unknown as Prisma.TransactionClient;

    await createClientFromLead(db, {
      id: 'client-1',
      fullName: 'Juan',
      email: 'juan@example.com',
      phone: null,
      normalizedEmail: 'juan@example.com',
      normalizedPhone: null,
    });
    await findClientSummaryById(db, 'client-1');
    await convertLeadWithHistory(db, {
      id: 'lead-1',
      clientId: 'client-1',
      changedByUserId: 'actor-1',
    });
    await findLeadConversionAudit(db, 'lead-1');

    for (const spy of Object.values(forbidden)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
