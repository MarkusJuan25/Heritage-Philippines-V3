import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import type {
  AllocationExportRecord,
  InstallmentExportRecord,
  PaymentExportRecord,
  RefundExportRecord,
} from './export-repository';
import {
  FINANCE_EXPORT_COLUMNS,
  shapeAllocationRow,
  shapeBookingRow,
  shapeInstallmentRow,
  shapePaymentRow,
  shapeRefundRow,
} from './export-rows';

const AS_OF = '2026-10-06T09:00:00.000+08:00';
const REFERENCE = 'HPB-0123456789ABCDEF0123';
const money = (value: string) => new Prisma.Decimal(value);
const booking = { bookingReference: REFERENCE, currencyCode: 'PHP' };
const INTEGRITY = (column: string) =>
  `Finance export refused: stored data failed the integrity check for ${column}.`;

function asRecord<Dataset extends keyof typeof FINANCE_EXPORT_COLUMNS>(
  dataset: Dataset,
  row: string[],
): Record<(typeof FINANCE_EXPORT_COLUMNS)[Dataset][number], string> {
  const columns: readonly string[] = FINANCE_EXPORT_COLUMNS[dataset];
  expect(row).toHaveLength(columns.length);
  return Object.fromEntries(columns.map((column, index) => [column, row[index]])) as Record<
    (typeof FINANCE_EXPORT_COLUMNS)[Dataset][number],
    string
  >;
}

describe('FINANCE_EXPORT_COLUMNS', () => {
  it('holds the exact header rows of D-061 §3', () => {
    expect(FINANCE_EXPORT_COLUMNS).toEqual({
      bookings: [
        'bookingReference',
        'clientFullName',
        'currencyCode',
        'bookingTotalAmount',
        'derivedNetConfirmedPaid',
        'derivedRemainingBalance',
        'derivedOverpayment',
        'derivedUnappliedCredit',
        'derivedNextDueDate',
        'derivedNextDueOutstandingAmount',
        'paymentPlanStatus',
        'asOf',
      ],
      payments: [
        'paymentId',
        'bookingReference',
        'clientFullName',
        'currencyCode',
        'amount',
        'status',
        'recordedAt',
        'confirmedAt',
        'reversedAt',
        'fullyRefundedAt',
        'derivedRefundedTotal',
        'derivedNetContribution',
        'derivedNetAllocated',
        'derivedUnallocated',
        'receiptNumber',
        'receiptIssuedAt',
        'asOf',
      ],
      refunds: [
        'refundId',
        'paymentId',
        'bookingReference',
        'currencyCode',
        'amount',
        'performedAt',
        'derivedAllocatedPortion',
        'asOf',
      ],
      allocations: [
        'allocationId',
        'paymentId',
        'paymentStatus',
        'bookingReference',
        'currencyCode',
        'installmentSequenceNumber',
        'installmentIsDeposit',
        'installmentDueDate',
        'amount',
        'allocatedAt',
        'reversed',
        'reversedAt',
        'derivedRefundedThroughAllocation',
        'derivedNetActive',
        'asOf',
      ],
      installments: [
        'bookingReference',
        'currencyCode',
        'sequenceNumber',
        'isDeposit',
        'amount',
        'dueDate',
        'derivedNetActiveAllocation',
        'derivedOutstandingAmount',
        'asOf',
      ],
    });
  });

  it('names no status, overdue, reason, or contact column', () => {
    const all = Object.values(FINANCE_EXPORT_COLUMNS).flat().join(' ').toLowerCase();
    for (const forbidden of ['overdue', 'reason', 'email', 'phone', 'address', 'method']) {
      expect(all).not.toContain(forbidden);
    }
    expect(FINANCE_EXPORT_COLUMNS.installments).not.toContain('status');
  });
});

