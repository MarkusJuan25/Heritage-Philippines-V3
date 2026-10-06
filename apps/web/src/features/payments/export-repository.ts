import { PaymentPlanStatus, PaymentStatus, Prisma } from '@/generated/prisma/client';

import type { FinanceExportRequest } from './export-schemas';
import { bookingAssignmentFilter } from './repository';
import type { BookingPaymentSummaryData } from './repository';

// Data access for basic finance exports (D-061, as clarified by D-062).
// Every read takes the export's own transaction client, so the actor
// recheck, the scope, the count, and the rows are all evaluated on one
// snapshot (D-061 §6, §8). The assignment scope is part of each query's
// `where` — rows are never fetched and filtered afterwards.
//
// ONE STATEMENT AT A TIME. Inside a transaction every statement runs on one
// connection. Prisma loads the sibling relations of one query concurrently,
// and on a single connection that means issuing a statement while another
// is still running — which pg 8 deprecates and pg 9 removes. So no query
// here selects more than one relation at any level: each is a plain chain,
// the queries are awaited one after another, and related rows are read by
// their own query under the same `where` and joined in memory. Do not add a
// second relation to a `select` below, and do not wrap these in
// `Promise.all`.

// The two roles that may export (D-061 §6). Assignable to `PaymentActor`,
// so the existing `bookingAssignmentFilter` rule applies unchanged.
export type FinanceExportActor = { id: string; role: 'ADMIN_MANAGER' | 'FINANCE_ACCOUNTING' };

export type FinanceExportActorRecheck = { isActive: boolean; role: string; asOf: Date };

/**
 * The export transaction's FIRST statement (D-061 §8 step 2(a); D-062
 * clause 3). It must stay the first: under Repeatable Read this statement
 * establishes the snapshot every later read in the transaction uses.
 *
 * One statement does two things. It re-reads the actor's own account — the
 * stored `isActive` and role, not the session's. And it reads the database
 * server's `clock_timestamp()` in the select list, which is evaluated for a
 * row the statement has already read on that snapshot, so the reading is
 * taken after the snapshot exists. `now()` and `statement_timestamp()`
 * would both be earlier than the snapshot and are not used.
 *
 * The reading is taken to millisecond precision by ceiling, in the
 * database, on the exact numeric epoch value: a whole millisecond is
 * unchanged, anything else becomes the next one. It travels as text so no
 * driver or session time-zone conversion touches it.
 *
 * Returns `null` when the account does not exist.
 */
export async function recheckExportActorAndReadClock(
  db: Prisma.TransactionClient,
  actorId: string,
): Promise<FinanceExportActorRecheck | null> {
  const rows = await db.$queryRaw<{ isActive: boolean; role: string; asOfEpochMs: string }[]>`
    SELECT
      "isActive" AS "isActive",
      "role"::text AS "role",
      ceil(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS "asOfEpochMs"
    FROM "user"
    WHERE "id" = ${actorId}
  `;
  const row = rows[0];
  if (!row) return null;
  return { isActive: row.isActive, role: row.role, asOf: new Date(Number(row.asOfEpochMs)) };
}

type BookingsRequest = Extract<FinanceExportRequest, { dataset: 'bookings' }>;
type PaymentsRequest = Extract<FinanceExportRequest, { dataset: 'payments' }>;
type RefundsRequest = Extract<FinanceExportRequest, { dataset: 'refunds' }>;
type AllocationsRequest = Extract<FinanceExportRequest, { dataset: 'allocations' }>;
type InstallmentsRequest = Extract<FinanceExportRequest, { dataset: 'installments' }>;
type DatedFinanceExportRequest = Exclude<FinanceExportRequest, BookingsRequest>;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const ZERO = new Prisma.Decimal(0);

function scopedBookingWhere(
  actor: FinanceExportActor,
  bookingReference: string | undefined,
): Prisma.BookingWhereInput {
  return {
    ...bookingAssignmentFilter(actor),
    ...(bookingReference !== undefined ? { bookingReference } : {}),
  };
}

