// Action names written to AuditLog.action (blueprint Section 14.9;
// .claude/rules/backend.md's Auditability rule; D-054 §8), mirroring
// features/bookings/audit.ts's BOOKING_AUDIT_ACTIONS convention exactly.
export const PAYMENT_AUDIT_ACTIONS = {
  BOOKING_FINANCIALS_SET: 'BOOKING_FINANCIALS_SET',
  BOOKING_FINANCIALS_CHANGED: 'BOOKING_FINANCIALS_CHANGED',
  PAYMENT_PLAN_PROPOSED: 'PAYMENT_PLAN_PROPOSED',
  PAYMENT_PLAN_APPROVED: 'PAYMENT_PLAN_APPROVED',
  PAYMENT_PLAN_WITHDRAWN: 'PAYMENT_PLAN_WITHDRAWN',
  PAYMENT_RECORDED: 'PAYMENT_RECORDED',
  PAYMENT_STATUS_CHANGED: 'PAYMENT_STATUS_CHANGED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  PAYMENT_ALLOCATION_CREATED: 'PAYMENT_ALLOCATION_CREATED',
  PAYMENT_ALLOCATION_REVERSED: 'PAYMENT_ALLOCATION_REVERSED',
  RECEIPT_ISSUED: 'RECEIPT_ISSUED',
} as const;

// AuditLog.entityType per audited entity — each audit entry's `entityId`
// names the specific row of this type that changed, mirroring
// features/bookings/audit.ts's single-entityType convention (extended here
// to several entity types, since Payments spans more than one auditable
// entity, unlike Bookings' single-entity model).
export const PAYMENT_PLAN_AUDIT_ENTITY_TYPE = 'PaymentPlan';
export const PAYMENT_AUDIT_ENTITY_TYPE = 'Payment';
export const PAYMENT_ALLOCATION_AUDIT_ENTITY_TYPE = 'PaymentAllocation';
export const RECEIPT_AUDIT_ENTITY_TYPE = 'Receipt';

export type AuditPaymentPlanSnapshot = {
  id: string;
  bookingId: string;
  clientId: string;
  approvedByStaffUserId: string | null;
  approvedAt: string | null;
  status: string;
};

/**
 * Explicit allow-list snapshot for a PaymentPlan audit entry — matches
 * features/bookings/audit.ts's `sanitizeBookingSnapshot` discipline exactly:
 * a fresh object built from exactly the named fields, never a spread of the
 * source record. Only which plan changed, for which booking/client, its
 * approval state, and its lifecycle `status` (D-057 §5: every plan audit
 * record carries it). Installments are added only by the withdrawal
 * snapshot below, which must preserve the withdrawn terms in full.
 */
export function sanitizePaymentPlanSnapshot(record: {
  id: string;
  bookingId: string;
  clientId: string;
  approvedByStaffUserId: string | null;
  approvedAt: Date | null;
  status: string;
}): AuditPaymentPlanSnapshot {
  return {
    id: record.id,
    bookingId: record.bookingId,
    clientId: record.clientId,
    approvedByStaffUserId: record.approvedByStaffUserId,
    approvedAt: record.approvedAt ? record.approvedAt.toISOString() : null,
    status: record.status,
  };
}

export type AuditInstallmentSnapshot = {
  sequenceNumber: number;
  isDeposit: boolean;
  amount: string;
  dueDate: string;
};

export type AuditPaymentPlanWithdrawalBeforeSnapshot = AuditPaymentPlanSnapshot & {
  installments: AuditInstallmentSnapshot[];
};

/**
 * The beforeState of a `PAYMENT_PLAN_WITHDRAWN` entry (D-057 §5): the plan
 * snapshot plus every installment's sequence number, deposit flag, amount
 * (a decimal string, never a binary float — CLAUDE.md §8), and due date
 * (`YYYY-MM-DD`, matching `Installment.dueDate`'s `@db.Date` column).
 */
export function sanitizePaymentPlanWithdrawalBeforeSnapshot(
  plan: Parameters<typeof sanitizePaymentPlanSnapshot>[0],
  installments: {
    sequenceNumber: number;
    isDeposit: boolean;
    amount: { toFixed(decimalPlaces: number): string };
    dueDate: Date;
  }[],
): AuditPaymentPlanWithdrawalBeforeSnapshot {
  return {
    ...sanitizePaymentPlanSnapshot(plan),
    installments: installments.map((installment) => ({
      sequenceNumber: installment.sequenceNumber,
      isDeposit: installment.isDeposit,
      amount: installment.amount.toFixed(2),
      dueDate: installment.dueDate.toISOString().slice(0, 10),
    })),
  };
}

