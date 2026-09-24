import { randomUUID } from 'node:crypto';

import { Prisma, PaymentStatus } from '@/generated/prisma/client';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a Prisma client or transaction client as its first
// argument, mirroring features/bookings/repository.ts exactly, so callers
// can run reads inside the same serializable transaction as the writes they
// gate.
//
// `Booking` itself is queried directly here (never through the bookings
// feature's own repository/service) for the specific financial fields
// (`totalAmount`, `currencyCode`) and the booking-level `StaffAssignment`
// scoping Payments needs, neither of which
// features/bookings/repository.ts's `BOOKING_SELECT` exposes. This mirrors
// this codebase's own established precedent of a feature querying a shared,
// foundational table directly (features/bookings/repository.ts itself
// queries `Client` directly for its own `clientAssignmentFilter`) — Booking
// is the shared system-of-record table every payment-bearing feature reads,
// not bookings/'s own private internal state.

// Narrowed to exactly the three roles the Payments service layer ever
// permits past its own role assertions (service.ts) — ADMIN_MANAGER
// (unconditional visibility, D-054 §3), TRAVEL_CONSULTANT (propose only, own
// assigned Booking), and FINANCE_ACCOUNTING (every mutating operation, own
// assigned Booking). CLIENT never reaches these functions — its own
// ownership-scoped reads are separate functions below, scoped by `clientId`
// directly, never by this filter.
export type PaymentActor = {
  id: string;
  role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' | 'FINANCE_ACCOUNTING';
};

/**
 * The booking-level assignment scoping D-054 §3/§4.7 requires: a
 * TRAVEL_CONSULTANT may act only on "their assigned Booking," and
 * FINANCE_ACCOUNTING's own visibility scope (blueprint §4.4) is explicitly
 * "the bookings assigned to it" — both resolved via `StaffAssignment.bookingId`
 * (the field the Booking Schema Foundation checkpoint added specifically for
 * booking-level assignment), never via the Booking's Client's own
 * assignments (which is a *different*, broader relation
 * features/bookings/repository.ts's own `clientAssignmentFilter` uses for a
 * different purpose — general Booking management, not Payments). This is a
 * deliberate, evidence-based choice for this feature: blueprint's Payment-
 * specific wording speaks in terms of "Booking," not "Client," unlike the
 * Booking feature's own broader assignment model.
 *
 * The filter also matches `role: actor.role` — this is what D-054's Stage 2
 * schema amendment made possible: `StaffAssignment.role` (a snapshot of the
 * assignee's role at assignment-creation time) plus the new
 * `staff_assignment_active_booking_role_key` partial unique index
 * (`(bookingId, role)`, replacing the old bare-`bookingId` one) together
 * allow a Travel Consultant and a Finance/Accounting user to hold
 * simultaneous, independent active assignments on the same Booking — one per
 * role, never two of the same role concurrently. Matching `role` here is
 * required, not optional: without it, a stale `StaffAssignment` row would
 * still satisfy `assignedStaffId: actor.id, endedAt: null` even after that
 * exact person's role changed (e.g. promoted from Travel Consultant to
 * Finance/Accounting), incorrectly granting access under a capacity they no
 * longer hold.
 *
 * Explicitly exhaustive over `PaymentActor`'s three roles, matching
 * `clientAssignmentFilter`'s own exhaustiveness-guard pattern.
 */
function bookingAssignmentFilter(actor: PaymentActor): Prisma.BookingWhereInput | undefined {
  switch (actor.role) {
    case 'ADMIN_MANAGER':
      return undefined;
    case 'TRAVEL_CONSULTANT':
    case 'FINANCE_ACCOUNTING':
      return {
        staffAssignments: {
          some: { assignedStaffId: actor.id, role: actor.role, endedAt: null },
        },
      };
    default: {
      const exhaustiveCheck: never = actor.role;
      throw new Error(`Unhandled PaymentActor role: ${String(exhaustiveCheck)}`);
    }
  }
}

export type BookingFinancials = {
  id: string;
  clientId: string;
  totalAmount: Prisma.Decimal | null;
  currencyCode: string | null;
};

const BOOKING_FINANCIALS_SELECT = {
  id: true,
  clientId: true,
  totalAmount: true,
  currencyCode: true,
} as const;

