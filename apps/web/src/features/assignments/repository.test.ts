import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import {
  createAssignment,
  endAssignmentById,
  findActiveAssignmentForBooking,
  findActiveAssignmentForClient,
  findActiveAssignmentForLead,
  findActiveConsultantNameForClient,
  findAssigneeCandidateById,
  findBookingById,
  findClientById,
  findClientProfileOwnership,
  findLeadById,
  insertAuditLog,
  listEligibleTravelConsultants,
} from './repository';

// D-032 §6 (F-Repo): direct unit coverage for all 12 of this repository's
// exported functions. `findClientProfileOwnership` and
// `listEligibleTravelConsultants` were already covered here before D-032.
// The other ten — the two D-031 F-01 transaction-local security-recheck
// primitives (`findActiveAssignmentForLead`/`findActiveAssignmentForClient`),
// the Booking equivalent, both assignment-mutation primitives
// (`createAssignment`/`endAssignmentById`), the three plain existence
// lookups, and `insertAuditLog` — previously had 0% executed-code coverage
// under `pnpm test`: `assignments/service.test.ts` mocks this entire
// `./repository` module (`vi.mock('./repository', () => repositoryMocks)`),
// so none of their real bodies were ever exercised by any mocked-tier test,
// and their only prior verification was the real-PostgreSQL tier, which CI
// never runs. Each test below constructs a hand-built, minimal mocked
// Prisma client (never a real database), mirroring
// features/leads/repository.test.ts's/features/clients/repository.test.ts's
// established pattern — proving exact query shape and pass-through
// behavior, not database semantics (that remains the real-PostgreSQL
// tier's job elsewhere).
describe('findClientProfileOwnership', () => {
  it('scopes the Prisma query by both userId and clientId in the query itself, not by fetching one and comparing after', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'profile-1' });
    const db = { clientProfile: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findClientProfileOwnership(db, 'user-1', 'client-1');

    expect(result).toEqual({ id: 'profile-1' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', clientId: 'client-1' },
      select: { id: true },
    });
  });

  it('returns null when no ClientProfile matches both the given userId and clientId', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { clientProfile: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findClientProfileOwnership(db, 'user-1', 'someone-elses-client');

    expect(result).toBeNull();
  });
});

describe('listEligibleTravelConsultants', () => {
  it('scopes the query to active TRAVEL_CONSULTANT accounts only, ordered by name then id (D-023 §6)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { user: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listEligibleTravelConsultants(db, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where: { role: 'TRAVEL_CONSULTANT', isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: 0,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: { role: 'TRAVEL_CONSULTANT', isActive: true } });
  });

  it('composes a case-insensitive name/email search into the where clause', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { user: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listEligibleTravelConsultants(db, { search: 'maria', skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: 'TRAVEL_CONSULTANT',
          isActive: true,
          OR: [
            { name: { contains: 'maria', mode: 'insensitive' } },
            { email: { contains: 'maria', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  it('applies pagination skip/take', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { user: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listEligibleTravelConsultants(db, { skip: 40, take: 20 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
  });

  it('returns the items and total unchanged from Prisma', async () => {
    const items = [{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }];
    const findMany = vi.fn().mockResolvedValue(items);
    const count = vi.fn().mockResolvedValue(1);
    const db = { user: { findMany, count } } as unknown as Prisma.TransactionClient;

    const result = await listEligibleTravelConsultants(db, { skip: 0, take: 20 });

    expect(result).toEqual({ items, total: 1 });
  });
});

// The exact `ASSIGNMENT_SELECT` shape `repository.ts` uses internally
// (private, not exported) — duplicated here deliberately, matching this
// file's own existing precedent of asserting the literal query shape a
// caller receives, never importing the module's private implementation
// detail.
const ASSIGNMENT_SELECT = {
  id: true,
  assignedStaffId: true,
  assignedByUserId: true,
  leadId: true,
  clientId: true,
  bookingId: true,
  createdAt: true,
  updatedAt: true,
  endedAt: true,
};

describe('findActiveAssignmentForLead', () => {
  it('scopes the query by leadId and endedAt: null directly in the query itself, never fetch-then-filter', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'assignment-1' });
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findActiveAssignmentForLead(db, 'lead-1');

    expect(result).toEqual({ id: 'assignment-1' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { leadId: 'lead-1', endedAt: null },
      select: ASSIGNMENT_SELECT,
    });
  });

  it('returns null unchanged when no active assignment matches', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findActiveAssignmentForLead(db, 'lead-missing');

    expect(result).toBeNull();
  });
});

describe('findActiveAssignmentForClient', () => {
  it('scopes the query by clientId and endedAt: null directly in the query itself, never fetch-then-filter', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'assignment-1' });
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findActiveAssignmentForClient(db, 'client-1');

    expect(result).toEqual({ id: 'assignment-1' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { clientId: 'client-1', endedAt: null },
      select: ASSIGNMENT_SELECT,
    });
  });

  it('returns null unchanged when no active assignment matches', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findActiveAssignmentForClient(db, 'client-missing');

    expect(result).toBeNull();
  });
});

