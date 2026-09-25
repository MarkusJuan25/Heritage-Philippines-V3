import { Prisma } from '@/generated/prisma/client';

// Pure, dependency-free implementations of D-019's exact approved formulas
// (docs/HERITAGE_V3_DECISIONS_LOG.md D-019, restated unchanged by D-054 §5).
// Isolated in their own file, mirroring features/bookings/transitions.ts's
// precedent for pure business-rule logic that deserves focused unit testing
// separate from the transactional service layer that calls it — none of
// these functions reads or writes anything; every input is a plain,
// already-fetched value. All arithmetic uses `Prisma.Decimal` (decimal.js)
// throughout — never a JavaScript `number` — per CLAUDE.md §8 and
// .claude/rules/database-security.md's "Monetary Values" rule.

const ZERO = new Prisma.Decimal(0);

export type PaymentForCalculation = {
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED' | 'FAILED' | 'REFUNDED' | 'REVERSED';
  amount: Prisma.Decimal;
  refundedTotal: Prisma.Decimal;
};

/**
 * D-019's corrected net-contribution formula:
 *   net contribution of Payment P =
 *     CASE WHEN P.status IN (CONFIRMED, REFUNDED)
 *       THEN P.amount - SUM(PaymentRefund.amount WHERE paymentId = P.id)
 *       ELSE 0
 *     END
 * `refundedTotal` is the caller's already-summed `SUM(PaymentRefund.amount)`
 * for this Payment — this function performs no aggregation itself.
 */
export function computeNetContribution(payment: PaymentForCalculation): Prisma.Decimal {
  if (payment.status !== 'CONFIRMED' && payment.status !== 'REFUNDED') {
    return ZERO;
  }
  const net = payment.amount.minus(payment.refundedTotal);
  return net.isNegative() ? ZERO : net;
}

/** `net confirmed amount paid = SUM(net contribution of every Payment under the Booking)`. */
export function computeNetConfirmedAmountPaid(payments: PaymentForCalculation[]): Prisma.Decimal {
  return payments.reduce((total, payment) => total.plus(computeNetContribution(payment)), ZERO);
}

/** `remaining Booking balance = max(Booking.totalAmount - net confirmed amount paid, 0)`. */
export function computeRemainingBalance(
  totalAmount: Prisma.Decimal,
  netConfirmedAmountPaid: Prisma.Decimal,
): Prisma.Decimal {
  const remaining = totalAmount.minus(netConfirmedAmountPaid);
  return remaining.isNegative() ? ZERO : remaining;
}

/** `overall Booking overpayment = max(net confirmed amount paid - Booking.totalAmount, 0)`. */
export function computeOverpayment(
  totalAmount: Prisma.Decimal,
  netConfirmedAmountPaid: Prisma.Decimal,
): Prisma.Decimal {
  const over = netConfirmedAmountPaid.minus(totalAmount);
  return over.isNegative() ? ZERO : over;
}

export type ActiveAllocationForCalculation = {
  amount: Prisma.Decimal;
  paymentStatus: PaymentForCalculation['status'];
  isReversed: boolean;
  refundAllocatedTotal: Prisma.Decimal;
};

/**
 * D-019's net-active-allocation formula for one Installment:
 *   net active allocation (Installment Y) =
 *       SUM(PaymentAllocation.amount WHERE installmentId = Y
 *           AND payment.status IN (CONFIRMED, REFUNDED)
 *           AND no PaymentAllocationReversal exists for that allocation)
 *     - SUM(PaymentRefundAllocation.amount WHERE paymentAllocationId is
 *           one of the above)
 * The caller supplies each of the Installment's PaymentAllocation rows
 * (already filtered to this Installment) with each row's own Payment status,
 * whether it has been reversed, and its own already-summed
 * `refundAllocatedTotal` (`SUM(PaymentRefundAllocation.amount)` for that one
 * allocation) — this function performs no database read or aggregation
 * itself. The result is never allowed to go negative (D-019's "the service
 * layer must guarantee... every net active allocation >= 0"); the caller
 * (service.ts) is responsible for actively verifying this at write time, not
 * this pure function silently clamping it.
 */
export function computeNetActiveAllocation(
  allocations: ActiveAllocationForCalculation[],
): Prisma.Decimal {
  return allocations.reduce((total, allocation) => {
    if (allocation.isReversed) return total;
    if (allocation.paymentStatus !== 'CONFIRMED' && allocation.paymentStatus !== 'REFUNDED') {
      return total;
    }
    return total.plus(allocation.amount).minus(allocation.refundAllocatedTotal);
  }, ZERO);
}

/**
 * `unapplied Booking credit = net confirmed amount paid - SUM(net active
 * allocation across every Installment in the Booking's PaymentPlan)`.
 * `netActiveAllocationsByInstallment` is the caller's already-computed
 * per-Installment result of `computeNetActiveAllocation` above, one entry
 * per Installment in the Booking's PaymentPlan (an empty array — no
 * PaymentPlan or no Installments yet — correctly yields the full
 * `netConfirmedAmountPaid` as unapplied credit).
 */
export function computeUnappliedCredit(
  netConfirmedAmountPaid: Prisma.Decimal,
  netActiveAllocationsByInstallment: Prisma.Decimal[],
): Prisma.Decimal {
  const totalAllocated = netActiveAllocationsByInstallment.reduce(
    (total, allocation) => total.plus(allocation),
    ZERO,
  );
  return netConfirmedAmountPaid.minus(totalAllocated);
}

/** `outstanding Installment amount = max(Installment.amount - net active allocation, 0)`. */
export function computeOutstandingInstallmentAmount(
  installmentAmount: Prisma.Decimal,
  netActiveAllocation: Prisma.Decimal,
): Prisma.Decimal {
  const outstanding = installmentAmount.minus(netActiveAllocation);
  return outstanding.isNegative() ? ZERO : outstanding;
}

export type InstallmentForNextDue = { dueDate: Date; outstandingAmount: Prisma.Decimal };

/**
 * `next payment due = earliest dueDate among installments with outstanding
 * amount > 0`. Returns `null` when no Installment has a positive outstanding
 * amount (fully paid, or no Installments exist).
 */
export function computeNextPaymentDue(installments: InstallmentForNextDue[]): Date | null {
  let earliest: Date | null = null;
  for (const installment of installments) {
    if (!installment.outstandingAmount.greaterThan(ZERO)) continue;
    if (earliest === null || installment.dueDate.getTime() < earliest.getTime()) {
      earliest = installment.dueDate;
    }
  }
  return earliest;
}
