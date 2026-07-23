import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import {
  createLeadWithInitialHistory,
  findDuplicateClientMatches,
  findDuplicateLeadMatches,
  findLeadById,
  insertAuditLog,
  listLeadsForActor,
  updateLeadFields,
  updateLeadStatusWithHistory,
} from './repository';

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