describe('shapeBookingRow', () => {
  const summary = {
    bookingId: 'booking-1',
    bookingReference: REFERENCE,
    totalAmount: money('1000.00'),
    currencyCode: 'PHP',
    planApproved: true,
    confirmedAmountPaid: money('400.00'),
    remainingBalance: money('600.00'),
    overpayment: money('0'),
    unappliedCredit: money('100.00'),
    nextPaymentDue: new Date('2026-11-01T00:00:00.000Z'),
    nextPaymentDueAmount: money('250.00'),
    installments: [],
    payments: [],
  };

  it('writes every column for a Booking with an approved plan', () => {
    const row = asRecord(
      'bookings',
      shapeBookingRow({ summary, planStatus: 'APPROVED', clientFullName: 'Juan Dela Cruz' }, AS_OF),
    );
    expect(row).toEqual({
      bookingReference: REFERENCE,
      clientFullName: 'Juan Dela Cruz',
      currencyCode: 'PHP',
      bookingTotalAmount: '1000.00',
      derivedNetConfirmedPaid: '400.00',
      derivedRemainingBalance: '600.00',
      derivedOverpayment: '0.00',
      derivedUnappliedCredit: '100.00',
      derivedNextDueDate: '2026-11-01',
      derivedNextDueOutstandingAmount: '250.00',
      paymentPlanStatus: 'APPROVED',
      asOf: AS_OF,
    });
  });

  it('leaves the next-due columns blank for a proposed plan, never zero', () => {
    const row = asRecord(
      'bookings',
      shapeBookingRow(
        {
          summary: { ...summary, planApproved: false },
          planStatus: 'PROPOSED',
          clientFullName: 'A',
        },
        AS_OF,
      ),
    );
    expect(row.derivedNextDueDate).toBe('');
    expect(row.derivedNextDueOutstandingAmount).toBe('');
    expect(row.paymentPlanStatus).toBe('PROPOSED');
  });

  it('leaves the plan status and next-due columns blank when there is no plan', () => {
    const row = asRecord(
      'bookings',
      shapeBookingRow(
        {
          summary: {
            ...summary,
            planApproved: false,
            nextPaymentDue: null,
            nextPaymentDueAmount: null,
          },
          planStatus: null,
          clientFullName: 'A',
        },
        AS_OF,
      ),
    );
    expect(row.paymentPlanStatus).toBe('');
    expect(row.derivedNextDueDate).toBe('');
    expect(row.derivedNextDueOutstandingAmount).toBe('');
  });

  it('refuses a Booking whose unapplied credit is negative', () => {
    expect(() =>
      shapeBookingRow(
        {
          summary: { ...summary, unappliedCredit: money('-50.00') },
          planStatus: 'APPROVED',
          clientFullName: 'A',
        },
        AS_OF,
      ),
    ).toThrow(INTEGRITY('bookings.derivedUnappliedCredit'));
  });

  it('leaves the next-due columns blank when an approved plan has nothing outstanding', () => {
    const row = asRecord(
      'bookings',
      shapeBookingRow(
        {
          summary: { ...summary, nextPaymentDue: null, nextPaymentDueAmount: null },
          planStatus: 'APPROVED',
          clientFullName: 'A',
        },
        AS_OF,
      ),
    );
    expect(row.derivedNextDueDate).toBe('');
    expect(row.derivedNextDueOutstandingAmount).toBe('');
  });

  it('cannot shape a Booking without financials, which the bookings query never returns', () => {
    expect(() =>
      shapeBookingRow(
        {
          summary: { ...summary, totalAmount: null, remainingBalance: null, overpayment: null },
          planStatus: null,
          clientFullName: 'A',
        },
        AS_OF,
      ),
    ).toThrow(/no total amount/);
  });
});

