import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import {
  sanitizeAllocationSnapshot,
  sanitizePaymentPlanSnapshot,
  sanitizePaymentPlanWithdrawalAfterSnapshot,
  sanitizePaymentPlanWithdrawalBeforeSnapshot,
  sanitizePaymentRefundBeforeSnapshot,
  sanitizePaymentRefundSnapshot,
  sanitizePaymentStatusChangeSnapshot,
  sanitizePaymentStatusSnapshot,
  sanitizeReceiptSnapshot,
} from './audit';

describe('sanitizePaymentPlanSnapshot', () => {
  it('builds an explicit allow-list, never a spread of the source record', () => {
    const record = {
      id: 'plan-1',
      bookingId: 'booking-1',
      clientId: 'client-1',
      proposedByStaffUserId: 'staff-1',
      approvedByStaffUserId: null,
      approvedAt: null,
      status: 'PROPOSED',
      withdrawalReason: 'should never appear',
      extraField: 'should never appear',
    };
    const snapshot = sanitizePaymentPlanSnapshot(record);
    expect(snapshot).toEqual({
      id: 'plan-1',
      bookingId: 'booking-1',
      clientId: 'client-1',
      approvedByStaffUserId: null,
      approvedAt: null,
      status: 'PROPOSED',
    });
    expect(snapshot).not.toHaveProperty('withdrawalReason');
    expect(snapshot).not.toHaveProperty('extraField');
    expect(snapshot).not.toHaveProperty('proposedByStaffUserId');
  });

  it('serializes a non-null approvedAt to an ISO string', () => {
    const snapshot = sanitizePaymentPlanSnapshot({
      id: 'plan-1',
      bookingId: 'booking-1',
      clientId: 'client-1',
      approvedByStaffUserId: 'staff-2',
      approvedAt: new Date('2026-09-23T00:00:00.000Z'),
      status: 'APPROVED',
    });
    expect(snapshot.approvedAt).toBe('2026-09-23T00:00:00.000Z');
    expect(snapshot.status).toBe('APPROVED');
  });
});

describe('PAYMENT_PLAN_WITHDRAWN snapshots (D-057 §5)', () => {
  const plan = {
    id: 'plan-1',
    bookingId: 'booking-1',
    clientId: 'client-1',
    approvedByStaffUserId: null,
    approvedAt: null,
    status: 'PROPOSED',
  };

  it('beforeState is the plan snapshot plus every installment as decimal strings and calendar dates', () => {
    const snapshot = sanitizePaymentPlanWithdrawalBeforeSnapshot(
      { ...plan, proposedByStaffUserId: 'tc-1' } as typeof plan,
      [
        {
          sequenceNumber: 1,
          isDeposit: true,
          amount: new Prisma.Decimal('35000'),
          dueDate: new Date('2026-10-01T00:00:00.000Z'),
          id: 'inst-1',
        } as never,
        {
          sequenceNumber: 2,
          isDeposit: false,
          amount: new Prisma.Decimal('40000.50'),
          dueDate: new Date('2026-11-01T00:00:00.000Z'),
        },
      ],
    );
    expect(snapshot).toEqual({
      id: 'plan-1',
      bookingId: 'booking-1',
      clientId: 'client-1',
      approvedByStaffUserId: null,
      approvedAt: null,
      status: 'PROPOSED',
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '35000.00', dueDate: '2026-10-01' },
        { sequenceNumber: 2, isDeposit: false, amount: '40000.50', dueDate: '2026-11-01' },
      ],
    });
    expect(snapshot).not.toHaveProperty('proposedByStaffUserId');
    expect(snapshot.installments[0]).not.toHaveProperty('id');
  });

  it('afterState carries exactly status, withdrawnAt, withdrawnByStaffUserId, and reason', () => {
    expect(
      sanitizePaymentPlanWithdrawalAfterSnapshot({
        withdrawnAt: new Date('2026-09-28T01:02:03.000Z'),
        withdrawnByStaffUserId: 'finance-1',
        reason: 'Total should be 110,000.00',
      }),
    ).toEqual({
      status: 'WITHDRAWN',
      withdrawnAt: '2026-09-28T01:02:03.000Z',
      withdrawnByStaffUserId: 'finance-1',
      reason: 'Total should be 110,000.00',
    });
  });
});

describe('sanitizePaymentStatusSnapshot', () => {
  it('returns only the status field', () => {
    expect(sanitizePaymentStatusSnapshot('CONFIRMED')).toEqual({ status: 'CONFIRMED' });
  });
});

describe('sanitizePaymentStatusChangeSnapshot', () => {
  it('returns only the status and reason', () => {
    expect(sanitizePaymentStatusChangeSnapshot('REVERSED', 'Duplicate entry')).toEqual({
      status: 'REVERSED',
      reason: 'Duplicate entry',
    });
  });
});

describe('sanitizePaymentRefundBeforeSnapshot', () => {
  it('returns only the status and refunded total', () => {
    const source = { status: 'CONFIRMED', refundedTotal: '0.00', amount: '100.00' };
    expect(sanitizePaymentRefundBeforeSnapshot(source)).toEqual({
      status: 'CONFIRMED',
      refundedTotal: '0.00',
    });
  });
});

describe('sanitizePaymentRefundSnapshot', () => {
  it('carries the refund, its allocation link, and the after values only', () => {
    const snapshot = sanitizePaymentRefundSnapshot({
      paymentId: 'payment-1',
      amount: '50.00',
      reason: 'Client cancelled excursion',
      allocationId: 'allocation-1',
      status: 'CONFIRMED',
      refundedTotal: '50.00',
    });
    expect(snapshot).toEqual({
      paymentId: 'payment-1',
      amount: '50.00',
      reason: 'Client cancelled excursion',
      allocationId: 'allocation-1',
      status: 'CONFIRMED',
      refundedTotal: '50.00',
    });
  });
});

describe('sanitizeAllocationSnapshot', () => {
  it('carries paymentId, installmentId, and amount only', () => {
    const snapshot = sanitizeAllocationSnapshot({
      paymentId: 'payment-1',
      installmentId: 'installment-1',
      amount: '25.00',
    });
    expect(snapshot).toEqual({
      paymentId: 'payment-1',
      installmentId: 'installment-1',
      amount: '25.00',
    });
  });
});

describe('sanitizeReceiptSnapshot', () => {
  it('carries paymentId, receiptNumber, and amount only', () => {
    const snapshot = sanitizeReceiptSnapshot({
      paymentId: 'payment-1',
      receiptNumber: 'r-1',
      amount: '100.00',
    });
    expect(snapshot).toEqual({ paymentId: 'payment-1', receiptNumber: 'r-1', amount: '100.00' });
  });
});
