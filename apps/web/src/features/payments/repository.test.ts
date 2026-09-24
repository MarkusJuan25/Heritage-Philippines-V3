import { describe, expect, it, vi } from 'vitest';

import { Prisma, type Prisma as PrismaNamespace } from '@/generated/prisma/client';

import {
  approvePaymentPlanRow,
  createAllocation,
  createAllocationReversal,
  createPaymentPlanWithInstallments,
  createPendingPayment,
  createReceipt,
  createRefund,
  findAllocationForRefund,
  findAllocationForReversal,
  findApprovedBookingIdsForClient,
  findBookingFinancialsForActor,
  findBookingPaymentSummaryData,
  findInstallmentForAllocation,
  findPaymentForActor,
  findPaymentPlanByBookingIdForActor,
  findReceiptByPaymentId,
  findRefundByIdempotencyKey,
  findStatusHistoryByIdempotencyKey,
  insertAuditLog,
  sumNetActiveAllocationsForInstallment,
  sumNetActiveAllocationsForPayment,
  sumInstallmentAmounts,
  sumRefundsForPayment,
  transitionPaymentStatus,
} from './repository';

const ADMIN_MANAGER = { id: 'admin-1', role: 'ADMIN_MANAGER' as const };
const TRAVEL_CONSULTANT = { id: 'tc-1', role: 'TRAVEL_CONSULTANT' as const };
const FINANCE = { id: 'finance-1', role: 'FINANCE_ACCOUNTING' as const };

const BOOKING_ASSIGNMENT_FILTER = (staffId: string, role: string) => ({
  staffAssignments: { some: { assignedStaffId: staffId, role, endedAt: null } },
});

const BOOKING_ID = 'booking-1';

function db(overrides: Record<string, unknown>): PrismaNamespace.TransactionClient {
  return overrides as unknown as PrismaNamespace.TransactionClient;
}

describe('findBookingFinancialsForActor (booking-level assignment scoping)', () => {
  it('applies no assignment filter for ADMIN_MANAGER', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await findBookingFinancialsForActor(db({ booking: { findFirst } }), ADMIN_MANAGER, BOOKING_ID);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: BOOKING_ID },
      select: expect.any(Object),
    });
  });

  it('applies the booking-level StaffAssignment filter for TRAVEL_CONSULTANT', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await findBookingFinancialsForActor(
      db({ booking: { findFirst } }),
      TRAVEL_CONSULTANT,
      BOOKING_ID,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: BOOKING_ID,
        ...BOOKING_ASSIGNMENT_FILTER(TRAVEL_CONSULTANT.id, TRAVEL_CONSULTANT.role),
      },
      select: expect.any(Object),
    });
  });

  it('applies the identical booking-level filter for FINANCE_ACCOUNTING', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await findBookingFinancialsForActor(db({ booking: { findFirst } }), FINANCE, BOOKING_ID);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: BOOKING_ID, ...BOOKING_ASSIGNMENT_FILTER(FINANCE.id, FINANCE.role) },
      select: expect.any(Object),
    });
  });
});

describe('findPaymentPlanByBookingIdForActor', () => {
  it('scopes through the owning Booking', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await findPaymentPlanByBookingIdForActor(
      db({ paymentPlan: { findFirst } }),
      FINANCE,
      BOOKING_ID,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        bookingId: BOOKING_ID,
        booking: { ...BOOKING_ASSIGNMENT_FILTER(FINANCE.id, FINANCE.role) },
      },
      select: expect.any(Object),
    });
  });
});

describe('createPaymentPlanWithInstallments', () => {
  it('creates the plan and every installment as one nested write', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'plan-1' });
    await createPaymentPlanWithInstallments(db({ paymentPlan: { create } }), {
      id: 'plan-1',
      bookingId: BOOKING_ID,
      clientId: 'client-1',
      proposedByStaffUserId: TRAVEL_CONSULTANT.id,
      installments: [
        {
          id: 'inst-1',
          sequenceNumber: 1,
          isDeposit: true,
          amount: '100.00',
          dueDate: new Date('2026-10-01'),
        },
        {
          id: 'inst-2',
          sequenceNumber: 2,
          isDeposit: false,
          amount: '200.00',
          dueDate: new Date('2026-11-01'),
        },
      ],
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'plan-1',
        bookingId: BOOKING_ID,
        installments: {
          create: [
            expect.objectContaining({
              id: 'inst-1',
              sequenceNumber: 1,
              isDeposit: true,
              amount: '100.00',
            }),
            expect.objectContaining({
              id: 'inst-2',
              sequenceNumber: 2,
              isDeposit: false,
              amount: '200.00',
            }),
          ],
        },
      }),
      select: expect.any(Object),
    });
  });
});