export type AuditPaymentPlanWithdrawalAfterSnapshot = {
  status: 'WITHDRAWN';
  withdrawnAt: string;
  withdrawnByStaffUserId: string;
  reason: string;
};

/** The afterState of a `PAYMENT_PLAN_WITHDRAWN` entry, exactly D-057 §5's four fields. */
export function sanitizePaymentPlanWithdrawalAfterSnapshot(record: {
  withdrawnAt: Date;
  withdrawnByStaffUserId: string;
  reason: string;
}): AuditPaymentPlanWithdrawalAfterSnapshot {
  return {
    status: 'WITHDRAWN',
    withdrawnAt: record.withdrawnAt.toISOString(),
    withdrawnByStaffUserId: record.withdrawnByStaffUserId,
    reason: record.reason,
  };
}

export type AuditPaymentStatusSnapshot = { status: string };

/**
 * Mirrors features/bookings/audit.ts's `sanitizeBookingStatusSnapshot`
 * exactly (D-014's "Audit only: beforeState: { status: previousStatus },
 * afterState: { status: newStatus }" pattern) — the two status values only,
 * never the rest of the Payment record.
 */
export function sanitizePaymentStatusSnapshot(status: string): AuditPaymentStatusSnapshot {
  return { status };
}

export type AuditPaymentStatusChangeSnapshot = { status: string; reason: string };

/**
 * The afterState for a confirmation, reversal, or refund-completing status
 * change: the new status plus the required reason (blueprint Section 11.7:
 * "acting user, timestamp, reason, and before/after values"). The
 * beforeState stays `sanitizePaymentStatusSnapshot`'s status-only shape.
 */
export function sanitizePaymentStatusChangeSnapshot(
  status: string,
  reason: string,
): AuditPaymentStatusChangeSnapshot {
  return { status, reason };
}

export type AuditPaymentRefundBeforeSnapshot = { status: string; refundedTotal: string };

/**
 * The beforeState for a refund: the Payment's status and cumulative refunded
 * total immediately before this refund (blueprint Section 11.5: "before/after
 * values"). `refundedTotal` is a decimal string, never a binary float
 * (CLAUDE.md §8).
 */
export function sanitizePaymentRefundBeforeSnapshot(record: {
  status: string;
  refundedTotal: string;
}): AuditPaymentRefundBeforeSnapshot {
  return { status: record.status, refundedTotal: record.refundedTotal };
}

export type AuditPaymentRefundSnapshot = {
  paymentId: string;
  amount: string;
  reason: string;
  allocationId: string | null;
  status: string;
  refundedTotal: string;
};

/**
 * The audit afterState for a refund — deliberately narrower than a full
 * PaymentRefund row: the Payment it targets, the amount actually returned,
 * the required reason, the allocation it was linked to (null when it came
 * from unallocated credit), and the Payment's status and cumulative refunded
 * total after it (blueprint Sections 11.5 and 11.7: "acting user, timestamp,
 * reason, and before/after values" — actor/timestamp already come from
 * AuditLog.actorId/createdAt). Amounts are decimal strings, never binary
 * floats (CLAUDE.md §8).
 */
export function sanitizePaymentRefundSnapshot(record: {
  paymentId: string;
  amount: string;
  reason: string;
  allocationId: string | null;
  status: string;
  refundedTotal: string;
}): AuditPaymentRefundSnapshot {
  return {
    paymentId: record.paymentId,
    amount: record.amount,
    reason: record.reason,
    allocationId: record.allocationId,
    status: record.status,
    refundedTotal: record.refundedTotal,
  };
}

export type AuditAllocationSnapshot = {
  paymentId: string;
  installmentId: string;
  amount: string;
};

export function sanitizeAllocationSnapshot(record: {
  paymentId: string;
  installmentId: string;
  amount: string;
}): AuditAllocationSnapshot {
  return {
    paymentId: record.paymentId,
    installmentId: record.installmentId,
    amount: record.amount,
  };
}

export type AuditReceiptSnapshot = {
  paymentId: string;
  receiptNumber: string;
  amount: string;
};

export function sanitizeReceiptSnapshot(record: {
  paymentId: string;
  receiptNumber: string;
  amount: string;
}): AuditReceiptSnapshot {
  return {
    paymentId: record.paymentId,
    receiptNumber: record.receiptNumber,
    amount: record.amount,
  };
}
