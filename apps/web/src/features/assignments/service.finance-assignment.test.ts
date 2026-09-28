import { beforeEach, describe, expect, it, vi } from 'vitest';

// Booking Finance/Accounting assignment (D-056 §1). Same setup as
// service.test.ts: `@/lib/db` is mocked before `./service` is imported, and
// `runSerializableWithRetry` runs for real over a mocked `$transaction`.
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: transactionMock } }));

const repositoryMocks = vi.hoisted(() => ({
  findBookingById: vi.fn(),
  findAssigneeCandidateById: vi.fn(),
  findActiveAssignmentForBooking: vi.fn(),
  findActiveFinanceAssignmentForBooking: vi.fn(),
  createAssignment: vi.fn(),
  createBookingFinanceAssignment: vi.fn(),
  endAssignmentById: vi.fn(),
  endRoleAssignmentById: vi.fn(),
  insertAuditLog: vi.fn(),
  findActiveFinanceAssignmentView: vi.fn(),
  listEligibleFinanceStaff: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { AssignmentError } from './errors';
import type { RoleAssignmentRecord } from './repository';
import {
  endBookingFinanceAssignment,
  getBookingFinanceAssignment,
  listEligibleFinanceStaff,
  setBookingFinanceAssignment,
} from './service';

const TX_CLIENT = { marker: 'tx-client' };
const BOOKING_ID = 'booking-1';
const FINANCE_A = 'finance-a';
const FINANCE_B = 'finance-b';

function actor(role: AuthenticatedUser['role'], id = `${role.toLowerCase()}-1`): AuthenticatedUser {
  return { id, email: `${id}@example.test`, name: id, role };
}
const ADMIN = actor('ADMIN_MANAGER', 'admin-1');

function financeRow(overrides: Partial<RoleAssignmentRecord> = {}): RoleAssignmentRecord {
  return {
    id: 'fa-1',
    assignedStaffId: FINANCE_A,
    assignedByUserId: ADMIN.id,
    leadId: null,
    clientId: null,
    bookingId: BOOKING_ID,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    updatedAt: new Date('2026-09-25T00:00:00Z'),
    endedAt: null,
    role: 'FINANCE_ACCOUNTING',
    ...overrides,
  };
}

async function expectAssignmentError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AssignmentError);
  await promise.catch((error: AssignmentError) => expect(error.code).toBe(code));
}

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation((fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
  repositoryMocks.findBookingById.mockResolvedValue({ id: BOOKING_ID });
  repositoryMocks.findActiveFinanceAssignmentForBooking.mockResolvedValue(null);
  repositoryMocks.findAssigneeCandidateById.mockResolvedValue({
    id: FINANCE_A,
    role: 'FINANCE_ACCOUNTING',
    isActive: true,
  });
});

function expectNoWrite(): void {
  expect(repositoryMocks.createBookingFinanceAssignment).not.toHaveBeenCalled();
  expect(repositoryMocks.endRoleAssignmentById).not.toHaveBeenCalled();
  expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
}

function expectTravelConsultantPathUntouched(): void {
  expect(repositoryMocks.findActiveAssignmentForBooking).not.toHaveBeenCalled();
  expect(repositoryMocks.createAssignment).not.toHaveBeenCalled();
  expect(repositoryMocks.endAssignmentById).not.toHaveBeenCalled();
}

describe('Finance/Accounting assignment mutations — role gating', () => {
  it.each([
    'SYSTEM_ADMINISTRATOR',
    'TRAVEL_CONSULTANT',
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'CLIENT',
  ] as const)('refuses %s before any database access', async (role) => {
    const who = actor(role);
    await expectAssignmentError(
      setBookingFinanceAssignment(who, BOOKING_ID, FINANCE_A),
      'ROLE_NOT_PERMITTED',
    );
    await expectAssignmentError(
      endBookingFinanceAssignment(who, BOOKING_ID, 'Reason'),
      'ROLE_NOT_PERMITTED',
    );
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe('setBookingFinanceAssignment', () => {
  it('creates the assignment with the Finance role and writes BOOKING_FINANCE_ASSIGNMENT_CREATED', async () => {
    const created = financeRow();
    repositoryMocks.createBookingFinanceAssignment.mockResolvedValue(created);

    await expect(setBookingFinanceAssignment(ADMIN, BOOKING_ID, FINANCE_A)).resolves.toBe(created);

    expect(repositoryMocks.createBookingFinanceAssignment).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      assignedStaffId: FINANCE_A,
      assignedByUserId: ADMIN.id,
      bookingId: BOOKING_ID,
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ADMIN.id,
      action: 'BOOKING_FINANCE_ASSIGNMENT_CREATED',
      entityType: 'Booking',
      entityId: BOOKING_ID,
      beforeState: undefined,
      afterState: {
        id: 'fa-1',
        assignedStaffId: FINANCE_A,
        assignedByUserId: ADMIN.id,
        leadId: null,
        clientId: null,
        bookingId: BOOKING_ID,
        endedAt: null,
        role: 'FINANCE_ACCOUNTING',
      },
    });
    expectTravelConsultantPathUntouched();
  });

  it('throws BOOKING_NOT_FOUND for an unknown booking, without checking the assignee', async () => {
    repositoryMocks.findBookingById.mockResolvedValue(null);
    await expectAssignmentError(
      setBookingFinanceAssignment(ADMIN, BOOKING_ID, FINANCE_A),
      'BOOKING_NOT_FOUND',
    );
    expect(repositoryMocks.findAssigneeCandidateById).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([
    ['ASSIGNEE_NOT_FOUND', null],
    ['ASSIGNEE_INACTIVE', { id: FINANCE_A, role: 'FINANCE_ACCOUNTING', isActive: false }],
    ['ASSIGNEE_INELIGIBLE_ROLE', { id: FINANCE_A, role: 'TRAVEL_CONSULTANT', isActive: true }],
    ['ASSIGNEE_INELIGIBLE_ROLE', { id: FINANCE_A, role: 'ADMIN_MANAGER', isActive: true }],
    ['ASSIGNEE_INELIGIBLE_ROLE', { id: FINANCE_A, role: 'CLIENT', isActive: true }],
  ])('refuses an ineligible assignee with %s', async (code, candidate) => {
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue(candidate);
    await expectAssignmentError(setBookingFinanceAssignment(ADMIN, BOOKING_ID, FINANCE_A), code);
    expectNoWrite();
  });

  it('is idempotent for the already-active assignee: no eligibility check, no write, no audit', async () => {
    const active = financeRow();
    repositoryMocks.findActiveFinanceAssignmentForBooking.mockResolvedValue(active);

    await expect(setBookingFinanceAssignment(ADMIN, BOOKING_ID, FINANCE_A)).resolves.toBe(active);
    expect(repositoryMocks.findAssigneeCandidateById).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it.each([undefined, '', '   '])(
    'requires a non-blank reason to replace a different active assignee (reason %j)',
    async (reason) => {
      repositoryMocks.findActiveFinanceAssignmentForBooking.mockResolvedValue(financeRow());
      repositoryMocks.findAssigneeCandidateById.mockResolvedValue({
        id: FINANCE_B,
        role: 'FINANCE_ACCOUNTING',
        isActive: true,
      });
      await expectAssignmentError(
        setBookingFinanceAssignment(ADMIN, BOOKING_ID, FINANCE_B, reason),
        'REASON_REQUIRED',
      );
      expectNoWrite();
    },
  );

  it('replaces: ends the active row, creates the new one, and writes BOOKING_FINANCE_ASSIGNMENT_REPLACED with both snapshots and the trimmed reason', async () => {
    const active = financeRow();
    const ended = financeRow({ endedAt: new Date('2026-09-26T00:00:00Z') });
    const created = financeRow({ id: 'fa-2', assignedStaffId: FINANCE_B });
    repositoryMocks.findActiveFinanceAssignmentForBooking.mockResolvedValue(active);
    repositoryMocks.findAssigneeCandidateById.mockResolvedValue({
      id: FINANCE_B,
      role: 'FINANCE_ACCOUNTING',
      isActive: true,
    });
    repositoryMocks.endRoleAssignmentById.mockResolvedValue(ended);
    repositoryMocks.createBookingFinanceAssignment.mockResolvedValue(created);

    await expect(
      setBookingFinanceAssignment(ADMIN, BOOKING_ID, FINANCE_B, '  Ben on leave  '),
    ).resolves.toBe(created);

    expect(repositoryMocks.endRoleAssignmentById).toHaveBeenCalledWith(TX_CLIENT, 'fa-1');
    const audit = repositoryMocks.insertAuditLog.mock.calls[0]![1];
    expect(audit.action).toBe('BOOKING_FINANCE_ASSIGNMENT_REPLACED');
    expect(audit.beforeState).toMatchObject({
      id: 'fa-1',
      assignedStaffId: FINANCE_A,
      role: 'FINANCE_ACCOUNTING',
    });
    expect(audit.afterState).toMatchObject({
      id: 'fa-2',
      assignedStaffId: FINANCE_B,
      role: 'FINANCE_ACCOUNTING',
      reason: 'Ben on leave',
    });
    expectTravelConsultantPathUntouched();
  });

  it('never writes a Travel Consultant BOOKING_ASSIGNMENT_* action', async () => {
    repositoryMocks.createBookingFinanceAssignment.mockResolvedValue(financeRow());
    await setBookingFinanceAssignment(ADMIN, BOOKING_ID, FINANCE_A);
    for (const [, entry] of repositoryMocks.insertAuditLog.mock.calls) {
      expect(entry.action).toMatch(/^BOOKING_FINANCE_ASSIGNMENT_/);
    }
  });

  it('maps a unique-index conflict (P2002) that survives the transaction to ASSIGNMENT_CONFLICT', async () => {
    repositoryMocks.createBookingFinanceAssignment.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.8.0',
      }),
    );
    await expectAssignmentError(
      setBookingFinanceAssignment(ADMIN, BOOKING_ID, FINANCE_A),
      'ASSIGNMENT_CONFLICT',
    );
  });
});

describe('endBookingFinanceAssignment', () => {
  it.each(['', '   '])(
    'requires a non-blank reason (reason %j) before any database access',
    async (reason) => {
      await expectAssignmentError(
        endBookingFinanceAssignment(ADMIN, BOOKING_ID, reason),
        'REASON_REQUIRED',
      );
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it('throws BOOKING_NOT_FOUND for an unknown booking', async () => {
    repositoryMocks.findBookingById.mockResolvedValue(null);
    await expectAssignmentError(
      endBookingFinanceAssignment(ADMIN, BOOKING_ID, 'Closed out'),
      'BOOKING_NOT_FOUND',
    );
  });

  it('is idempotent when nothing is active: returns null with no write and no audit', async () => {
    await expect(endBookingFinanceAssignment(ADMIN, BOOKING_ID, 'Closed out')).resolves.toBeNull();
    expectNoWrite();
  });

  it('ends the active row and writes BOOKING_FINANCE_ASSIGNMENT_ENDED with the reason', async () => {
    const active = financeRow();
    const ended = financeRow({ endedAt: new Date('2026-09-26T00:00:00Z') });
    repositoryMocks.findActiveFinanceAssignmentForBooking.mockResolvedValue(active);
    repositoryMocks.endRoleAssignmentById.mockResolvedValue(ended);

    await expect(endBookingFinanceAssignment(ADMIN, BOOKING_ID, ' Closed out ')).resolves.toBe(
      ended,
    );
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ADMIN.id,
      action: 'BOOKING_FINANCE_ASSIGNMENT_ENDED',
      entityType: 'Booking',
      entityId: BOOKING_ID,
      beforeState: expect.objectContaining({
        id: 'fa-1',
        endedAt: null,
        role: 'FINANCE_ACCOUNTING',
      }),
      afterState: expect.objectContaining({
        id: 'fa-1',
        endedAt: '2026-09-26T00:00:00.000Z',
        role: 'FINANCE_ACCOUNTING',
        reason: 'Closed out',
      }),
    });
    expectTravelConsultantPathUntouched();
  });
});

describe('getBookingFinanceAssignment', () => {
  const viewRow = {
    id: 'fa-1',
    bookingId: BOOKING_ID,
    assignedStaffId: FINANCE_A,
    assignedByUserId: ADMIN.id,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    assignedStaff: {
      id: FINANCE_A,
      name: 'Ben',
      email: 'ben@example.test',
      role: 'FINANCE_ACCOUNTING',
      isActive: true,
    },
  };

  it('returns the active assignment for Admin/Manager, marking an eligible assignee', async () => {
    repositoryMocks.findActiveFinanceAssignmentView.mockResolvedValue(viewRow);
    const view = await getBookingFinanceAssignment(ADMIN, BOOKING_ID);
    expect(repositoryMocks.findActiveFinanceAssignmentView).toHaveBeenCalledWith(
      prisma,
      BOOKING_ID,
    );
    expect(view).toMatchObject({ id: 'fa-1', assigneeEligible: true, assignee: { name: 'Ben' } });
  });

  it.each([
    ['moved to another role', { role: 'TRAVEL_CONSULTANT', isActive: true }],
    ['deactivated', { role: 'FINANCE_ACCOUNTING', isActive: false }],
  ])('marks a stale assignee (%s) as not eligible', async (_label, staff) => {
    repositoryMocks.findActiveFinanceAssignmentView.mockResolvedValue({
      ...viewRow,
      assignedStaff: { ...viewRow.assignedStaff, ...staff },
    });
    await expect(getBookingFinanceAssignment(ADMIN, BOOKING_ID)).resolves.toMatchObject({
      assigneeEligible: false,
    });
  });

  it('returns null for Admin/Manager when no Finance assignment is active', async () => {
    repositoryMocks.findActiveFinanceAssignmentView.mockResolvedValue(null);
    await expect(getBookingFinanceAssignment(ADMIN, BOOKING_ID)).resolves.toBeNull();
  });

  it('throws BOOKING_NOT_FOUND for Admin/Manager and an unknown booking', async () => {
    repositoryMocks.findBookingById.mockResolvedValue(null);
    await expectAssignmentError(
      getBookingFinanceAssignment(ADMIN, BOOKING_ID),
      'BOOKING_NOT_FOUND',
    );
  });

  // D-056 §1 limits Finance/Accounting access to features/payments, so even
  // the assigned Finance user cannot read the assignment here.
  it.each([
    'FINANCE_ACCOUNTING',
    'SYSTEM_ADMINISTRATOR',
    'TRAVEL_CONSULTANT',
    'VISA_DOCUMENTATION',
    'CLIENT',
  ] as const)('refuses %s with ROLE_NOT_PERMITTED before any read', async (role) => {
    await expectAssignmentError(
      getBookingFinanceAssignment(actor(role, FINANCE_A), BOOKING_ID),
      'ROLE_NOT_PERMITTED',
    );
    expect(repositoryMocks.findBookingById).not.toHaveBeenCalled();
    expect(repositoryMocks.findActiveFinanceAssignmentView).not.toHaveBeenCalled();
  });
});

describe('listEligibleFinanceStaff', () => {
  it('delegates with computed skip/take for Admin/Manager', async () => {
    repositoryMocks.listEligibleFinanceStaff.mockResolvedValue({ items: [], total: 0 });
    await expect(
      listEligibleFinanceStaff(ADMIN, { search: 'be', page: 3, pageSize: 10 }),
    ).resolves.toEqual({ items: [], page: 3, pageSize: 10, total: 0 });
    expect(repositoryMocks.listEligibleFinanceStaff).toHaveBeenCalledWith(prisma, {
      search: 'be',
      skip: 20,
      take: 10,
    });
  });

  it.each(['SYSTEM_ADMINISTRATOR', 'TRAVEL_CONSULTANT', 'FINANCE_ACCOUNTING', 'CLIENT'] as const)(
    'refuses %s with ROLE_NOT_PERMITTED',
    async (role) => {
      await expectAssignmentError(
        listEligibleFinanceStaff(actor(role), { page: 1, pageSize: 20 }),
        'ROLE_NOT_PERMITTED',
      );
      expect(repositoryMocks.listEligibleFinanceStaff).not.toHaveBeenCalled();
    },
  );
});
