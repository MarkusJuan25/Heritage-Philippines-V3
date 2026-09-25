import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import {
  computeNetActiveAllocation,
  computeNetConfirmedAmountPaid,
  computeNetContribution,
  computeNextPaymentDue,
  computeOutstandingInstallmentAmount,
  computeOverpayment,
  computeRemainingBalance,
  computeUnappliedCredit,
} from './calculations';

const d = (value: string) => new Prisma.Decimal(value);

describe('computeNetContribution', () => {
  it('is the full amount for a CONFIRMED payment with no refunds', () => {
    const result = computeNetContribution({
      status: 'CONFIRMED',
      amount: d('100.00'),
      refundedTotal: d('0.00'),
    });
    expect(result.toFixed(2)).toBe('100.00');
  });

  it('is zero for a PENDING payment', () => {
    const result = computeNetContribution({
      status: 'PENDING',
      amount: d('100.00'),
      refundedTotal: d('0.00'),
    });
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('is zero for REJECTED/CANCELLED/FAILED payments', () => {
    for (const status of ['REJECTED', 'CANCELLED', 'FAILED'] as const) {
      const result = computeNetContribution({
        status,
        amount: d('100.00'),
        refundedTotal: d('0.00'),
      });
      expect(result.toFixed(2)).toBe('0.00');
    }
  });

  it('subtracts partial refunds from a CONFIRMED payment (D-019 partial-refund rule)', () => {
    const result = computeNetContribution({
      status: 'CONFIRMED',
      amount: d('100.00'),
      refundedTotal: d('30.00'),
    });
    expect(result.toFixed(2)).toBe('70.00');
  });

  it('is exactly zero, never negative, for a fully REFUNDED payment (D-019 corrected formula)', () => {
    const result = computeNetContribution({
      status: 'REFUNDED',
      amount: d('100.00'),
      refundedTotal: d('100.00'),
    });
    expect(result.toFixed(2)).toBe('0.00');
    expect(result.isNegative()).toBe(false);
  });

  it('is zero for a REVERSED payment', () => {
    const result = computeNetContribution({
      status: 'REVERSED',
      amount: d('100.00'),
      refundedTotal: d('0.00'),
    });
    expect(result.toFixed(2)).toBe('0.00');
  });
});

describe('computeNetConfirmedAmountPaid', () => {
  it('sums the net contribution of every payment', () => {
    const total = computeNetConfirmedAmountPaid([
      { status: 'CONFIRMED', amount: d('100.00'), refundedTotal: d('0.00') },
      { status: 'CONFIRMED', amount: d('50.00'), refundedTotal: d('20.00') },
      { status: 'PENDING', amount: d('999.00'), refundedTotal: d('0.00') },
      { status: 'REFUNDED', amount: d('40.00'), refundedTotal: d('40.00') },
    ]);
    expect(total.toFixed(2)).toBe('130.00');
  });

  it('is zero for an empty payment list', () => {
    expect(computeNetConfirmedAmountPaid([]).toFixed(2)).toBe('0.00');
  });
});

describe('computeRemainingBalance', () => {
  it('is total minus paid when positive', () => {
    expect(computeRemainingBalance(d('500.00'), d('200.00')).toFixed(2)).toBe('300.00');
  });

  it('floors at zero on overpayment, never negative', () => {
    const result = computeRemainingBalance(d('500.00'), d('600.00'));
    expect(result.toFixed(2)).toBe('0.00');
    expect(result.isNegative()).toBe(false);
  });
});

describe('computeOverpayment', () => {
  it('is zero when paid does not exceed total', () => {
    expect(computeOverpayment(d('500.00'), d('500.00')).toFixed(2)).toBe('0.00');
  });

  it('is the excess when paid exceeds total', () => {
    expect(computeOverpayment(d('500.00'), d('600.00')).toFixed(2)).toBe('100.00');
  });
});

describe('computeNetActiveAllocation', () => {
  it('sums active allocations against CONFIRMED/REFUNDED payments only', () => {
    const result = computeNetActiveAllocation([
      {
        amount: d('50.00'),
        paymentStatus: 'CONFIRMED',
        isReversed: false,
        refundAllocatedTotal: d('0.00'),
      },
      {
        amount: d('999.00'),
        paymentStatus: 'PENDING',
        isReversed: false,
        refundAllocatedTotal: d('0.00'),
      },
    ]);
    expect(result.toFixed(2)).toBe('50.00');
  });

  it('excludes a reversed allocation entirely', () => {
    const result = computeNetActiveAllocation([
      {
        amount: d('50.00'),
        paymentStatus: 'CONFIRMED',
        isReversed: true,
        refundAllocatedTotal: d('0.00'),
      },
    ]);
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('subtracts refund-allocated amounts against an active allocation', () => {
    const result = computeNetActiveAllocation([
      {
        amount: d('80.00'),
        paymentStatus: 'CONFIRMED',
        isReversed: false,
        refundAllocatedTotal: d('30.00'),
      },
    ]);
    expect(result.toFixed(2)).toBe('50.00');
  });

  it('is zero for an empty allocation list (no allocations yet)', () => {
    expect(computeNetActiveAllocation([]).toFixed(2)).toBe('0.00');
  });
});

describe('computeUnappliedCredit', () => {
  it('is the full confirmed amount when no allocations exist yet', () => {
    expect(computeUnappliedCredit(d('100.00'), []).toFixed(2)).toBe('100.00');
  });

  it('subtracts total active allocation across every installment', () => {
    expect(computeUnappliedCredit(d('100.00'), [d('30.00'), d('20.00')]).toFixed(2)).toBe('50.00');
  });
});

describe('computeOutstandingInstallmentAmount', () => {
  it('is the remaining unallocated amount', () => {
    expect(computeOutstandingInstallmentAmount(d('100.00'), d('40.00')).toFixed(2)).toBe('60.00');
  });

  it('floors at zero when fully allocated or over-allocated', () => {
    expect(computeOutstandingInstallmentAmount(d('100.00'), d('100.00')).toFixed(2)).toBe('0.00');
    expect(computeOutstandingInstallmentAmount(d('100.00'), d('150.00')).toFixed(2)).toBe('0.00');
  });
});

describe('computeNextPaymentDue', () => {
  it('returns the earliest due date among installments with a positive outstanding amount', () => {
    const result = computeNextPaymentDue([
      { dueDate: new Date('2026-03-01'), outstandingAmount: d('0.00') },
      { dueDate: new Date('2026-02-01'), outstandingAmount: d('10.00') },
      { dueDate: new Date('2026-04-01'), outstandingAmount: d('5.00') },
    ]);
    expect(result?.toISOString()).toBe(new Date('2026-02-01').toISOString());
  });

  it('returns null when every installment is fully paid', () => {
    const result = computeNextPaymentDue([
      { dueDate: new Date('2026-03-01'), outstandingAmount: d('0.00') },
    ]);
    expect(result).toBeNull();
  });

  it('returns null for an empty installment list', () => {
    expect(computeNextPaymentDue([])).toBeNull();
  });
});