describe('findActiveAssignmentForBooking', () => {
  it('scopes the query by bookingId and endedAt: null directly in the query itself, never fetch-then-filter', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'assignment-1' });
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findActiveAssignmentForBooking(db, 'booking-1');

    expect(result).toEqual({ id: 'assignment-1' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { bookingId: 'booking-1', endedAt: null },
      select: ASSIGNMENT_SELECT,
    });
  });

  it('returns null unchanged when no active assignment matches', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findActiveAssignmentForBooking(db, 'booking-missing');

    expect(result).toBeNull();
  });
});

describe('createAssignment', () => {
  it('writes exactly the supplied fields, no more, and returns the row via the existing ASSIGNMENT_SELECT shape', async () => {
    const created = {
      id: 'assignment-1',
      assignedStaffId: 'staff-1',
      assignedByUserId: 'admin-1',
      leadId: 'lead-1',
      clientId: null,
      bookingId: null,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      endedAt: null,
    };
    const create = vi.fn().mockResolvedValue(created);
    const db = { staffAssignment: { create } } as unknown as Prisma.TransactionClient;

    const result = await createAssignment(db, {
      id: 'assignment-1',
      assignedStaffId: 'staff-1',
      assignedByUserId: 'admin-1',
      leadId: 'lead-1',
    });

    expect(result).toEqual(created);
    expect(create).toHaveBeenCalledWith({
      data: {
        id: 'assignment-1',
        assignedStaffId: 'staff-1',
        assignedByUserId: 'admin-1',
        leadId: 'lead-1',
        clientId: undefined,
        bookingId: undefined,
      },
      select: ASSIGNMENT_SELECT,
    });
  });
});

describe('endAssignmentById', () => {
  it('sets endedAt to a real Date and never deletes the row', async () => {
    const ended = { id: 'assignment-1', endedAt: new Date('2026-08-01T00:00:00.000Z') };
    const update = vi.fn().mockResolvedValue(ended);
    const db = { staffAssignment: { update } } as unknown as Prisma.TransactionClient;

    const result = await endAssignmentById(db, 'assignment-1');

    expect(result).toEqual(ended);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'assignment-1' },
      data: { endedAt: expect.any(Date) },
      select: ASSIGNMENT_SELECT,
    });
  });
});

describe('findLeadById', () => {
  it('selects only { id: true }', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'lead-1' });
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    await findLeadById(db, 'lead-1');

    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'lead-1' }, select: { id: true } });
  });

  it('returns the row unchanged when found', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'lead-1' });
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findLeadById(db, 'lead-1');

    expect(result).toEqual({ id: 'lead-1' });
  });

  it('returns null unchanged when the Lead does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { lead: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findLeadById(db, 'lead-missing');

    expect(result).toBeNull();
  });
});

describe('findClientById', () => {
  it('selects only { id: true }', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1' });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    await findClientById(db, 'client-1');

    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'client-1' }, select: { id: true } });
  });

  it('returns the row unchanged when found', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'client-1' });
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientById(db, 'client-1');

    expect(result).toEqual({ id: 'client-1' });
  });

  it('returns null unchanged when the Client does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { client: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findClientById(db, 'client-missing');

    expect(result).toBeNull();
  });
});

describe('findBookingById', () => {
  it('selects only { id: true }', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'booking-1' });
    const db = { booking: { findUnique } } as unknown as Prisma.TransactionClient;

    await findBookingById(db, 'booking-1');

    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'booking-1' }, select: { id: true } });
  });

  it('returns the row unchanged when found', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'booking-1' });
    const db = { booking: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findBookingById(db, 'booking-1');

    expect(result).toEqual({ id: 'booking-1' });
  });

  it('returns null unchanged when the Booking does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { booking: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findBookingById(db, 'booking-missing');

    expect(result).toBeNull();
  });
});