describe('shapePaymentRow', () => {
  const base: PaymentExportRecord = {
    id: 'payment-1',
    amount: money('200.00'),
    status: 'PENDING',
    createdAt: new Date('2026-10-01T02:00:00.000Z'),
    booking: { ...booking, client: { fullName: 'Juan Dela Cruz' } },
    statusHistory: [],
    refunds: [],
    receipt: null,
    allocations: [],
  };

  it('leaves the five blankable columns blank for a pending payment', () => {
    const row = asRecord('payments', shapePaymentRow(base, AS_OF));
    expect(row).toEqual({
      paymentId: 'payment-1',
      bookingReference: REFERENCE,
      clientFullName: 'Juan Dela Cruz',
      currencyCode: 'PHP',
      amount: '200.00',
      status: 'PENDING',
      recordedAt: '2026-10-01T10:00:00.000+08:00',
      confirmedAt: '',
      reversedAt: '',
      fullyRefundedAt: '',
      derivedRefundedTotal: '0.00',
      derivedNetContribution: '0.00',
      derivedNetAllocated: '0.00',
      derivedUnallocated: '0.00',
      receiptNumber: '',
      receiptIssuedAt: '',
      asOf: AS_OF,
    });
  });

  it('shows a partly refunded, partly allocated confirmed payment', () => {
    const row = asRecord(
      'payments',
      shapePaymentRow(
        {
          ...base,
          status: 'CONFIRMED',
          statusHistory: [
            { newStatus: 'CONFIRMED', createdAt: new Date('2026-10-02T02:00:00.123Z') },
          ],
          refunds: [{ amount: money('50.00') }, { amount: money('30.00') }],
          receipt: { receiptNumber: 'HPR-1', issuedAt: new Date('2026-10-02T03:00:00.000Z') },
          allocations: [
            {
              amount: money('100.00'),
              reversal: null,
              refundAllocations: [{ amount: money('50.00') }],
            },
            { amount: money('40.00'), reversal: { id: 'reversal-1' }, refundAllocations: [] },
          ],
        },
        AS_OF,
      ),
    );
    expect(row.confirmedAt).toBe('2026-10-02T10:00:00.123+08:00');
    expect(row.derivedRefundedTotal).toBe('80.00');
    expect(row.derivedNetContribution).toBe('120.00');
    // 100.00 less the 50.00 refunded through it; the reversed 40.00 counts for nothing.
    expect(row.derivedNetAllocated).toBe('50.00');
    expect(row.derivedUnallocated).toBe('70.00');
    expect(row.receiptNumber).toBe('HPR-1');
    expect(row.receiptIssuedAt).toBe('2026-10-02T11:00:00.000+08:00');
  });

  it('shows a reversed payment as one row with a positive amount and no contribution', () => {
    const row = asRecord(
      'payments',
      shapePaymentRow(
        {
          ...base,
          status: 'REVERSED',
          statusHistory: [
            { newStatus: 'CONFIRMED', createdAt: new Date('2026-10-02T02:00:00.000Z') },
            { newStatus: 'REVERSED', createdAt: new Date('2026-10-03T02:00:00.000Z') },
          ],
          allocations: [{ amount: money('80.00'), reversal: null, refundAllocations: [] }],
        },
        AS_OF,
      ),
    );
    expect(row.amount).toBe('200.00');
    expect(row.reversedAt).toBe('2026-10-03T10:00:00.000+08:00');
    expect(row.derivedNetContribution).toBe('0.00');
    expect(row.derivedNetAllocated).toBe('0.00');
    expect(row.derivedUnallocated).toBe('0.00');
  });

  it('shows a fully refunded payment contributing exactly zero, never a negative amount', () => {
    const row = asRecord(
      'payments',
      shapePaymentRow(
        {
          ...base,
          status: 'REFUNDED',
          statusHistory: [
            { newStatus: 'CONFIRMED', createdAt: new Date('2026-10-02T02:00:00.000Z') },
            { newStatus: 'REFUNDED', createdAt: new Date('2026-10-04T02:00:00.000Z') },
          ],
          refunds: [{ amount: money('200.00') }],
        },
        AS_OF,
      ),
    );
    expect(row.fullyRefundedAt).toBe('2026-10-04T10:00:00.000+08:00');
    expect(row.derivedRefundedTotal).toBe('200.00');
    expect(row.derivedNetContribution).toBe('0.00');
  });

  it('refuses a row whose required currency is missing, naming the column only', () => {
    expect(() =>
      shapePaymentRow({ ...base, booking: { ...base.booking, currencyCode: null } }, AS_OF),
    ).toThrow(INTEGRITY('payments.currencyCode'));
  });

  it('refuses a payment whose active allocations exceed its net contribution', () => {
    expect(() =>
      shapePaymentRow(
        {
          ...base,
          amount: money('100.00'),
          status: 'CONFIRMED',
          allocations: [{ amount: money('150.00'), reversal: null, refundAllocations: [] }],
        },
        AS_OF,
      ),
    ).toThrow(INTEGRITY('payments.derivedUnallocated'));
  });

  it('refuses a payment whose net allocated value is negative', () => {
    expect(() =>
      shapePaymentRow(
        {
          ...base,
          status: 'CONFIRMED',
          allocations: [
            {
              amount: money('50.00'),
              reversal: null,
              refundAllocations: [{ amount: money('80.00') }],
            },
          ],
        },
        AS_OF,
      ),
    ).toThrow(INTEGRITY('payments.derivedNetAllocated'));
  });

  it('accepts exact zeros: nothing unallocated and nothing allocated are not violations', () => {
    const row = asRecord(
      'payments',
      shapePaymentRow(
        {
          ...base,
          status: 'CONFIRMED',
          allocations: [{ amount: money('200.00'), reversal: null, refundAllocations: [] }],
        },
        AS_OF,
      ),
    );
    expect(row.derivedUnallocated).toBe('0.00');
  });

  it('keeps client data out of the refusal', () => {
    let message = '';
    try {
      shapePaymentRow({ ...base, booking: { ...base.booking, currencyCode: null } }, AS_OF);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const secret of [REFERENCE, 'Juan', 'payment-1', '200.00']) {
      expect(message).not.toContain(secret);
    }
  });
});