/** Scoped Booking financials read — see `bookingAssignmentFilter` above for the scoping rationale. */
export async function findBookingFinancialsForActor(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  bookingId: string,
): Promise<BookingFinancials | null> {
  return db.booking.findFirst({
    where: { id: bookingId, ...bookingAssignmentFilter(actor) },
    select: BOOKING_FINANCIALS_SELECT,
  });
}

export type PaymentPlanRecord = {
  id: string;
  bookingId: string;
  clientId: string;
  proposedByStaffUserId: string;
  approvedByStaffUserId: string | null;
  approvedAt: Date | null;
};

const PAYMENT_PLAN_SELECT = {
  id: true,
  bookingId: true,
  clientId: true,
  proposedByStaffUserId: true,
  approvedByStaffUserId: true,
  approvedAt: true,
} as const;

/** The PaymentPlan for a Booking, if any (D-019: at most one per Booking) — scoped to what `actor` may see via the owning Booking. */
export async function findPaymentPlanByBookingIdForActor(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  bookingId: string,
): Promise<PaymentPlanRecord | null> {
  return db.paymentPlan.findFirst({
    where: { bookingId, booking: { ...bookingAssignmentFilter(actor) } },
    select: PAYMENT_PLAN_SELECT,
  });
}

/**
 * A PaymentPlan by its own id, together with its owning Booking's
 * financials — scoped to what `actor` may see. Used by `approvePaymentPlan`
 * (service.ts), which needs both the plan (to write `approvedAt`/
 * `approvedByStaffUserId`) and the Booking's `totalAmount` (for the
 * reconciliation check, the PaymentPlan model's own doc comment in
 * schema.prisma).
 */
export async function findPaymentPlanWithBookingForActor(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  paymentPlanId: string,
): Promise<{ plan: PaymentPlanRecord; booking: BookingFinancials } | null> {
  const row = await db.paymentPlan.findFirst({
    where: { id: paymentPlanId, booking: { ...bookingAssignmentFilter(actor) } },
    select: { ...PAYMENT_PLAN_SELECT, booking: { select: BOOKING_FINANCIALS_SELECT } },
  });
  if (!row) return null;
  const { booking, ...plan } = row;
  return { plan, booking };
}

export type ProposedInstallmentInput = {
  id: string;
  sequenceNumber: number;
  isDeposit: boolean;
  amount: string;
  dueDate: Date;
};

export type CreatePaymentPlanInput = {
  id: string;
  bookingId: string;
  clientId: string;
  proposedByStaffUserId: string;
  installments: ProposedInstallmentInput[];
};

/**
 * Creates a PaymentPlan and all of its proposed Installments as a single
 * nested Prisma write, so both commit or roll back together within whatever
 * transaction `db` belongs to — mirroring
 * `createBookingWithInitialHistory`'s identical nested-write discipline in
 * features/bookings/repository.ts.
 */
export async function createPaymentPlanWithInstallments(
  db: Prisma.TransactionClient,
  input: CreatePaymentPlanInput,
): Promise<PaymentPlanRecord> {
  return db.paymentPlan.create({
    data: {
      id: input.id,
      bookingId: input.bookingId,
      clientId: input.clientId,
      proposedByStaffUserId: input.proposedByStaffUserId,
      installments: {
        create: input.installments.map((installment) => ({
          id: installment.id,
          sequenceNumber: installment.sequenceNumber,
          isDeposit: installment.isDeposit,
          amount: installment.amount,
          dueDate: installment.dueDate,
        })),
      },
    },
    select: PAYMENT_PLAN_SELECT,
  });
}

/**
 * `SUM(Installment.amount WHERE paymentPlanId = id)` — the reconciliation
 * check `approvePaymentPlan` (service.ts) runs against `Booking.totalAmount`
 * before approving (schema.prisma's PaymentPlan model doc comment).
 * `aggregate`'s `_sum` returns `null` for zero matching rows.
 */
export async function sumInstallmentAmounts(
  db: Prisma.TransactionClient,
  paymentPlanId: string,
): Promise<Prisma.Decimal> {
  const result = await db.installment.aggregate({
    where: { paymentPlanId },
    _sum: { amount: true },
  });
  return result._sum.amount ?? new Prisma.Decimal(0);
}

export type ApprovePaymentPlanRowInput = {
  id: string;
  approvedByStaffUserId: string;
  approvedAt: Date;
};

