import { Prisma } from '@/generated/prisma/client';

import {
  computeNetActiveAllocation,
  computeNetContribution,
  computeOutstandingInstallmentAmount,
} from './calculations';
import { formatAmount, formatDateOnly, formatManilaTimestamp } from './export-csv';
import type {
  AllocationExportRecord,
  InstallmentExportRecord,
  PaymentExportRecord,
  RefundExportRecord,
} from './export-repository';
import type { FinanceExportDataset } from './export-schemas';
import type { buildBookingPaymentSummary } from './service';

// Row shaping for basic finance exports (D-061 §3, D-062): already-fetched
// records in, ordered text cells out. Pure. Every derived value comes from
// calculations.ts — the same functions the staff and client summaries use —
// never from a second implementation. Every conversion of a value to text
// happens here, inside the export transaction and before the audit entry
// is inserted, so a conversion failure writes no entry (D-062 clause 2).
// The integrity checks of D-062 clause 7 happen here too, for the same
// reason: a refusal rolls the transaction back.

/** The exact header row of each dataset, in order (D-061 §3). */
export const FINANCE_EXPORT_COLUMNS = {
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
} as const satisfies Record<FinanceExportDataset, readonly string[]>;

// A value that does not exist is an empty field, never a zero (D-061 §3).
const BLANK = '';

function sumAmounts(items: readonly { amount: Prisma.Decimal }[]): Prisma.Decimal {
  return items.reduce((total, item) => total.plus(item.amount), new Prisma.Decimal(0));
}

/**
 * D-062 clause 7: stored data that breaks one of the listed invariants
 * refuses the whole export — no blank is substituted, no value clamped, no
 * row left out, nothing stored is changed. A plain `Error`, deliberately
 * not a `PaymentError` and not a request error: like every other integrity
 * backstop in this codebase (D-055) it propagates as an unknown error to
 * the generic response. The message names the column and nothing from the
 * data — no reference, name, identifier, or amount.
 */
function integrityFailure(column: string): Error {
  return new Error(`Finance export refused: stored data failed the integrity check for ${column}.`);
}

/**
 * A row's required currency. A Booking with a Payment or a PaymentPlan has
 * one (D-019; D-054 §17 Rule 4), which the payments service enforces; the
 * database column is nullable. `bookings` reads only Bookings whose
 * financials are set, so it cannot meet the failing case.
 */
function requireCurrencyCode(column: string, currencyCode: string | null): string {
  if (currencyCode === null) throw integrityFailure(column);
  return currencyCode;
}

/**
 * One of the five derived values D-019's formulas do not floor at zero.
 * D-019 has the service guarantee, at write time, that unapplied Booking
 * credit and every net active allocation never become negative, and that a
 * Payment's active allocations never exceed its net contribution; no
 * database constraint does. Used for exactly those columns — stored
 * amounts and the derived values D-019 floors are not rechecked.
 */
function formatNonNegativeDerived(column: string, value: Prisma.Decimal): string {
  if (value.lessThan(0)) throw integrityFailure(column);
  return formatAmount(value);
}

function formatBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

export function shapeBookingRow(
  input: {
    summary: ReturnType<typeof buildBookingPaymentSummary>;
    planStatus: string | null;
    clientFullName: string;
  },
  asOf: string,
): string[] {
  const { summary } = input;
  // Not a business rule: `bookings` reads only Bookings whose total is set
  // (export-repository.ts's `bookingExportWhere`, D-061 §3), so this cannot
  // be reached through the export. It narrows the summary's nullable types.
  if (
    summary.totalAmount === null ||
    summary.remainingBalance === null ||
    summary.overpayment === null
  ) {
    throw new Error('A finance export booking row has no total amount.');
  }
  // The next due date and amount come from the approved plan only; a
  // proposed plan's installments can still change (D-061 §3).
  const nextDue = summary.planApproved ? summary.nextPaymentDue : null;
  const nextDueAmount = summary.planApproved ? summary.nextPaymentDueAmount : null;
  return [
    summary.bookingReference,
    input.clientFullName,
    requireCurrencyCode('bookings.currencyCode', summary.currencyCode),
    formatAmount(summary.totalAmount),
    formatAmount(summary.confirmedAmountPaid),
    formatAmount(summary.remainingBalance),
    formatAmount(summary.overpayment),
    formatNonNegativeDerived('bookings.derivedUnappliedCredit', summary.unappliedCredit),
    nextDue !== null ? formatDateOnly(nextDue) : BLANK,
    nextDueAmount !== null ? formatAmount(nextDueAmount) : BLANK,
    input.planStatus ?? BLANK,
    asOf,
  ];
}

