import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import {
  createLeadWithInitialHistory,
  findDuplicateClientMatches,
  findDuplicateLeadMatches,
  findLeadById,
  findLeadByIdForRead,
  insertAuditLog,
  listLeadsForActor,
  listLeadStatusHistory,
  updateLeadFields,
  updateLeadStatusWithHistory,
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