export async function approvePaymentPlanRow(
  db: Prisma.TransactionClient,
  input: ApprovePaymentPlanRowInput,
): Promise<PaymentPlanRecord> {
  return db.paymentPlan.update({
    where: { id: input.id },
    data: { approvedByStaffUserId: input.approvedByStaffUserId, approvedAt: input.approvedAt },
    select: PAYMENT_PLAN_SELECT,
  });
}

export type InstallmentForAllocation = {
  id: string;
  paymentPlanId: string;
  bookingId: string;
  amount: Prisma.Decimal;
  planApprovedAt: Date | null;
};

/**
 * An Installment together with its owning PaymentPlan's `approvedAt` and
 * `bookingId` — everything `createAllocation` (service.ts) needs to enforce
 * D-054 §4's decided invariant ("A PaymentAllocation may only target an
 * Installment belonging to an already-approved PaymentPlan") and D-019's
 * cross-row invariant that a Payment's and an Installment's Booking must
 * match. Unscoped by actor — the caller has already resolved and scoped the
 * Payment side of the allocation; this is a plain existence/shape lookup.
 */
export async function findInstallmentForAllocation(
  db: Prisma.TransactionClient,
  installmentId: string,
): Promise<InstallmentForAllocation | null> {
  const row = await db.installment.findUnique({
    where: { id: installmentId },
    select: {
      id: true,
      paymentPlanId: true,
      amount: true,
      paymentPlan: { select: { bookingId: true, approvedAt: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    paymentPlanId: row.paymentPlanId,
    bookingId: row.paymentPlan.bookingId,
    amount: row.amount,
    planApprovedAt: row.paymentPlan.approvedAt,
  };
}

export type PaymentRecord = {
  id: string;
  bookingId: string;
  clientId: string;
  amount: Prisma.Decimal;
  status: PaymentStatus;
};

const PAYMENT_SELECT = {
  id: true,
  bookingId: true,
  clientId: true,
  amount: true,
  status: true,
} as const;

/** Scoped Payment read, by id, via the owning Booking's assignment. */
export async function findPaymentForActor(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  paymentId: string,
): Promise<PaymentRecord | null> {
  return db.payment.findFirst({
    where: { id: paymentId, booking: { ...bookingAssignmentFilter(actor) } },
    select: PAYMENT_SELECT,
  });
}

export type CreatePendingPaymentInput = {
  id: string;
  bookingId: string;
  clientId: string;
  amount: string;
  changedByUserId: string;
};

/**
 * Creates a Payment (default status `PENDING`, schema.prisma) and its
 * initial PaymentStatusHistory row (`previousStatus: null, newStatus:
 * PENDING`) as one nested write — the Payment counterpart of
 * `createBookingWithInitialHistory`. No `idempotencyKey` is required for
 * this initial row (D-019: idempotency keys are required only for
 * transitions *to* CONFIRMED/REVERSED/REFUNDED, and the initial PENDING row
 * is never such a transition).
 */
export async function createPendingPayment(
  db: Prisma.TransactionClient,
  input: CreatePendingPaymentInput,
): Promise<PaymentRecord> {
  return db.payment.create({
    data: {
      id: input.id,
      bookingId: input.bookingId,
      clientId: input.clientId,
      amount: input.amount,
      status: PaymentStatus.PENDING,
      statusHistory: {
        create: {
          id: randomUUID(),
          previousStatus: null,
          newStatus: PaymentStatus.PENDING,
          changedByUserId: input.changedByUserId,
        },
      },
    },
    select: PAYMENT_SELECT,
  });
}

export type StatusHistoryIdempotencyRecord = {
  paymentId: string;
  newStatus: PaymentStatus;
};

/**
 * Resolves what a given `PaymentStatusHistory.idempotencyKey` already
 * recorded — which Payment, and which target status — the retry-detection
 * read `confirmPayment`/`reversePayment` (service.ts) each run before
 * inserting, exactly mirroring `PaymentAllocation.idempotencyKey`'s retry
 * pattern documented in schema.prisma. Deliberately returns only the two
 * identifying facts, never the Payment itself: the caller must match both
 * against its own request and then re-read the Payment through
 * `findPaymentForActor`, so a replay is never an unscoped read.
 */
export async function findStatusHistoryByIdempotencyKey(
  db: Prisma.TransactionClient,
  idempotencyKey: string,
): Promise<StatusHistoryIdempotencyRecord | null> {
  return db.paymentStatusHistory.findUnique({
    where: { idempotencyKey },
    select: { paymentId: true, newStatus: true },
  });
}

/** `SUM(PaymentRefund.amount WHERE paymentId = id)` — D-019's cumulative-refund total. */
export async function sumRefundsForPayment(
  db: Prisma.TransactionClient,
  paymentId: string,
): Promise<Prisma.Decimal> {
  const result = await db.paymentRefund.aggregate({
    where: { paymentId },
    _sum: { amount: true },
  });
  return result._sum.amount ?? new Prisma.Decimal(0);
}

export type TransitionPaymentStatusInput = {
  paymentId: string;
  previousStatus: PaymentStatus;
  newStatus: PaymentStatus;
  changedByUserId: string;
  reason: string;
  idempotencyKey: string | null;
};

/**
 * Updates `Payment.status` and creates the corresponding
 * `PaymentStatusHistory` row as one nested write — the Payment counterpart
 * of `updateBookingStatusWithHistory`. Does not decide *whether* the
 * transition is allowed — D-054 §4's terminal-state and mutual-exclusion
 * rules are the caller's (service.ts's) responsibility to check first,
 * matching this codebase's established repository/service split.
 * CONFIRMED/REVERSED/REFUNDED — the only transitions Stage 2 implements —
 * always pass a non-null `idempotencyKey`, enforced by service.ts, not this
 * function. The type still accepts `null` because D-019 requires no key for
 * REJECTED/CANCELLED/FAILED, but no caller moves a Payment to any of those
 * yet: D-054 §17 Rule 1 defers them.
 */
export async function transitionPaymentStatus(
  db: Prisma.TransactionClient,
  input: TransitionPaymentStatusInput,
): Promise<PaymentRecord> {
  return db.payment.update({
    where: { id: input.paymentId },
    data: {
      status: input.newStatus,
      statusHistory: {
        create: {
          id: randomUUID(),
          previousStatus: input.previousStatus,
          newStatus: input.newStatus,
          changedByUserId: input.changedByUserId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
      },
    },
    select: PAYMENT_SELECT,
  });
}

export type RefundRecord = {
  id: string;
  paymentId: string;
  amount: Prisma.Decimal;
  reason: string;
};

export type RefundIdempotencyRecord = RefundRecord & { allocationId: string | null };

/**
 * Resolves an existing PaymentRefund by its own `idempotencyKey`, for the
 * identical retry-detection reason documented above, together with the one
 * `PaymentAllocation` it was linked to (if any — `createRefund` below links
 * at most one), so the caller can confirm a retry names the same payment,
 * amount, and allocation before treating it as a replay.
 */
export async function findRefundByIdempotencyKey(
  db: Prisma.TransactionClient,
  idempotencyKey: string,
): Promise<RefundIdempotencyRecord | null> {
  const row = await db.paymentRefund.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      paymentId: true,
      amount: true,
      reason: true,
      refundAllocations: { select: { paymentAllocationId: true }, take: 1 },
    },
  });
  if (!row) return null;
  const { refundAllocations, ...refund } = row;
  return { ...refund, allocationId: refundAllocations[0]?.paymentAllocationId ?? null };
}

export type CreateRefundInput = {
  id: string;
  paymentId: string;
  amount: string;
  reason: string;
  performedByStaffUserId: string;
  idempotencyKey: string;
  allocationId?: string;
  allocationRefundId?: string;
};

/**
 * Creates a PaymentRefund and, only when `allocationId` is supplied, its
 * linked PaymentRefundAllocation — one nested write, so both commit or roll
 * back together. When `allocationId` is omitted, per D-019's
 * PaymentRefundAllocation model doc comment, this refund is entirely against
 * unapplied Booking credit and no PaymentRefundAllocation row is created at
 * all.
 */
export async function createRefund(
  db: Prisma.TransactionClient,
  input: CreateRefundInput,
): Promise<RefundRecord> {
  return db.paymentRefund.create({
    data: {
      id: input.id,
      paymentId: input.paymentId,
      amount: input.amount,
      reason: input.reason,
      performedByStaffUserId: input.performedByStaffUserId,
      idempotencyKey: input.idempotencyKey,
      ...(input.allocationId
        ? {
            refundAllocations: {
              create: {
                id: input.allocationRefundId ?? randomUUID(),
                paymentAllocationId: input.allocationId,
                amount: input.amount,
              },
            },
          }
        : {}),
    },
    select: { id: true, paymentId: true, amount: true, reason: true },
  });
}

export type AllocationRecord = {
  id: string;
  paymentId: string;
  installmentId: string;
  amount: Prisma.Decimal;
};

export async function findAllocationByIdempotencyKey(
  db: Prisma.TransactionClient,
  idempotencyKey: string,
): Promise<AllocationRecord | null> {
  return db.paymentAllocation.findUnique({
    where: { idempotencyKey },
    select: { id: true, paymentId: true, installmentId: true, amount: true },
  });
}

export type CreateAllocationInput = {
  id: string;
  paymentId: string;
  installmentId: string;
  amount: string;
  allocatedByStaffUserId: string;
  idempotencyKey: string;
};

export async function createAllocation(
  db: Prisma.TransactionClient,
  input: CreateAllocationInput,
): Promise<AllocationRecord> {
  return db.paymentAllocation.create({
    data: {
      id: input.id,
      paymentId: input.paymentId,
      installmentId: input.installmentId,
      amount: input.amount,
      allocatedByStaffUserId: input.allocatedByStaffUserId,
      idempotencyKey: input.idempotencyKey,
    },
    select: { id: true, paymentId: true, installmentId: true, amount: true },
  });
}

/**
 * An Installment's net active allocation — D-019's per-Installment formula
 * exactly: allocations to it that are not reversed and whose Payment is
 * `CONFIRMED` or `REFUNDED`, minus every `PaymentRefundAllocation` recorded
 * against those allocations. `createAllocation` (service.ts) keeps this at or
 * below `Installment.amount` (D-054 §17 Rule 5), reading it inside the same
 * SERIALIZABLE transaction as the insert it gates.
 */
export async function sumNetActiveAllocationsForInstallment(
  db: Prisma.TransactionClient,
  installmentId: string,
): Promise<Prisma.Decimal> {
  const allocations = await db.paymentAllocation.findMany({
    where: {
      installmentId,
      reversal: null,
      payment: { status: { in: [PaymentStatus.CONFIRMED, PaymentStatus.REFUNDED] } },
    },
    select: { amount: true, refundAllocations: { select: { amount: true } } },
  });
  return allocations.reduce(
    (total, allocation) =>
      allocation.refundAllocations.reduce(
        (net, refundAllocation) => net.minus(refundAllocation.amount),
        total.plus(allocation.amount),
      ),
    new Prisma.Decimal(0),
  );
}

/**
 * A Payment's net active allocation (D-054 §17 Rule 2): the sum of its
 * non-reversed `PaymentAllocation.amount` values minus every
 * `PaymentRefundAllocation.amount` recorded against those same allocations
 * — D-019's per-Installment net-active-allocation formula applied per
 * Payment. The Payment-side cap (`createAllocation`/`refundPayment`,
 * service.ts) keeps this at or below the Payment's own net contribution.
 */
export async function sumNetActiveAllocationsForPayment(
  db: Prisma.TransactionClient,
  paymentId: string,
): Promise<Prisma.Decimal> {
  const allocations = await db.paymentAllocation.findMany({
    where: { paymentId, reversal: null },
    select: { amount: true, refundAllocations: { select: { amount: true } } },
  });
  return allocations.reduce(
    (total, allocation) =>
      allocation.refundAllocations.reduce(
        (net, refundAllocation) => net.minus(refundAllocation.amount),
        total.plus(allocation.amount),
      ),
    new Prisma.Decimal(0),
  );
}

export type AllocationForRefund = {
  id: string;
  paymentId: string;
  amount: Prisma.Decimal;
  isReversed: boolean;
  refundAllocatedTotal: Prisma.Decimal;
};

/**
 * An allocation together with whether it has been reversed and its own
 * already-summed `SUM(PaymentRefundAllocation.amount)` — `refundPayment`
 * (service.ts) needs both to enforce D-019's cross-row invariant
 * ("cumulative PaymentRefundAllocation.amount against one PaymentAllocation
 * must never exceed that allocation's own (still-active, non-reversed)
 * amount", schema.prisma's PaymentRefundAllocation doc comment) when a
 * refund names a specific `allocationId`.
 */
export async function findAllocationForRefund(
  db: Prisma.TransactionClient,
  allocationId: string,
): Promise<AllocationForRefund | null> {
  const row = await db.paymentAllocation.findUnique({
    where: { id: allocationId },
    select: {
      id: true,
      paymentId: true,
      amount: true,
      reversal: { select: { id: true } },
      refundAllocations: { select: { amount: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    paymentId: row.paymentId,
    amount: row.amount,
    isReversed: row.reversal !== null,
    refundAllocatedTotal: row.refundAllocations.reduce(
      (total, refundAllocation) => total.plus(refundAllocation.amount),
      new Prisma.Decimal(0),
    ),
  };
}

/** The currency code of the Booking a Payment belongs to — used only by `issueReceipt` (service.ts), after that Payment's own actor-scoped access has already been verified. */
export async function findBookingCurrencyCode(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<string | null> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { currencyCode: true },
  });
  return booking?.currencyCode ?? null;
}

export type AllocationForReversal = {
  id: string;
  paymentId: string;
  installmentId: string;
  amount: Prisma.Decimal;
  hasReversal: boolean;
  hasRefundAllocation: boolean;
};

/**
 * An allocation together with the two facts `reverseAllocation`
 * (service.ts) needs to enforce D-019's default service policy (D-054 §13's
 * corrected wording): whether it has already been reversed (at most once,
 * `paymentAllocationId @unique` on PaymentAllocationReversal), and whether
 * any PaymentRefundAllocation row already exists against it (which blocks
 * reversal outright — no override is defined).
 */
export async function findAllocationForReversal(
  db: Prisma.TransactionClient,
  allocationId: string,
): Promise<AllocationForReversal | null> {
  const row = await db.paymentAllocation.findUnique({
    where: { id: allocationId },
    select: {
      id: true,
      paymentId: true,
      installmentId: true,
      amount: true,
      reversal: { select: { id: true } },
      refundAllocations: { select: { id: true }, take: 1 },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    paymentId: row.paymentId,
    installmentId: row.installmentId,
    amount: row.amount,
    hasReversal: row.reversal !== null,
    hasRefundAllocation: row.refundAllocations.length > 0,
  };
}

export async function findAllocationReversalByIdempotencyKey(
  db: Prisma.TransactionClient,
  idempotencyKey: string,
): Promise<{ id: string; paymentAllocationId: string } | null> {
  return db.paymentAllocationReversal.findUnique({
    where: { idempotencyKey },
    select: { id: true, paymentAllocationId: true },
  });
}

export type CreateAllocationReversalInput = {
  id: string;
  paymentAllocationId: string;
  reversedByStaffUserId: string;
  reason: string;
  idempotencyKey: string;
};

export async function createAllocationReversal(
  db: Prisma.TransactionClient,
  input: CreateAllocationReversalInput,
): Promise<{ id: string; paymentAllocationId: string }> {
  return db.paymentAllocationReversal.create({
    data: {
      id: input.id,
      paymentAllocationId: input.paymentAllocationId,
      reversedByStaffUserId: input.reversedByStaffUserId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    },
    select: { id: true, paymentAllocationId: true },
  });
}

export type ReceiptRecord = {
  id: string;
  paymentId: string;
  receiptNumber: string;
  amount: Prisma.Decimal;
  currencyCode: string;
};

export async function findReceiptByPaymentId(
  db: Prisma.TransactionClient,
  paymentId: string,
): Promise<ReceiptRecord | null> {
  return db.receipt.findUnique({
    where: { paymentId },
    select: { id: true, paymentId: true, receiptNumber: true, amount: true, currencyCode: true },
  });
}

export type CreateReceiptInput = {
  id: string;
  paymentId: string;
  receiptNumber: string;
  issuedByStaffUserId: string;
  amount: string;
  currencyCode: string;
};

/**
 * Creates a Receipt. `receiptNumber` is server-generated by the caller
 * (service.ts, via `randomUUID()`) — D-019 enforces only uniqueness, no
 * prefix format is yet approved (unlike `Booking.bookingReference`'s
 * `HPB-`-prefixed convention), so no format is invented here.
 */
export async function createReceipt(
  db: Prisma.TransactionClient,
  input: CreateReceiptInput,
): Promise<ReceiptRecord> {
  return db.receipt.create({
    data: {
      id: input.id,
      paymentId: input.paymentId,
      receiptNumber: input.receiptNumber,
      issuedByStaffUserId: input.issuedByStaffUserId,
      amount: input.amount,
      currencyCode: input.currencyCode,
    },
    select: { id: true, paymentId: true, receiptNumber: true, amount: true, currencyCode: true },
  });
}

export async function insertAuditLog(
  db: Prisma.TransactionClient,
  entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    beforeState?: Prisma.InputJsonValue;
    afterState?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      id: randomUUID(),
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeState: entry.beforeState,
      afterState: entry.afterState,
    },
  });
}

// --- Booking payment summary (D-054 §§5, 6, 7) ---
// One nested-include read composing everything the D-019 formulas
// (calculations.ts) and the staff/client summary DTOs (service.ts) need for
// one Booking: the Booking's own financials, its PaymentPlan (if any) with
// every Installment and each Installment's active allocations (with their
// own Payment status and refund-allocation total), and every Payment under
// the Booking with its own refund total. Deliberately one query, not one
// per Installment/Payment (.claude/rules/frontend.md's / admin-dashboard.md's
// "never fetch everything and filter/aggregate in application code one row
// at a time" discipline, applied here to a single Booking's own bounded
// dataset rather than to a list).

export type BookingPaymentSummaryData = {
  booking: BookingFinancials;
  plan: {
    id: string;
    approvedByStaffUserId: string | null;
    approvedAt: Date | null;
    installments: {
      id: string;
      dueDate: Date;
      amount: Prisma.Decimal;
      allocations: {
        id: string;
        paymentId: string;
        amount: Prisma.Decimal;
        isReversed: boolean;
        refundAllocatedTotal: Prisma.Decimal;
        paymentStatus: PaymentStatus;
      }[];
    }[];
  } | null;
  payments: {
    id: string;
    amount: Prisma.Decimal;
    status: PaymentStatus;
    refundedTotal: Prisma.Decimal;
    receipt: { receiptNumber: string; issuedAt: Date } | null;
  }[];
};

export async function findBookingPaymentSummaryData(
  db: Prisma.TransactionClient,
  bookingId: string,
): Promise<BookingPaymentSummaryData | null> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      ...BOOKING_FINANCIALS_SELECT,
      paymentPlan: {
        select: {
          id: true,
          approvedByStaffUserId: true,
          approvedAt: true,
          installments: {
            orderBy: { sequenceNumber: 'asc' },
            select: {
              id: true,
              dueDate: true,
              amount: true,
              allocations: {
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  paymentId: true,
                  amount: true,
                  reversal: { select: { id: true } },
                  refundAllocations: { select: { amount: true } },
                  payment: { select: { status: true } },
                },
              },
            },
          },
        },
      },
      payments: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          amount: true,
          status: true,
          refunds: { select: { amount: true } },
          receipt: { select: { receiptNumber: true, issuedAt: true } },
        },
      },
    },
  });
  if (!booking) return null;

  const { paymentPlan, payments, ...financials } = booking;

  return {
    booking: financials,
    plan: paymentPlan
      ? {
          id: paymentPlan.id,
          approvedByStaffUserId: paymentPlan.approvedByStaffUserId,
          approvedAt: paymentPlan.approvedAt,
          installments: paymentPlan.installments.map((installment) => ({
            id: installment.id,
            dueDate: installment.dueDate,
            amount: installment.amount,
            allocations: installment.allocations.map((allocation) => ({
              id: allocation.id,
              paymentId: allocation.paymentId,
              amount: allocation.amount,
              isReversed: allocation.reversal !== null,
              refundAllocatedTotal: allocation.refundAllocations.reduce(
                (total, refundAllocation) => total.plus(refundAllocation.amount),
                new Prisma.Decimal(0),
              ),
              paymentStatus: allocation.payment.status,
            })),
          })),
        }
      : null,
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      status: payment.status,
      refundedTotal: payment.refunds.reduce(
        (total, refund) => total.plus(refund.amount),
        new Prisma.Decimal(0),
      ),
      receipt: payment.receipt,
    })),
  };
}

/**
 * The ids of a Client's own Bookings that have an *approved* PaymentPlan
 * only (D-054 §7: "an unapproved, proposed-only plan is never
 * client-visible") — used by the client-portal summary read (service.ts) to
 * decide which Bookings to build a `findBookingPaymentSummaryData` summary
 * for. Scoped by `clientId` directly (a direct FK, mirroring
 * features/bookings/repository.ts's client-portal reads) — the caller's own
 * `canAccessClient` ownership check (features/assignments/authorization.ts)
 * runs before this, never after.
 */
export async function findApprovedBookingIdsForClient(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<string[]> {
  const rows = await db.booking.findMany({
    where: { clientId, paymentPlan: { approvedAt: { not: null } } },
    select: { id: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map((row) => row.id);
}