describe('shapeRefundRow', () => {
  const base: RefundExportRecord = {
    id: 'refund-1',
    paymentId: 'payment-1',
    amount: money('50.00'),
    performedAt: new Date('2026-10-05T16:30:00.000Z'),
    payment: { booking },
    refundAllocations: [],
  };

  it('writes 0.00, not a blank, when the refund has no allocated portion', () => {
    expect(asRecord('refunds', shapeRefundRow(base, AS_OF))).toEqual({
      refundId: 'refund-1',
      paymentId: 'payment-1',
      bookingReference: REFERENCE,
      currencyCode: 'PHP',
      amount: '50.00',
      performedAt: '2026-10-06T00:30:00.000+08:00',
      derivedAllocatedPortion: '0.00',
      asOf: AS_OF,
    });
  });

  it('refuses a refund whose required currency is missing', () => {
    expect(() =>
      shapeRefundRow({ ...base, payment: { booking: { ...booking, currencyCode: null } } }, AS_OF),
    ).toThrow(INTEGRITY('refunds.currencyCode'));
  });

  it('sums the refund-allocation rows', () => {
    const row = asRecord(
      'refunds',
      shapeRefundRow(
        { ...base, refundAllocations: [{ amount: money('20.00') }, { amount: money('15.50') }] },
        AS_OF,
      ),
    );
    expect(row.derivedAllocatedPortion).toBe('35.50');
  });
});

describe('shapeAllocationRow', () => {
  const base: AllocationExportRecord = {
    id: 'allocation-1',
    paymentId: 'payment-1',
    amount: money('100.00'),
    allocatedAt: new Date('2026-10-02T04:00:00.000Z'),
    payment: { status: 'CONFIRMED', booking },
    installment: {
      sequenceNumber: 2,
      isDeposit: false,
      dueDate: new Date('2026-12-01T00:00:00.000Z'),
    },
    reversal: null,
    refundAllocations: [{ amount: money('30.00') }],
  };

  it('writes an active allocation', () => {
    expect(asRecord('allocations', shapeAllocationRow(base, AS_OF))).toEqual({
      allocationId: 'allocation-1',
      paymentId: 'payment-1',
      paymentStatus: 'CONFIRMED',
      bookingReference: REFERENCE,
      currencyCode: 'PHP',
      installmentSequenceNumber: '2',
      installmentIsDeposit: 'false',
      installmentDueDate: '2026-12-01',
      amount: '100.00',
      allocatedAt: '2026-10-02T12:00:00.000+08:00',
      reversed: 'false',
      reversedAt: '',
      derivedRefundedThroughAllocation: '30.00',
      derivedNetActive: '70.00',
      asOf: AS_OF,
    });
  });

  it('refuses an allocation refunded through for more than its amount', () => {
    expect(() =>
      shapeAllocationRow({ ...base, refundAllocations: [{ amount: money('130.00') }] }, AS_OF),
    ).toThrow(INTEGRITY('allocations.derivedNetActive'));
  });

  it('refuses an allocation whose required currency is missing', () => {
    expect(() =>
      shapeAllocationRow(
        { ...base, payment: { status: 'CONFIRMED', booking: { ...booking, currencyCode: null } } },
        AS_OF,
      ),
    ).toThrow(INTEGRITY('allocations.currencyCode'));
  });

  it('keeps a reversed allocation as one row with a positive amount and no net value', () => {
    const row = asRecord(
      'allocations',
      shapeAllocationRow(
        {
          ...base,
          refundAllocations: [],
          reversal: { createdAt: new Date('2026-10-03T04:00:00.000Z') },
        },
        AS_OF,
      ),
    );
    expect(row.amount).toBe('100.00');
    expect(row.reversed).toBe('true');
    expect(row.reversedAt).toBe('2026-10-03T12:00:00.000+08:00');
    expect(row.derivedNetActive).toBe('0.00');
  });

  it('explains a zero net value by the payment status when the payment was reversed', () => {
    const row = asRecord(
      'allocations',
      shapeAllocationRow(
        { ...base, refundAllocations: [], payment: { status: 'REVERSED', booking } },
        AS_OF,
      ),
    );
    expect(row.paymentStatus).toBe('REVERSED');
    expect(row.reversed).toBe('false');
    expect(row.reversedAt).toBe('');
    expect(row.derivedNetActive).toBe('0.00');
  });
});

