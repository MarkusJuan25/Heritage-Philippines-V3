import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db` (transitively, via
// @/lib/serializable-transaction), which eagerly validates env vars and
// opens a real database adapter at import time. Mock it before `./service`
// is imported — the same reason features/staff/service.test.ts mocks it.
// `runSerializableWithRetry` itself is intentionally left unmocked (real
// implementation), so these tests exercise the real retry/backoff logic
// composed with a mocked `$transaction` — mirroring
// features/staff/service.test.ts's approach before the helper was
// extracted to @/lib/serializable-transaction.
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: transactionMock } }));

const repositoryMocks = vi.hoisted(() => ({
  findLeadById: vi.fn(),
  findClientById: vi.fn(),
  findBookingById: vi.fn(),
  findAssigneeCandidateById: vi.fn(),
  findActiveAssignmentForLead: vi.fn(),
  findActiveAssignmentForClient: vi.fn(),
  findActiveAssignmentForBooking: vi.fn(),
  createAssignment: vi.fn(),
  endAssignmentById: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import type { AssignmentRecord } from './repository';
import {
  endClientAssignment,
  endLeadAssignment,
  setBookingAssignment,
  setClientAssignment,
  setLeadAssignment,
} from './service';

const TX_CLIENT = { marker: 'tx-client' };

const ACTOR: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};

const LEAD_ID = 'lead-1';
const CLIENT_ID = 'client-1';
const BOOKING_ID = 'booking-1';
const STAFF_ID = 'staff-1';

function assignmentRecord(overrides: Partial<AssignmentRecord> = {}): AssignmentRecord {
  return {
    id: 'assignment-1',
    assignedStaffId: STAFF_ID,
    assignedByUserId: ACTOR.id,
    leadId: LEAD_ID,
    clientId: null,
    bookingId: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    endedAt: null,
    ...overrides,
  };
}

function eligibleAssignee(
  overrides: Partial<{ id: string; role: string; isActive: boolean }> = {},
) {
  return { id: STAFF_ID, role: 'TRAVEL_CONSULTANT', isActive: true, ...overrides };
}

function conflictError(code: 'P2034' | 'P2002' | 'P2004'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Simulated database conflict', {
    code,
    clientVersion: '7.8.0',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
  repositoryMocks.findLeadById.mockResolvedValue({ id: LEAD_ID });
  repositoryMocks.findClientById.mockResolvedValue({ id: CLIENT_ID });
  repositoryMocks.findBookingById.mockResolvedValue({ id: BOOKING_ID });
});

describe('setLeadAssignment', () => {
  it('throws LEAD_NOT_FOUND when the lead does not exist, without checking the assignee', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(null);

    await expect(setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'LEAD_NOT_FOUND',
      status: 404,
    });
    expect(repositoryMocks.findAssigneeCandidateById).not.toHaveBeenCalled();
  });

  it('throws ASSIGNEE_NOT_FOUND when the assignee does not resolve to any account', async () => {
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(null);

    await expect(setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'ASSIGNEE_NOT_FOUND',
      status: 404,
    });
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  });

  it('throws ASSIGNEE_INACTIVE when the assignee account is deactivated', async () => {
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(
      eligibleAssignee({ isActive: false }),
    );

    await expect(setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'ASSIGNEE_INACTIVE',
      status: 409,
    });
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  });

  it.each([
    'CLIENT',
    'ADMIN_MANAGER',
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'SYSTEM_ADMINISTRATOR',
  ])('throws ASSIGNEE_INELIGIBLE_ROLE when the assignee holds role %s', async (role) => {
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee({ role }));

    await expect(setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'ASSIGNEE_INELIGIBLE_ROLE',
      status: 409,
    });
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  });

  it('creates the initial assignment when none is active, without requiring a reason, and writes a CREATED audit entry', async () => {
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee());
    const created = assignmentRecord();
    repositoryMocks.createAssignment.mockResolvedValue(created);

    const result = await setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID);

    expect(result).toEqual(created);
    expect(repositoryMocks.endAssignmentById).not.toHaveBeenCalled();
    expect(repositoryMocks.createAssignment).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      assignedStaffId: STAFF_ID,
      assignedByUserId: ACTOR.id,
      leadId: LEAD_ID,
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'LEAD_ASSIGNMENT_CREATED',
      entityType: 'Lead',
      entityId: LEAD_ID,
      beforeState: undefined,
      afterState: {
        id: created.id,
        assignedStaffId: STAFF_ID,
        assignedByUserId: ACTOR.id,
        leadId: LEAD_ID,
        clientId: null,
        bookingId: null,
        endedAt: null,
      },
    });
  });

  it('is idempotent: assigning the already-active consultant again is a no-op with no eligibility check, no new row, and no audit entry', async () => {
    const active = assignmentRecord({ assignedStaffId: STAFF_ID });
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(active);

    const result = await setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID);

    expect(result).toEqual(active);
    expect(repositoryMocks.findAssigneeCandidateById).not.toHaveBeenCalled();
    expect(repositoryMocks.endAssignmentById).not.toHaveBeenCalled();
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('throws REASON_REQUIRED when replacing an active assignment without a reason', async () => {
    const active = assignmentRecord({ assignedStaffId: 'other-staff' });
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(active);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee());

    await expect(setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
      status: 409,
    });
    expect(repositoryMocks.endAssignmentById).not.toHaveBeenCalled();
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  });

  it('atomically ends the previous assignment and creates the replacement when reassigning with a reason', async () => {
    const previous = assignmentRecord({ id: 'assignment-old', assignedStaffId: 'other-staff' });
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(previous);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee());
    const created = assignmentRecord({ id: 'assignment-new' });
    repositoryMocks.createAssignment.mockResolvedValue(created);

    const result = await setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID, 'Rebalancing workload');

    expect(result).toEqual(created);
    expect(repositoryMocks.endAssignmentById).toHaveBeenCalledWith(TX_CLIENT, previous.id);
    expect(repositoryMocks.createAssignment).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      assignedStaffId: STAFF_ID,
      assignedByUserId: ACTOR.id,
      leadId: LEAD_ID,
    });
    // Both the end and the create happened inside the single $transaction
    // callback — never as two separate top-level transactions.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'LEAD_ASSIGNMENT_REPLACED',
      entityType: 'Lead',
      entityId: LEAD_ID,
      beforeState: {
        id: previous.id,
        assignedStaffId: 'other-staff',
        assignedByUserId: ACTOR.id,
        leadId: LEAD_ID,
        clientId: null,
        bookingId: null,
        endedAt: null,
      },
      afterState: {
        id: created.id,
        assignedStaffId: STAFF_ID,
        assignedByUserId: ACTOR.id,
        leadId: LEAD_ID,
        clientId: null,
        bookingId: null,
        endedAt: null,
        reason: 'Rebalancing workload',
      },
    });
  });

  it('maps a serialization conflict that survives every retry to ASSIGNMENT_CONFLICT, never a raw Prisma error', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2034');
    });

    await expect(setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'ASSIGNMENT_CONFLICT',
      status: 409,
    });
    expect(transactionMock).toHaveBeenCalledTimes(3);
  });

  it('maps a unique-constraint conflict (P2002) to ASSIGNMENT_CONFLICT', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2002');
    });

    await expect(setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'ASSIGNMENT_CONFLICT',
      status: 409,
    });
    // P2002 is not a serialization conflict, so it is not retried.
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows an unrelated, unexpected error unchanged rather than mapping it to ASSIGNMENT_CONFLICT', async () => {
    const unexpected = new Error('unexpected internal failure');
    transactionMock.mockImplementation(async () => {
      throw unexpected;
    });

    await expect(setLeadAssignment(ACTOR, LEAD_ID, STAFF_ID)).rejects.toBe(unexpected);
  });
});

describe('endLeadAssignment', () => {
  it('throws LEAD_NOT_FOUND when the lead does not exist', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(null);

    await expect(endLeadAssignment(ACTOR, LEAD_ID, 'Archiving lead')).rejects.toMatchObject({
      code: 'LEAD_NOT_FOUND',
      status: 404,
    });
  });

  it('is idempotent: ending when nothing is active returns null without a write or an audit entry', async () => {
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);

    const result = await endLeadAssignment(ACTOR, LEAD_ID, 'Archiving lead');

    expect(result).toBeNull();
    expect(repositoryMocks.endAssignmentById).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('ends the active assignment (setting endedAt) without deleting the row, and writes an ENDED audit entry including the reason', async () => {
    const active = assignmentRecord();
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(active);
    const ended = { ...active, endedAt: new Date('2026-07-20T10:00:00Z') };
    repositoryMocks.endAssignmentById.mockResolvedValue(ended);

    const result = await endLeadAssignment(ACTOR, LEAD_ID, 'Consultant left the team');

    expect(result).toEqual(ended);
    expect(repositoryMocks.endAssignmentById).toHaveBeenCalledWith(TX_CLIENT, active.id);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'LEAD_ASSIGNMENT_ENDED',
      entityType: 'Lead',
      entityId: LEAD_ID,
      beforeState: {
        id: active.id,
        assignedStaffId: STAFF_ID,
        assignedByUserId: ACTOR.id,
        leadId: LEAD_ID,
        clientId: null,
        bookingId: null,
        endedAt: null,
      },
      afterState: {
        id: ended.id,
        assignedStaffId: STAFF_ID,
        assignedByUserId: ACTOR.id,
        leadId: LEAD_ID,
        clientId: null,
        bookingId: null,
        endedAt: '2026-07-20T10:00:00.000Z',
        reason: 'Consultant left the team',
      },
    });
  });

  it('a repeated end request after the assignment is already ended does not create a duplicate audit entry', async () => {
    const active = assignmentRecord();
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValueOnce(active);
    repositoryMocks.endAssignmentById.mockResolvedValue({ ...active, endedAt: new Date() });

    await endLeadAssignment(ACTOR, LEAD_ID, 'Consultant left the team');
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledTimes(1);

    // Second call: the database now reflects "no active assignment".
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValueOnce(null);
    const secondResult = await endLeadAssignment(ACTOR, LEAD_ID, 'Consultant left the team');

    expect(secondResult).toBeNull();
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.endAssignmentById).toHaveBeenCalledTimes(1);
  });
});

describe('setClientAssignment / endClientAssignment (Client-target dispatch)', () => {
  it('setClientAssignment validates the Client (not Lead), targets clientId, and uses the Client action/entity names', async () => {
    repositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee());
    const created = assignmentRecord({ leadId: null, clientId: CLIENT_ID });
    repositoryMocks.createAssignment.mockResolvedValue(created);

    await setClientAssignment(ACTOR, CLIENT_ID, STAFF_ID);

    expect(repositoryMocks.findClientById).toHaveBeenCalledWith(TX_CLIENT, CLIENT_ID);
    expect(repositoryMocks.findLeadById).not.toHaveBeenCalled();
    expect(repositoryMocks.createAssignment).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      assignedStaffId: STAFF_ID,
      assignedByUserId: ACTOR.id,
      clientId: CLIENT_ID,
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        action: 'CLIENT_ASSIGNMENT_CREATED',
        entityType: 'Client',
        entityId: CLIENT_ID,
      }),
    );
  });

  it('setClientAssignment throws CLIENT_NOT_FOUND (not LEAD_NOT_FOUND) when the client does not exist', async () => {
    repositoryMocks.findClientById.mockResolvedValue(null);

    await expect(setClientAssignment(ACTOR, CLIENT_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
      status: 404,
    });
  });

  it('endClientAssignment ends the active Client assignment and writes a CLIENT_ASSIGNMENT_ENDED audit entry', async () => {
    const active = assignmentRecord({ leadId: null, clientId: CLIENT_ID });
    repositoryMocks.findActiveAssignmentForClient.mockResolvedValue(active);
    repositoryMocks.endAssignmentById.mockResolvedValue({ ...active, endedAt: new Date() });

    const result = await endClientAssignment(ACTOR, CLIENT_ID, 'Client relationship ended');

    expect(result).not.toBeNull();
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        action: 'CLIENT_ASSIGNMENT_ENDED',
        entityType: 'Client',
        entityId: CLIENT_ID,
      }),
    );
  });
});

describe('setBookingAssignment (Booking-target dispatch)', () => {
  it('creates the initial Booking assignment, targeting bookingId (not leadId/clientId), with the Booking action/entity names', async () => {
    repositoryMocks.findActiveAssignmentForBooking.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee());
    const created = assignmentRecord({ leadId: null, clientId: null, bookingId: BOOKING_ID });
    repositoryMocks.createAssignment.mockResolvedValue(created);

    const result = await setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID);

    expect(result).toEqual(created);
    expect(repositoryMocks.findBookingById).toHaveBeenCalledWith(TX_CLIENT, BOOKING_ID);
    expect(repositoryMocks.findLeadById).not.toHaveBeenCalled();
    expect(repositoryMocks.findClientById).not.toHaveBeenCalled();
    expect(repositoryMocks.createAssignment).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      assignedStaffId: STAFF_ID,
      assignedByUserId: ACTOR.id,
      bookingId: BOOKING_ID,
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'BOOKING_ASSIGNMENT_CREATED',
      entityType: 'Booking',
      entityId: BOOKING_ID,
      beforeState: undefined,
      afterState: {
        id: created.id,
        assignedStaffId: STAFF_ID,
        assignedByUserId: ACTOR.id,
        leadId: null,
        clientId: null,
        bookingId: BOOKING_ID,
        endedAt: null,
      },
    });
  });

  it('is independent of any Client-level assignment: never checks or requires an active Client assignment', async () => {
    repositoryMocks.findActiveAssignmentForBooking.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee());
    repositoryMocks.createAssignment.mockResolvedValue(
      assignmentRecord({ leadId: null, clientId: null, bookingId: BOOKING_ID }),
    );

    await setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID);

    expect(repositoryMocks.findActiveAssignmentForClient).not.toHaveBeenCalled();
  });

  it('throws BOOKING_NOT_FOUND when the booking does not exist, without checking the assignee', async () => {
    repositoryMocks.findBookingById.mockResolvedValue(null);

    await expect(setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'BOOKING_NOT_FOUND',
      status: 404,
    });
    expect(repositoryMocks.findAssigneeCandidateById).not.toHaveBeenCalled();
  });

  it('throws ASSIGNEE_NOT_FOUND when the assignee does not resolve to any account', async () => {
    repositoryMocks.findActiveAssignmentForBooking.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(null);

    await expect(setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'ASSIGNEE_NOT_FOUND',
      status: 404,
    });
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  });

  it('throws ASSIGNEE_INACTIVE when the assignee account is deactivated', async () => {
    repositoryMocks.findActiveAssignmentForBooking.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(
      eligibleAssignee({ isActive: false }),
    );

    await expect(setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'ASSIGNEE_INACTIVE',
      status: 409,
    });
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  });

  it.each([
    'CLIENT',
    'ADMIN_MANAGER',
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'SYSTEM_ADMINISTRATOR',
  ])('throws ASSIGNEE_INELIGIBLE_ROLE when the assignee holds role %s', async (role) => {
    repositoryMocks.findActiveAssignmentForBooking.mockResolvedValue(null);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee({ role }));

    await expect(setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'ASSIGNEE_INELIGIBLE_ROLE',
      status: 409,
    });
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  });

  it('is idempotent: assigning the already-active consultant again is a no-op with no eligibility check, no new row, and no audit entry', async () => {
    const active = assignmentRecord({
      leadId: null,
      clientId: null,
      bookingId: BOOKING_ID,
      assignedStaffId: STAFF_ID,
    });
    repositoryMocks.findActiveAssignmentForBooking.mockResolvedValue(active);

    const result = await setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID);

    expect(result).toEqual(active);
    expect(repositoryMocks.findAssigneeCandidateById).not.toHaveBeenCalled();
    expect(repositoryMocks.endAssignmentById).not.toHaveBeenCalled();
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('throws REASON_REQUIRED when replacing an active Booking assignment without a reason', async () => {
    const active = assignmentRecord({
      leadId: null,
      clientId: null,
      bookingId: BOOKING_ID,
      assignedStaffId: 'other-staff',
    });
    repositoryMocks.findActiveAssignmentForBooking.mockResolvedValue(active);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee());

    await expect(setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID)).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
      status: 409,
    });
    expect(repositoryMocks.endAssignmentById).not.toHaveBeenCalled();
    expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  });

  it('atomically ends the previous Booking assignment and creates the replacement when reassigning with a reason, writing a BOOKING_ASSIGNMENT_REPLACED audit entry', async () => {
    const previous = assignmentRecord({
      id: 'assignment-old',
      leadId: null,
      clientId: null,
      bookingId: BOOKING_ID,
      assignedStaffId: 'other-staff',
    });
    repositoryMocks.findActiveAssignmentForBooking.mockResolvedValue(previous);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(eligibleAssignee());
    const created = assignmentRecord({
      id: 'assignment-new',
      leadId: null,
      clientId: null,
      bookingId: BOOKING_ID,
    });
    repositoryMocks.createAssignment.mockResolvedValue(created);

    const result = await setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID, 'Rebalancing workload');

    expect(result).toEqual(created);
    expect(repositoryMocks.endAssignmentById).toHaveBeenCalledWith(TX_CLIENT, previous.id);
    expect(repositoryMocks.createAssignment).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      assignedStaffId: STAFF_ID,
      assignedByUserId: ACTOR.id,
      bookingId: BOOKING_ID,
    });
    // Both the end and the create happened inside the single $transaction
    // callback — never as separate top-level transactions.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ACTOR.id,
      action: 'BOOKING_ASSIGNMENT_REPLACED',
      entityType: 'Booking',
      entityId: BOOKING_ID,
      beforeState: {
        id: previous.id,
        assignedStaffId: 'other-staff',
        assignedByUserId: ACTOR.id,
        leadId: null,
        clientId: null,
        bookingId: BOOKING_ID,
        endedAt: null,
      },
      afterState: {
        id: created.id,
        assignedStaffId: STAFF_ID,
        assignedByUserId: ACTOR.id,
        leadId: null,
        clientId: null,
        bookingId: BOOKING_ID,
        endedAt: null,
        reason: 'Rebalancing workload',
      },
    });
  });

  it.each(['P2034', 'P2002', 'P2004'] as const)(
    'maps a %s conflict to ASSIGNMENT_CONFLICT, never a raw Prisma error',
    async (code) => {
      transactionMock.mockImplementation(async () => {
        throw conflictError(code);
      });

      await expect(setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID)).rejects.toMatchObject({
        code: 'ASSIGNMENT_CONFLICT',
        status: 409,
      });
    },
  );

  it('rethrows an unrelated, unexpected error unchanged rather than mapping it to ASSIGNMENT_CONFLICT', async () => {
    const unexpected = new Error('unexpected internal failure');
    transactionMock.mockImplementation(async () => {
      throw unexpected;
    });

    await expect(setBookingAssignment(ACTOR, BOOKING_ID, STAFF_ID)).rejects.toBe(unexpected);
  });
});
