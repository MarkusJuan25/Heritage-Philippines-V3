import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import {
  createBookingWithInitialHistory,
  findBookingByIdForActor,
  findBookingByProposalVersionIdForActor,
  findEligibleProposalVersionForActor,
  insertAuditLog,
  listBookingsForActor,
} from './repository';

const ADMIN_MANAGER = { id: 'admin-1', role: 'ADMIN_MANAGER' as const };
const TRAVEL_CONSULTANT = { id: 'tc-1', role: 'TRAVEL_CONSULTANT' as const };

const BOOKING_ID = 'booking-1';
const PROPOSAL_VERSION_ID = 'pv-1';

const TC_ASSIGNMENT_FILTER = {
  assignments: { some: { assignedStaffId: TRAVEL_CONSULTANT.id, endedAt: null } },
};

describe('findBookingByProposalVersionIdForActor', () => {
  it('scopes the query with no Client filter for ADMIN_MANAGER (unconditional access)', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: BOOKING_ID });
    const db = { booking: { findFirst } } as unknown as Prisma.TransactionClient;

    await findBookingByProposalVersionIdForActor(db, ADMIN_MANAGER, PROPOSAL_VERSION_ID);

    expect(findFirst).toHaveBeenCalledWith({
      where: { proposalVersionId: PROPOSAL_VERSION_ID, client: undefined },
      select: expect.any(Object),
    });
  });

  it('scopes the query with the active-assignment filter for TRAVEL_CONSULTANT', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { booking: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findBookingByProposalVersionIdForActor(
      db,
      TRAVEL_CONSULTANT,
      PROPOSAL_VERSION_ID,
    );

    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { proposalVersionId: PROPOSAL_VERSION_ID, client: TC_ASSIGNMENT_FILTER },
      select: expect.any(Object),
    });
  });
});

describe('findBookingByIdForActor', () => {
  it('scopes by id only for ADMIN_MANAGER', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: BOOKING_ID });
    const db = { booking: { findFirst } } as unknown as Prisma.TransactionClient;

    await findBookingByIdForActor(db, ADMIN_MANAGER, BOOKING_ID);

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, client: undefined },
      select: expect.any(Object),
    });
  });

  it('scopes by id plus the active-assignment filter for TRAVEL_CONSULTANT', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { booking: { findFirst } } as unknown as Prisma.TransactionClient;

    await findBookingByIdForActor(db, TRAVEL_CONSULTANT, BOOKING_ID);

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, client: TC_ASSIGNMENT_FILTER },
      select: expect.any(Object),
    });
  });
});

describe('listBookingsForActor', () => {
  it('runs one findMany and one count with no Client filter for ADMIN_MANAGER, applying pagination', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: BOOKING_ID }]);
    const count = vi.fn().mockResolvedValue(1);
    const db = { booking: { findMany, count } } as unknown as Prisma.TransactionClient;

    const result = await listBookingsForActor(db, ADMIN_MANAGER, { skip: 20, take: 10 });

    expect(result).toEqual({ items: [{ id: BOOKING_ID }], total: 1 });
    expect(findMany).toHaveBeenCalledWith({
      where: { client: undefined },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 20,
      take: 10,
    });
    expect(count).toHaveBeenCalledWith({ where: { client: undefined } });
  });

  it('scopes both findMany and count by the active-assignment filter for TRAVEL_CONSULTANT', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { booking: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listBookingsForActor(db, TRAVEL_CONSULTANT, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { client: TC_ASSIGNMENT_FILTER } }),
    );
    expect(count).toHaveBeenCalledWith({ where: { client: TC_ASSIGNMENT_FILTER } });
  });

  it('issues exactly two concurrent operations via Promise.all (one findMany, one count), never a per-row query', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: '1' }, { id: '2' }]);
    const count = vi.fn().mockResolvedValue(2);
    const db = { booking: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listBookingsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
  });
});