describe('sumInstallmentAmounts', () => {
  it('returns the aggregate sum as a Decimal', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal('300.00') } });
    const result = await sumInstallmentAmounts(db({ installment: { aggregate } }), 'plan-1');
    expect(result.toFixed(2)).toBe('300.00');
  });

  it('falls back to zero when there are no installments', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: null } });
    const result = await sumInstallmentAmounts(db({ installment: { aggregate } }), 'plan-1');
    expect(result.toFixed(2)).toBe('0.00');
  });
});

describe('approvePaymentPlanRow', () => {
  it('sets approvedByStaffUserId and approvedAt', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'plan-1' });
    const approvedAt = new Date('2026-09-23T00:00:00.000Z');
    await approvePaymentPlanRow(db({ paymentPlan: { update } }), {
      id: 'plan-1',
      approvedByStaffUserId: FINANCE.id,
      approvedAt,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: { approvedByStaffUserId: FINANCE.id, approvedAt },
      select: expect.any(Object),
    });
  });
});

describe('findInstallmentForAllocation', () => {
  it('maps the nested paymentPlan relation to bookingId/planApprovedAt', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'inst-1',
      paymentPlanId: 'plan-1',
      amount: new Prisma.Decimal('100.00'),
      paymentPlan: { bookingId: BOOKING_ID, approvedAt: null },
    });
    const result = await findInstallmentForAllocation(
      db({ installment: { findUnique } }),
      'inst-1',
    );
    expect(result).toEqual({
      id: 'inst-1',
      paymentPlanId: 'plan-1',
      bookingId: BOOKING_ID,
      amount: new Prisma.Decimal('100.00'),
      planApprovedAt: null,
    });
  });

  it('returns null when the installment does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const result = await findInstallmentForAllocation(
      db({ installment: { findUnique } }),
      'missing',
    );
    expect(result).toBeNull();
  });
});

describe('findPaymentForActor', () => {
  it('scopes through the owning Booking assignment filter', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await findPaymentForActor(db({ payment: { findFirst } }), TRAVEL_CONSULTANT, 'payment-1');
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'payment-1',
        booking: { ...BOOKING_ASSIGNMENT_FILTER(TRAVEL_CONSULTANT.id, TRAVEL_CONSULTANT.role) },
      },
      select: expect.any(Object),
    });
  });
});

describe('createPendingPayment', () => {
  it('creates the Payment with status PENDING and its initial history row', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'payment-1' });
    await createPendingPayment(db({ payment: { create } }), {
      id: 'payment-1',
      bookingId: BOOKING_ID,
      clientId: 'client-1',
      amount: '150.00',
      changedByUserId: FINANCE.id,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'PENDING',
        statusHistory: {
          create: expect.objectContaining({ previousStatus: null, newStatus: 'PENDING' }),
        },
      }),
      select: expect.any(Object),
    });
  });
});

describe('findStatusHistoryByIdempotencyKey', () => {
  it('returns only the paymentId and target status the key recorded, never the Payment itself', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ paymentId: 'payment-1', newStatus: 'CONFIRMED' });
    const result = await findStatusHistoryByIdempotencyKey(
      db({ paymentStatusHistory: { findUnique } }),
      'idem-1',
    );
    expect(result).toEqual({ paymentId: 'payment-1', newStatus: 'CONFIRMED' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'idem-1' },
      select: { paymentId: true, newStatus: true },
    });
  });

  it('returns null when the key does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const result = await findStatusHistoryByIdempotencyKey(
      db({ paymentStatusHistory: { findUnique } }),
      'missing',
    );
    expect(result).toBeNull();
  });
});