/** Inclusive Philippine calendar days as a half-open range of instants. */
function manilaDayRange(request: DatedFinanceExportRequest): { gte: Date; lt: Date } | undefined {
  if (request.from === undefined || request.to === undefined) return undefined;
  return {
    gte: new Date(`${request.from}T00:00:00.000+08:00`),
    lt: new Date(Date.parse(`${request.to}T00:00:00.000+08:00`) + MILLISECONDS_PER_DAY),
  };
}

/** Inclusive calendar days for a `@db.Date` column, compared as dates. */
function dateOnlyRange(request: DatedFinanceExportRequest): { gte: Date; lte: Date } | undefined {
  if (request.from === undefined || request.to === undefined) return undefined;
  return {
    gte: new Date(`${request.from}T00:00:00.000Z`),
    lte: new Date(`${request.to}T00:00:00.000Z`),
  };
}

function groupBy<Row, Key>(rows: readonly Row[], keyOf: (row: Row) => Key): Map<Key, Row[]> {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

const BOOKING_LABEL_SELECT = { bookingReference: true, currencyCode: true } as const;

type AmountRow = { amount: Prisma.Decimal };

function amountsOf(rows: readonly AmountRow[] | undefined): AmountRow[] {
  return (rows ?? []).map((row) => ({ amount: row.amount }));
}

// --- where clauses (each used by both the count and the read) ---

// Only Bookings whose financials are set (D-061 §3).
function bookingExportWhere(
  actor: FinanceExportActor,
  request: BookingsRequest,
): Prisma.BookingWhereInput {
  return {
    ...scopedBookingWhere(actor, request.bookingReference),
    totalAmount: { not: null },
    currencyCode: { not: null },
  };
}

function paymentExportWhere(
  actor: FinanceExportActor,
  request: PaymentsRequest,
): Prisma.PaymentWhereInput {
  const range = manilaDayRange(request);
  return {
    booking: scopedBookingWhere(actor, request.bookingReference),
    ...(range ? { createdAt: range } : {}),
    ...(request.status !== undefined ? { status: request.status } : {}),
  };
}

function refundExportWhere(
  actor: FinanceExportActor,
  request: RefundsRequest,
): Prisma.PaymentRefundWhereInput {
  const range = manilaDayRange(request);
  return {
    payment: { booking: scopedBookingWhere(actor, request.bookingReference) },
    ...(range ? { performedAt: range } : {}),
  };
}

function allocationExportWhere(
  actor: FinanceExportActor,
  request: AllocationsRequest,
): Prisma.PaymentAllocationWhereInput {
  const range = manilaDayRange(request);
  return {
    payment: { booking: scopedBookingWhere(actor, request.bookingReference) },
    ...(range ? { allocatedAt: range } : {}),
  };
}

// The Booking's one APPROVED plan only (D-061 §2, §3): a proposed plan can
// still change, and a withdrawn plan is history.
function installmentExportWhere(
  actor: FinanceExportActor,
  request: InstallmentsRequest,
): Prisma.InstallmentWhereInput {
  const range = dateOnlyRange(request);
  return {
    paymentPlan: {
      status: PaymentPlanStatus.APPROVED,
      booking: scopedBookingWhere(actor, request.bookingReference),
    },
    ...(range ? { dueDate: range } : {}),
  };
}

// --- bookings ---

export type BookingExportRecord = { clientFullName: string; data: BookingPaymentSummaryData };

/**
 * Many Bookings, each composed into the same `BookingPaymentSummaryData`
 * shape `repository.findBookingPaymentSummaryData` returns for one, so the
 * caller builds every row with the existing `buildBookingPaymentSummary`.
 * The plan is the Booking's one non-withdrawn plan
 * (`payment_plan_active_booking_key`, D-057 §2(5)); row orders match the
 * single-Booking read.
 */
export async function findBookingExportRecords(
  db: Prisma.TransactionClient,
  actor: FinanceExportActor,
  request: BookingsRequest,
): Promise<BookingExportRecord[]> {
  const bookingWhere = bookingExportWhere(actor, request);
  const planWhere: Prisma.PaymentPlanWhereInput = {
    booking: bookingWhere,
    status: { not: PaymentPlanStatus.WITHDRAWN },
  };
  const planAllocationWhere: Prisma.PaymentAllocationWhereInput = {
    installment: { paymentPlan: planWhere },
  };
  const paymentWhere: Prisma.PaymentWhereInput = { booking: bookingWhere };

  const bookings = await db.booking.findMany({
    where: bookingWhere,
    orderBy: [{ bookingReference: 'asc' }],
    select: {
      id: true,
      clientId: true,
      status: true,
      totalAmount: true,
      currencyCode: true,
      bookingReference: true,
      client: { select: { fullName: true } },
    },
  });
  const plans = await db.paymentPlan.findMany({
    where: planWhere,
    select: {
      id: true,
      bookingId: true,
      status: true,
      approvedByStaffUserId: true,
      approvedAt: true,
    },
  });
  const installments = await db.installment.findMany({
    where: { paymentPlan: planWhere },
    orderBy: { sequenceNumber: 'asc' },
    select: { id: true, paymentPlanId: true, dueDate: true, amount: true },
  });
  const allocations = await db.paymentAllocation.findMany({
    where: planAllocationWhere,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      installmentId: true,
      paymentId: true,
      amount: true,
      payment: { select: { status: true } },
    },
  });
  const reversals = await db.paymentAllocationReversal.findMany({
    where: { paymentAllocation: planAllocationWhere },
    select: { paymentAllocationId: true },
  });
  const refundAllocations = await db.paymentRefundAllocation.findMany({
    where: { paymentAllocation: planAllocationWhere },
    select: { paymentAllocationId: true, amount: true },
  });
  const payments = await db.payment.findMany({
    where: paymentWhere,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, bookingId: true, amount: true, status: true },
  });
  const refunds = await db.paymentRefund.findMany({
    where: { payment: paymentWhere },
    select: { paymentId: true, amount: true },
  });
  const receipts = await db.receipt.findMany({
    where: { payment: paymentWhere },
    select: { paymentId: true, receiptNumber: true, issuedAt: true },
  });

  const planByBooking = new Map(plans.map((plan) => [plan.bookingId, plan]));
  const installmentsByPlan = groupBy(installments, (installment) => installment.paymentPlanId);
  const allocationsByInstallment = groupBy(allocations, (allocation) => allocation.installmentId);
  const reversedAllocationIds = new Set(reversals.map((reversal) => reversal.paymentAllocationId));
  const refundAllocationsByAllocation = groupBy(
    refundAllocations,
    (refundAllocation) => refundAllocation.paymentAllocationId,
  );
  const paymentsByBooking = groupBy(payments, (payment) => payment.bookingId);
  const refundsByPayment = groupBy(refunds, (refund) => refund.paymentId);
  const receiptByPayment = new Map(receipts.map((receipt) => [receipt.paymentId, receipt]));
  const sum = (rows: readonly AmountRow[] | undefined): Prisma.Decimal =>
    (rows ?? []).reduce((total, row) => total.plus(row.amount), ZERO);

  return bookings.map(({ client, ...booking }) => {
    const plan = planByBooking.get(booking.id);
    return {
      clientFullName: client.fullName,
      data: {
        booking,
        plan: plan
          ? {
              id: plan.id,
              status: plan.status,
              approvedByStaffUserId: plan.approvedByStaffUserId,
              approvedAt: plan.approvedAt,
              installments: (installmentsByPlan.get(plan.id) ?? []).map((installment) => ({
                id: installment.id,
                dueDate: installment.dueDate,
                amount: installment.amount,
                allocations: (allocationsByInstallment.get(installment.id) ?? []).map(
                  (allocation) => ({
                    id: allocation.id,
                    paymentId: allocation.paymentId,
                    amount: allocation.amount,
                    isReversed: reversedAllocationIds.has(allocation.id),
                    refundAllocatedTotal: sum(refundAllocationsByAllocation.get(allocation.id)),
                    paymentStatus: allocation.payment.status,
                  }),
                ),
              })),
            }
          : null,
        payments: (paymentsByBooking.get(booking.id) ?? []).map((payment) => {
          const receipt = receiptByPayment.get(payment.id);
          return {
            id: payment.id,
            amount: payment.amount,
            status: payment.status,
            refundedTotal: sum(refundsByPayment.get(payment.id)),
            receipt: receipt
              ? { receiptNumber: receipt.receiptNumber, issuedAt: receipt.issuedAt }
              : null,
          };
        }),
      },
    };
  });
}