describe('findAssigneeCandidateById', () => {
  it('selects only { id, role, isActive }', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ id: 'tc-1', role: 'TRAVEL_CONSULTANT', isActive: true });
    const db = { user: { findUnique } } as unknown as Prisma.TransactionClient;

    await findAssigneeCandidateById(db, 'tc-1');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'tc-1' },
      select: { id: true, role: true, isActive: true },
    });
  });

  it('returns the resolved candidate row unchanged when found', async () => {
    const candidate = { id: 'tc-1', role: 'TRAVEL_CONSULTANT', isActive: true };
    const findUnique = vi.fn().mockResolvedValue(candidate);
    const db = { user: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findAssigneeCandidateById(db, 'tc-1');

    expect(result).toEqual(candidate);
  });

  it('returns null unchanged when no User matches', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { user: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findAssigneeCandidateById(db, 'user-missing');

    expect(result).toBeNull();
  });
});

describe('insertAuditLog', () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('writes a generated UUID-shaped id (never a fixed value) plus exactly the supplied actorId/action/entityType/entityId', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'LEAD_ASSIGNMENT_CREATED',
      entityType: 'Lead',
      entityId: 'lead-1',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.id).toEqual(expect.stringMatching(UUID_PATTERN));
    expect(call.data.actorId).toBe('actor-1');
    expect(call.data.action).toBe('LEAD_ASSIGNMENT_CREATED');
    expect(call.data.entityType).toBe('Lead');
    expect(call.data.entityId).toBe('lead-1');
  });

  it('generates a different id on every call', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, { actorId: 'a', action: 'X', entityType: 'Lead', entityId: '1' });
    await insertAuditLog(db, { actorId: 'a', action: 'X', entityType: 'Lead', entityId: '1' });

    const firstId = (create.mock.calls[0]![0] as { data: { id: string } }).data.id;
    const secondId = (create.mock.calls[1]![0] as { data: { id: string } }).data.id;
    expect(firstId).not.toBe(secondId);
  });

  it('preserves supplied beforeState/afterState values exactly, unchanged', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;
    const beforeState = { assignedStaffId: 'staff-old' };
    const afterState = { assignedStaffId: 'staff-new' };

    await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'LEAD_ASSIGNMENT_REPLACED',
      entityType: 'Lead',
      entityId: 'lead-1',
      beforeState,
      afterState,
    });

    const call = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data.beforeState).toEqual(beforeState);
    expect(call.data.afterState).toEqual(afterState);
  });

  it('keeps beforeState and afterState explicitly present with value undefined when omitted, never fabricating null or {}', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'LEAD_ASSIGNMENT_CREATED',
      entityType: 'Lead',
      entityId: 'lead-1',
    });

    const call = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(Object.hasOwn(call.data, 'beforeState')).toBe(true);
    expect(Object.hasOwn(call.data, 'afterState')).toBe(true);
    expect(call.data.beforeState).toBeUndefined();
    expect(call.data.afterState).toBeUndefined();
  });

  it('resolves to undefined, fabricating no domain object of its own', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'ignored-return-value' });
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    const result = await insertAuditLog(db, {
      actorId: 'actor-1',
      action: 'LEAD_ASSIGNMENT_CREATED',
      entityType: 'Lead',
      entityId: 'lead-1',
    });

    expect(result).toBeUndefined();
  });
});

// --- Client-portal read (D-040 §§3, 7 Contract F) ---

describe('findActiveConsultantNameForClient', () => {
  it('scopes by clientId and endedAt: null in the query itself, selecting only the staff name', async () => {
    const findFirst = vi.fn().mockResolvedValue({ assignedStaff: { name: 'Maria Santos' } });
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findActiveConsultantNameForClient(db, 'client-1');

    expect(findFirst).toHaveBeenCalledWith({
      where: { clientId: 'client-1', endedAt: null },
      select: { assignedStaff: { select: { name: true } } },
    });
    expect(result).toEqual({ name: 'Maria Santos' });
  });

  it('never selects the assignment row id, the staff id, or the staff email', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    await findActiveConsultantNameForClient(db, 'client-1');

    const select = findFirst.mock.calls[0]![0].select as {
      assignedStaff: { select: Record<string, unknown> };
    };
    expect(Object.keys(select.assignedStaff.select)).toEqual(['name']);
    expect(select).not.toHaveProperty('id');
    expect(select).not.toHaveProperty('assignedStaffId');
  });

  it('returns null when the client has no active assignment', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { staffAssignment: { findFirst } } as unknown as Prisma.TransactionClient;

    expect(await findActiveConsultantNameForClient(db, 'client-1')).toBeNull();
  });
});