describe('findEligibleProposalVersionForActor', () => {
  it('applies no Proposal/Client filter for ADMIN_MANAGER', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: PROPOSAL_VERSION_ID,
      proposal: { clientId: 'client-1' },
      acceptance: { responseType: 'ACCEPT' },
    });
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findEligibleProposalVersionForActor(
      db,
      ADMIN_MANAGER,
      PROPOSAL_VERSION_ID,
    );

    expect(result).toEqual({
      id: PROPOSAL_VERSION_ID,
      clientId: 'client-1',
      hasAcceptedAcceptance: true,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: PROPOSAL_VERSION_ID, proposal: { client: undefined } },
      select: expect.any(Object),
    });
  });

  it('scopes the query through Proposal -> Client -> assignments for TRAVEL_CONSULTANT', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findEligibleProposalVersionForActor(
      db,
      TRAVEL_CONSULTANT,
      PROPOSAL_VERSION_ID,
    );

    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: PROPOSAL_VERSION_ID, proposal: { client: TC_ASSIGNMENT_FILTER } },
      select: expect.any(Object),
    });
  });

  it('reports hasAcceptedAcceptance: false when there is no ProposalAcceptance at all', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: PROPOSAL_VERSION_ID,
      proposal: { clientId: 'client-1' },
      acceptance: null,
    });
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findEligibleProposalVersionForActor(
      db,
      ADMIN_MANAGER,
      PROPOSAL_VERSION_ID,
    );

    expect(result?.hasAcceptedAcceptance).toBe(false);
  });

  it.each(['DECLINE', 'REQUEST_CHANGES'])(
    'reports hasAcceptedAcceptance: false for a %s response',
    async (responseType) => {
      const findFirst = vi.fn().mockResolvedValue({
        id: PROPOSAL_VERSION_ID,
        proposal: { clientId: 'client-1' },
        acceptance: { responseType },
      });
      const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

      const result = await findEligibleProposalVersionForActor(
        db,
        ADMIN_MANAGER,
        PROPOSAL_VERSION_ID,
      );

      expect(result?.hasAcceptedAcceptance).toBe(false);
    },
  );

  it('never selects clientVisibleAt or supersededAt — no current/non-superseded invariant is inferred for Booking-creation eligibility', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: PROPOSAL_VERSION_ID,
      proposal: { clientId: 'client-1' },
      acceptance: { responseType: 'ACCEPT' },
    });
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    await findEligibleProposalVersionForActor(db, ADMIN_MANAGER, PROPOSAL_VERSION_ID);

    const callArgs = findFirst.mock.calls[0]?.[0] as { select: Record<string, unknown> };
    expect(callArgs.select).not.toHaveProperty('clientVisibleAt');
    expect(callArgs.select).not.toHaveProperty('supersededAt');
  });
});

describe('createBookingWithInitialHistory', () => {
  it('creates the Booking with status DRAFT and a nested initial BookingStatusHistory row in one write', async () => {
    const create = vi.fn().mockResolvedValue({ id: BOOKING_ID, status: 'DRAFT' });
    const db = { booking: { create } } as unknown as Prisma.TransactionClient;

    await createBookingWithInitialHistory(db, {
      id: BOOKING_ID,
      bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD',
      clientId: 'client-1',
      proposalVersionId: PROPOSAL_VERSION_ID,
      changedByUserId: 'admin-1',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        id: BOOKING_ID,
        bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD',
        clientId: 'client-1',
        proposalVersionId: PROPOSAL_VERSION_ID,
        status: 'DRAFT',
        statusHistory: {
          create: {
            id: expect.any(String),
            previousStatus: null,
            newStatus: 'DRAFT',
            changedByUserId: 'admin-1',
          },
        },
      },
      select: expect.any(Object),
    });
  });
});

describe('insertAuditLog', () => {
  it('inserts a single AuditLog row with the given fields', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, {
      actorId: 'admin-1',
      action: 'BOOKING_CREATED',
      entityType: 'Booking',
      entityId: BOOKING_ID,
      afterState: { id: BOOKING_ID },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        actorId: 'admin-1',
        action: 'BOOKING_CREATED',
        entityType: 'Booking',
        entityId: BOOKING_ID,
        beforeState: undefined,
        afterState: { id: BOOKING_ID },
      },
    });
  });
});