export function shapePaymentRow(payment: PaymentExportRecord, asOf: string): string[] {
  const statusTime = (status: PaymentExportRecord['status']): string => {
    const change = payment.statusHistory.find((entry) => entry.newStatus === status);
    return change ? formatManilaTimestamp(change.createdAt) : BLANK;
  };
  const refundedTotal = sumAmounts(payment.refunds);
  const netContribution = computeNetContribution({
    status: payment.status,
    amount: payment.amount,
    refundedTotal,
  });
  const netAllocated = computeNetActiveAllocation(
    payment.allocations.map((allocation) => ({
      amount: allocation.amount,
      paymentStatus: payment.status,
      isReversed: allocation.reversal !== null,
      refundAllocatedTotal: sumAmounts(allocation.refundAllocations),
    })),
  );
  return [
    payment.id,
    payment.booking.bookingReference,
    // The Booking's client, not whoever paid: the system records no payer
    // (D-061 §7).
    payment.booking.client.fullName,
    requireCurrencyCode('payments.currencyCode', payment.booking.currencyCode),
    formatAmount(payment.amount),
    payment.status,
    // D-062 clause 5: when the payment was entered, not when money arrived.
    formatManilaTimestamp(payment.createdAt),
    statusTime('CONFIRMED'),
    statusTime('REVERSED'),
    statusTime('REFUNDED'),
    formatAmount(refundedTotal),
    formatAmount(netContribution),
    formatNonNegativeDerived('payments.derivedNetAllocated', netAllocated),
    formatNonNegativeDerived('payments.derivedUnallocated', netContribution.minus(netAllocated)),
    payment.receipt ? payment.receipt.receiptNumber : BLANK,
    payment.receipt ? formatManilaTimestamp(payment.receipt.issuedAt) : BLANK,
    asOf,
  ];
}

export function shapeRefundRow(refund: RefundExportRecord, asOf: string): string[] {
  return [
    refund.id,
    refund.paymentId,
    refund.payment.booking.bookingReference,
    requireCurrencyCode('refunds.currencyCode', refund.payment.booking.currencyCode),
    formatAmount(refund.amount),
    formatManilaTimestamp(refund.performedAt),
    formatAmount(sumAmounts(refund.refundAllocations)),
    asOf,
  ];
}

export function shapeAllocationRow(allocation: AllocationExportRecord, asOf: string): string[] {
  const isReversed = allocation.reversal !== null;
  const refundedThroughAllocation = sumAmounts(allocation.refundAllocations);
  return [
    allocation.id,
    allocation.paymentId,
    allocation.payment.status,
    allocation.payment.booking.bookingReference,
    requireCurrencyCode('allocations.currencyCode', allocation.payment.booking.currencyCode),
    String(allocation.installment.sequenceNumber),
    formatBoolean(allocation.installment.isDeposit),
    formatDateOnly(allocation.installment.dueDate),
    formatAmount(allocation.amount),
    formatManilaTimestamp(allocation.allocatedAt),
    formatBoolean(isReversed),
    allocation.reversal ? formatManilaTimestamp(allocation.reversal.createdAt) : BLANK,
    formatAmount(refundedThroughAllocation),
    formatNonNegativeDerived(
      'allocations.derivedNetActive',
      computeNetActiveAllocation([
        {
          amount: allocation.amount,
          paymentStatus: allocation.payment.status,
          isReversed,
          refundAllocatedTotal: refundedThroughAllocation,
        },
      ]),
    ),
    asOf,
  ];
}

export function shapeInstallmentRow(installment: InstallmentExportRecord, asOf: string): string[] {
  const netActiveAllocation = computeNetActiveAllocation(
    installment.allocations.map((allocation) => ({
      amount: allocation.amount,
      paymentStatus: allocation.payment.status,
      isReversed: allocation.reversal !== null,
      refundAllocatedTotal: sumAmounts(allocation.refundAllocations),
    })),
  );
  return [
    installment.paymentPlan.booking.bookingReference,
    requireCurrencyCode('installments.currencyCode', installment.paymentPlan.booking.currencyCode),
    String(installment.sequenceNumber),
    formatBoolean(installment.isDeposit),
    formatAmount(installment.amount),
    formatDateOnly(installment.dueDate),
    formatNonNegativeDerived('installments.derivedNetActiveAllocation', netActiveAllocation),
    formatAmount(computeOutstandingInstallmentAmount(installment.amount, netActiveAllocation)),
    asOf,
  ];
}