describe('transitionPaymentStatus', () => {
  it('updates status and creates the history row atomically (as one nested write)', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'payment-1', status: 'CONFIRMED' });
    await transitionPaymentStatus(db({ payment: { update } }), {
      paymentId: 'payment-1',
      previousStatus: 'PENDING',
      newStatus: 'CONFIRMED',
      changedByUserId: FINANCE.id,
      reason: 'Verified',
      idempotencyKey: 'idem-1',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: expect.objectContaining({
        status: 'CONFIRMED',
        statusHistory: {
          create: expect.objectContaining({
            previousStatus: 'PENDING',
            newStatus: 'CONFIRMED',
            reason: 'Verified',
            idempotencyKey: 'idem-1',
          }),
        },
      }),
      select: expect.any(Object),
    });
  });
});

describe('sumNetActiveAllocationsForInstallment (D-054 §17 Rule 5)', () => {
  it("applies D-019's filters in the query and subtracts linked refunds", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        amount: new Prisma.Decimal('60.00'),
        refundAllocations: [{ amount: new Prisma.Decimal('15.00') }],
      },
      { amount: new Prisma.Decimal('20.00'), refundAllocations: [] },
    ]);
    const result = await sumNetActiveAllocationsForInstallment(
      db({ paymentAllocation: { findMany } }),
      'inst-1',
    );
    expect(result.toFixed(2)).toBe('65.00');
    expect(findMany).toHaveBeenCalledWith({
      where: {
        installmentId: 'inst-1',
        reversal: null,
        payment: { status: { in: ['CONFIRMED', 'REFUNDED'] } },
      },
      select: { amount: true, refundAllocations: { select: { amount: true } } },
    });
  });

  it('is zero with no active allocations', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const result = await sumNetActiveAllocationsForInstallment(
      db({ paymentAllocation: { findMany } }),
      'inst-1',
    );
    expect(result.toFixed(2)).toBe('0.00');
  });
});

describe('sumRefundsForPayment / sumNetActiveAllocationsForPayment', () => {
  it('sumRefundsForPayment falls back to zero with no refunds', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { amount: null } });
    const result = await sumRefundsForPayment(db({ paymentRefund: { aggregate } }), 'payment-1');
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('sumNetActiveAllocationsForPayment excludes reversed allocations and subtracts linked refunds', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        amount: new Prisma.Decimal('50.00'),
        refundAllocations: [{ amount: new Prisma.Decimal('30.00') }],
      },
      { amount: new Prisma.Decimal('25.00'), refundAllocations: [] },
    ]);
    const result = await sumNetActiveAllocationsForPayment(
      db({ paymentAllocation: { findMany } }),
      'payment-1',
    );
    expect(result.toFixed(2)).toBe('45.00');
    expect(findMany).toHaveBeenCalledWith({
      where: { paymentId: 'payment-1', reversal: null },
      select: { amount: true, refundAllocations: { select: { amount: true } } },
    });
  });

  it('sumNetActiveAllocationsForPayment is zero with no active allocations', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const result = await sumNetActiveAllocationsForPayment(
      db({ paymentAllocation: { findMany } }),
      'payment-1',
    );
    expect(result.toFixed(2)).toBe('0.00');
  });
});

describe('createRefund', () => {
  it('creates a bare refund with no allocation link when allocationId is omitted', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'refund-1', paymentId: 'payment-1', amount: '10.00', reason: 'r' });
    await createRefund(db({ paymentRefund: { create } }), {
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: '10.00',
      reason: 'r',
      performedByStaffUserId: FINANCE.id,
      idempotencyKey: 'idem-1',
    });
    const call = create.mock.calls[0]?.[0];
    expect(call.data).not.toHaveProperty('refundAllocations');
  });

  it('creates the linked PaymentRefundAllocation as a nested write when allocationId is supplied', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: 'refund-1', paymentId: 'payment-1', amount: '10.00', reason: 'r' });
    await createRefund(db({ paymentRefund: { create } }), {
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: '10.00',
      reason: 'r',
      performedByStaffUserId: FINANCE.id,
      idempotencyKey: 'idem-1',
      allocationId: 'alloc-1',
    });
    const call = create.mock.calls[0]?.[0];
    expect(call.data.refundAllocations.create).toEqual(
      expect.objectContaining({ paymentAllocationId: 'alloc-1', amount: '10.00' }),
    );
  });
});