// --- payments ---

export type PaymentExportRecord = {
  id: string;
  amount: Prisma.Decimal;
  status: PaymentStatus;
  createdAt: Date;
  booking: { bookingReference: string; currencyCode: string | null; client: { fullName: string } };
  statusHistory: { newStatus: PaymentStatus; createdAt: Date }[];
  refunds: AmountRow[];
  receipt: { receiptNumber: string; issuedAt: Date } | null;
  allocations: {
    amount: Prisma.Decimal;
    reversal: { id: string } | null;
    refundAllocations: AmountRow[];
  }[];
};

/**
 * Refunds, allocations, and status history are read for every exported
 * Payment whole: a filter chooses which Payment rows appear and never
 * changes a derived value (D-061 §3).
 */
export async function findPaymentExportRecords(
  db: Prisma.TransactionClient,
  actor: FinanceExportActor,
  request: PaymentsRequest,
): Promise<PaymentExportRecord[]> {
  const paymentWhere = paymentExportWhere(actor, request);

  const payments = await db.payment.findMany({
    where: paymentWhere,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      amount: true,
      status: true,
      createdAt: true,
      booking: { select: { ...BOOKING_LABEL_SELECT, client: { select: { fullName: true } } } },
    },
  });
  const statusHistory = await db.paymentStatusHistory.findMany({
    where: {
      payment: paymentWhere,
      newStatus: { in: [PaymentStatus.CONFIRMED, PaymentStatus.REVERSED, PaymentStatus.REFUNDED] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { paymentId: true, newStatus: true, createdAt: true },
  });
  const refunds = await db.paymentRefund.findMany({
    where: { payment: paymentWhere },
    select: { paymentId: true, amount: true },
  });
  const receipts = await db.receipt.findMany({
    where: { payment: paymentWhere },
    select: { paymentId: true, receiptNumber: true, issuedAt: true },
  });
  const allocations = await db.paymentAllocation.findMany({
    where: { payment: paymentWhere },
    select: { id: true, paymentId: true, amount: true },
  });
  const reversals = await db.paymentAllocationReversal.findMany({
    where: { paymentAllocation: { payment: paymentWhere } },
    select: { id: true, paymentAllocationId: true },
  });
  const refundAllocations = await db.paymentRefundAllocation.findMany({
    where: { paymentAllocation: { payment: paymentWhere } },
    select: { paymentAllocationId: true, amount: true },
  });

  const historyByPayment = groupBy(statusHistory, (entry) => entry.paymentId);
  const refundsByPayment = groupBy(refunds, (refund) => refund.paymentId);
  const receiptByPayment = new Map(receipts.map((receipt) => [receipt.paymentId, receipt]));
  const allocationsByPayment = groupBy(allocations, (allocation) => allocation.paymentId);
  const reversalByAllocation = new Map(
    reversals.map((reversal) => [reversal.paymentAllocationId, reversal]),
  );
  const refundAllocationsByAllocation = groupBy(
    refundAllocations,
    (refundAllocation) => refundAllocation.paymentAllocationId,
  );

  return payments.map((payment) => {
    const receipt = receiptByPayment.get(payment.id);
    return {
      ...payment,
      statusHistory: (historyByPayment.get(payment.id) ?? []).map((entry) => ({
        newStatus: entry.newStatus,
        createdAt: entry.createdAt,
      })),
      refunds: amountsOf(refundsByPayment.get(payment.id)),
      receipt: receipt
        ? { receiptNumber: receipt.receiptNumber, issuedAt: receipt.issuedAt }
        : null,
      allocations: (allocationsByPayment.get(payment.id) ?? []).map((allocation) => {
        const reversal = reversalByAllocation.get(allocation.id);
        return {
          amount: allocation.amount,
          reversal: reversal ? { id: reversal.id } : null,
          refundAllocations: amountsOf(refundAllocationsByAllocation.get(allocation.id)),
        };
      }),
    };
  });
}

// --- refunds ---

export type RefundExportRecord = {
  id: string;
  paymentId: string;
  amount: Prisma.Decimal;
  performedAt: Date;
  payment: { booking: { bookingReference: string; currencyCode: string | null } };
  refundAllocations: AmountRow[];
};

export async function findRefundExportRecords(
  db: Prisma.TransactionClient,
  actor: FinanceExportActor,
  request: RefundsRequest,
): Promise<RefundExportRecord[]> {
  const refundWhere = refundExportWhere(actor, request);

  const refunds = await db.paymentRefund.findMany({
    where: refundWhere,
    orderBy: [{ performedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      paymentId: true,
      amount: true,
      performedAt: true,
      payment: { select: { booking: { select: BOOKING_LABEL_SELECT } } },
    },
  });
  const refundAllocations = await db.paymentRefundAllocation.findMany({
    where: { paymentRefund: refundWhere },
    select: { paymentRefundId: true, amount: true },
  });

  const refundAllocationsByRefund = groupBy(
    refundAllocations,
    (refundAllocation) => refundAllocation.paymentRefundId,
  );
  return refunds.map((refund) => ({
    ...refund,
    refundAllocations: amountsOf(refundAllocationsByRefund.get(refund.id)),
  }));
}

// --- allocations ---

export type AllocationExportRecord = {
  id: string;
  paymentId: string;
  amount: Prisma.Decimal;
  allocatedAt: Date;
  payment: {
    status: PaymentStatus;
    booking: { bookingReference: string; currencyCode: string | null };
  };
  installment: { sequenceNumber: number; isDeposit: boolean; dueDate: Date };
  reversal: { createdAt: Date } | null;
  refundAllocations: AmountRow[];
};

export async function findAllocationExportRecords(
  db: Prisma.TransactionClient,
  actor: FinanceExportActor,
  request: AllocationsRequest,
): Promise<AllocationExportRecord[]> {
  const allocationWhere = allocationExportWhere(actor, request);

  const allocations = await db.paymentAllocation.findMany({
    where: allocationWhere,
    orderBy: [{ allocatedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      paymentId: true,
      installmentId: true,
      amount: true,
      allocatedAt: true,
      payment: { select: { status: true, booking: { select: BOOKING_LABEL_SELECT } } },
    },
  });
  const installments = await db.installment.findMany({
    where: { allocations: { some: allocationWhere } },
    select: { id: true, sequenceNumber: true, isDeposit: true, dueDate: true },
  });
  const reversals = await db.paymentAllocationReversal.findMany({
    where: { paymentAllocation: allocationWhere },
    select: { paymentAllocationId: true, createdAt: true },
  });
  const refundAllocations = await db.paymentRefundAllocation.findMany({
    where: { paymentAllocation: allocationWhere },
    select: { paymentAllocationId: true, amount: true },
  });

  const installmentById = new Map(installments.map((installment) => [installment.id, installment]));
  const reversalByAllocation = new Map(
    reversals.map((reversal) => [reversal.paymentAllocationId, reversal]),
  );
  const refundAllocationsByAllocation = groupBy(
    refundAllocations,
    (refundAllocation) => refundAllocation.paymentAllocationId,
  );

  return allocations.map(({ installmentId, ...allocation }) => {
    const installment = installmentById.get(installmentId);
    if (!installment) {
      // Unreachable on one snapshot: `installmentId` is a required foreign key.
      throw new Error('A payment allocation has no installment.');
    }
    const reversal = reversalByAllocation.get(allocation.id);
    return {
      ...allocation,
      installment: {
        sequenceNumber: installment.sequenceNumber,
        isDeposit: installment.isDeposit,
        dueDate: installment.dueDate,
      },
      reversal: reversal ? { createdAt: reversal.createdAt } : null,
      refundAllocations: amountsOf(refundAllocationsByAllocation.get(allocation.id)),
    };
  });
}

// --- installments ---

export type InstallmentExportRecord = {
  sequenceNumber: number;
  isDeposit: boolean;
  amount: Prisma.Decimal;
  dueDate: Date;
  paymentPlan: { booking: { bookingReference: string; currencyCode: string | null } };
  allocations: {
    amount: Prisma.Decimal;
    reversal: { id: string } | null;
    refundAllocations: AmountRow[];
    payment: { status: PaymentStatus };
  }[];
};

export async function findInstallmentExportRecords(
  db: Prisma.TransactionClient,
  actor: FinanceExportActor,
  request: InstallmentsRequest,
): Promise<InstallmentExportRecord[]> {
  const installmentWhere = installmentExportWhere(actor, request);
  const allocationWhere: Prisma.PaymentAllocationWhereInput = { installment: installmentWhere };

  const installments = await db.installment.findMany({
    where: installmentWhere,
    orderBy: [{ paymentPlan: { booking: { bookingReference: 'asc' } } }, { sequenceNumber: 'asc' }],
    select: {
      id: true,
      sequenceNumber: true,
      isDeposit: true,
      amount: true,
      dueDate: true,
      paymentPlan: { select: { booking: { select: BOOKING_LABEL_SELECT } } },
    },
  });
  const allocations = await db.paymentAllocation.findMany({
    where: allocationWhere,
    select: {
      id: true,
      installmentId: true,
      amount: true,
      payment: { select: { status: true } },
    },
  });
  const reversals = await db.paymentAllocationReversal.findMany({
    where: { paymentAllocation: allocationWhere },
    select: { id: true, paymentAllocationId: true },
  });
  const refundAllocations = await db.paymentRefundAllocation.findMany({
    where: { paymentAllocation: allocationWhere },
    select: { paymentAllocationId: true, amount: true },
  });

  const allocationsByInstallment = groupBy(allocations, (allocation) => allocation.installmentId);
  const reversalByAllocation = new Map(
    reversals.map((reversal) => [reversal.paymentAllocationId, reversal]),
  );
  const refundAllocationsByAllocation = groupBy(
    refundAllocations,
    (refundAllocation) => refundAllocation.paymentAllocationId,
  );

  return installments.map(({ id, ...installment }) => ({
    ...installment,
    allocations: (allocationsByInstallment.get(id) ?? []).map((allocation) => {
      const reversal = reversalByAllocation.get(allocation.id);
      return {
        amount: allocation.amount,
        reversal: reversal ? { id: reversal.id } : null,
        refundAllocations: amountsOf(refundAllocationsByAllocation.get(allocation.id)),
        payment: { status: allocation.payment.status },
      };
    }),
  }));
}

// --- row count ---

/**
 * How many rows the export would hold, with the same `where` the read
 * uses. Counted before the rows are read so an over-limit request is
 * refused without fetching them (D-061 §5: refused, never truncated).
 */
export async function countFinanceExportRows(
  db: Prisma.TransactionClient,
  actor: FinanceExportActor,
  request: FinanceExportRequest,
): Promise<number> {
  switch (request.dataset) {
    case 'bookings':
      return db.booking.count({ where: bookingExportWhere(actor, request) });
    case 'payments':
      return db.payment.count({ where: paymentExportWhere(actor, request) });
    case 'refunds':
      return db.paymentRefund.count({ where: refundExportWhere(actor, request) });
    case 'allocations':
      return db.paymentAllocation.count({ where: allocationExportWhere(actor, request) });
    case 'installments':
      return db.installment.count({ where: installmentExportWhere(actor, request) });
    default: {
      const exhaustiveCheck: never = request;
      throw new Error(`Unhandled finance export dataset: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