describe('shapeInstallmentRow', () => {
  const base: InstallmentExportRecord = {
    sequenceNumber: 1,
    isDeposit: true,
    amount: money('400.00'),
    dueDate: new Date('2026-11-01T00:00:00.000Z'),
    paymentPlan: { booking },
    allocations: [
      {
        amount: money('300.00'),
        reversal: null,
        refundAllocations: [],
        payment: { status: 'CONFIRMED' },
      },
      {
        amount: money('100.00'),
        reversal: null,
        refundAllocations: [{ amount: money('50.00') }],
        payment: { status: 'CONFIRMED' },
      },
      {
        amount: money('75.00'),
        reversal: { id: 'reversal-1' },
        refundAllocations: [],
        payment: { status: 'CONFIRMED' },
      },
      {
        amount: money('60.00'),
        reversal: null,
        refundAllocations: [],
        payment: { status: 'REVERSED' },
      },
    ],
  };

  it('counts only active allocations, less refunds applied through them', () => {
    expect(asRecord('installments', shapeInstallmentRow(base, AS_OF))).toEqual({
      bookingReference: REFERENCE,
      currencyCode: 'PHP',
      sequenceNumber: '1',
      isDeposit: 'true',
      amount: '400.00',
      dueDate: '2026-11-01',
      derivedNetActiveAllocation: '350.00',
      derivedOutstandingAmount: '50.00',
      asOf: AS_OF,
    });
  });

  it('refuses an installment whose net active allocation is negative', () => {
    expect(() =>
      shapeInstallmentRow(
        {
          ...base,
          allocations: [
            {
              amount: money('50.00'),
              reversal: null,
              refundAllocations: [{ amount: money('80.00') }],
              payment: { status: 'CONFIRMED' },
            },
          ],
        },
        AS_OF,
      ),
    ).toThrow(INTEGRITY('installments.derivedNetActiveAllocation'));
  });

  it('refuses an installment whose required currency is missing', () => {
    expect(() =>
      shapeInstallmentRow(
        { ...base, paymentPlan: { booking: { ...booking, currencyCode: null } } },
        AS_OF,
      ),
    ).toThrow(INTEGRITY('installments.currencyCode'));
  });

  it('floors the outstanding amount at zero', () => {
    const row = asRecord(
      'installments',
      shapeInstallmentRow({ ...base, amount: money('300.00') }, AS_OF),
    );
    expect(row.derivedOutstandingAmount).toBe('0.00');
  });

  it('writes 0.00 when nothing is allocated', () => {
    const row = asRecord('installments', shapeInstallmentRow({ ...base, allocations: [] }, AS_OF));
    expect(row.derivedNetActiveAllocation).toBe('0.00');
    expect(row.derivedOutstandingAmount).toBe('400.00');
  });
});