describe('findAllocationForReversal', () => {
  it('maps a present reversal and refund allocations to booleans', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: new Prisma.Decimal('50.00'),
      reversal: { id: 'reversal-1' },
      refundAllocations: [{ id: 'ra-1' }],
    });
    const result = await findAllocationForReversal(
      db({ paymentAllocation: { findUnique } }),
      'alloc-1',
    );
    expect(result).toEqual({
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: new Prisma.Decimal('50.00'),
      hasReversal: true,
      hasRefundAllocation: true,
    });
  });

  it('maps absence of reversal/refund allocations to false', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: new Prisma.Decimal('50.00'),
      reversal: null,
      refundAllocations: [],
    });
    const result = await findAllocationForReversal(
      db({ paymentAllocation: { findUnique } }),
      'alloc-1',
    );
    expect(result?.hasReversal).toBe(false);
    expect(result?.hasRefundAllocation).toBe(false);
  });
});

describe('findRefundByIdempotencyKey', () => {
  it('returns the refund with the allocation it was linked to', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: new Prisma.Decimal('10.00'),
      reason: 'Overpaid',
      refundAllocations: [{ paymentAllocationId: 'alloc-1' }],
    });
    const result = await findRefundByIdempotencyKey(db({ paymentRefund: { findUnique } }), 'k');
    expect(result).toEqual({
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: new Prisma.Decimal('10.00'),
      reason: 'Overpaid',
      allocationId: 'alloc-1',
    });
  });

  it('reports allocationId: null for a refund from unapplied credit', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: new Prisma.Decimal('10.00'),
      reason: 'Overpaid',
      refundAllocations: [],
    });
    const result = await findRefundByIdempotencyKey(db({ paymentRefund: { findUnique } }), 'k');
    expect(result?.allocationId).toBeNull();
  });
});

describe('findAllocationForRefund', () => {
  it('reports whether the allocation has been reversed', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      amount: new Prisma.Decimal('80.00'),
      reversal: { id: 'reversal-1' },
      refundAllocations: [],
    });
    const result = await findAllocationForRefund(
      db({ paymentAllocation: { findUnique } }),
      'alloc-1',
    );
    expect(result?.isReversed).toBe(true);
  });

  it('sums refundAllocations into refundAllocatedTotal', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      amount: new Prisma.Decimal('80.00'),
      reversal: null,
      refundAllocations: [
        { amount: new Prisma.Decimal('10.00') },
        { amount: new Prisma.Decimal('5.00') },
      ],
    });
    const result = await findAllocationForRefund(
      db({ paymentAllocation: { findUnique } }),
      'alloc-1',
    );
    expect(result?.refundAllocatedTotal.toFixed(2)).toBe('15.00');
  });
});

describe('createAllocation / createAllocationReversal', () => {
  it('createAllocation persists the caller-supplied idempotencyKey', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'alloc-1' });
    await createAllocation(db({ paymentAllocation: { create } }), {
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: '50.00',
      allocatedByStaffUserId: FINANCE.id,
      idempotencyKey: 'idem-1',
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ idempotencyKey: 'idem-1' }),
      select: expect.any(Object),
    });
  });

  it('createAllocationReversal persists reason and idempotencyKey', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'reversal-1', paymentAllocationId: 'alloc-1' });
    await createAllocationReversal(db({ paymentAllocationReversal: { create } }), {
      id: 'reversal-1',
      paymentAllocationId: 'alloc-1',
      reversedByStaffUserId: FINANCE.id,
      reason: 'Misallocated',
      idempotencyKey: 'idem-1',
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: 'Misallocated', idempotencyKey: 'idem-1' }),
      select: expect.any(Object),
    });
  });
});

describe('findReceiptByPaymentId / createReceipt', () => {
  it('findReceiptByPaymentId looks up by the unique paymentId', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    await findReceiptByPaymentId(db({ receipt: { findUnique } }), 'payment-1');
    expect(findUnique).toHaveBeenCalledWith({
      where: { paymentId: 'payment-1' },
      select: expect.any(Object),
    });
  });

  it('createReceipt persists a server-generated receiptNumber', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'receipt-1' });
    await createReceipt(db({ receipt: { create } }), {
      id: 'receipt-1',
      paymentId: 'payment-1',
      receiptNumber: 'server-generated-uuid',
      issuedByStaffUserId: FINANCE.id,
      amount: '150.00',
      currencyCode: 'PHP',
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        receiptNumber: 'server-generated-uuid',
        currencyCode: 'PHP',
      }),
      select: expect.any(Object),
    });
  });
});

describe('insertAuditLog', () => {
  it('writes actor, action, entityType, entityId, and before/after state', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    await insertAuditLog(db({ auditLog: { create } }), {
      actorId: FINANCE.id,
      action: 'PAYMENT_STATUS_CHANGED',
      entityType: 'Payment',
      entityId: 'payment-1',
      beforeState: { status: 'PENDING' },
      afterState: { status: 'CONFIRMED' },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: FINANCE.id,
        action: 'PAYMENT_STATUS_CHANGED',
        entityType: 'Payment',
        entityId: 'payment-1',
        beforeState: { status: 'PENDING' },
        afterState: { status: 'CONFIRMED' },
      }),
    });
  });
});

describe('findBookingPaymentSummaryData', () => {
  it('returns null when the Booking does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const result = await findBookingPaymentSummaryData(db({ booking: { findUnique } }), 'missing');
    expect(result).toBeNull();
  });

  it('maps a null paymentPlan to plan: null', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: BOOKING_ID,
      clientId: 'client-1',
      totalAmount: new Prisma.Decimal('500.00'),
      currencyCode: 'PHP',
      paymentPlan: null,
      payments: [],
    });
    const result = await findBookingPaymentSummaryData(db({ booking: { findUnique } }), BOOKING_ID);
    expect(result?.plan).toBeNull();
    expect(result?.payments).toEqual([]);
  });

  it('sums refundAllocations per allocation and refunds per payment', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: BOOKING_ID,
      clientId: 'client-1',
      totalAmount: new Prisma.Decimal('500.00'),
      currencyCode: 'PHP',
      paymentPlan: {
        id: 'plan-1',
        approvedByStaffUserId: FINANCE.id,
        approvedAt: new Date('2026-09-01'),
        installments: [
          {
            id: 'inst-1',
            dueDate: new Date('2026-10-01'),
            amount: new Prisma.Decimal('500.00'),
            allocations: [
              {
                id: 'alloc-1',
                paymentId: 'payment-1',
                amount: new Prisma.Decimal('100.00'),
                reversal: null,
                refundAllocations: [{ amount: new Prisma.Decimal('20.00') }],
                payment: { status: 'CONFIRMED' },
              },
            ],
          },
        ],
      },
      payments: [
        {
          id: 'payment-1',
          amount: new Prisma.Decimal('100.00'),
          status: 'CONFIRMED',
          refunds: [{ amount: new Prisma.Decimal('20.00') }],
          receipt: { receiptNumber: 'r-1', issuedAt: new Date('2026-09-02') },
        },
      ],
    });
    const result = await findBookingPaymentSummaryData(db({ booking: { findUnique } }), BOOKING_ID);
    expect(result?.plan?.installments[0]?.allocations[0]?.refundAllocatedTotal.toFixed(2)).toBe(
      '20.00',
    );
    expect(result?.payments[0]?.refundedTotal.toFixed(2)).toBe('20.00');
    expect(result?.plan?.installments[0]?.allocations[0]).toMatchObject({
      id: 'alloc-1',
      paymentId: 'payment-1',
      isReversed: false,
    });
    expect(result?.payments[0]?.receipt).toEqual({
      receiptNumber: 'r-1',
      issuedAt: new Date('2026-09-02'),
    });
  });
});

describe('findApprovedBookingIdsForClient', () => {
  it('filters to bookings with a non-null paymentPlan.approvedAt', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'booking-1' }, { id: 'booking-2' }]);
    const result = await findApprovedBookingIdsForClient(db({ booking: { findMany } }), 'client-1');
    expect(result).toEqual(['booking-1', 'booking-2']);
    expect(findMany).toHaveBeenCalledWith({
      where: { clientId: 'client-1', paymentPlan: { approvedAt: { not: null } } },
      select: { id: true },
      orderBy: expect.any(Array),
    });
  });
});
