// Action names written to AuditLog.action (blueprint Section 14.9;
// .claude/rules/backend.md's Auditability rule; D-054 §8), mirroring
// features/bookings/audit.ts's BOOKING_AUDIT_ACTIONS convention exactly.
export const PAYMENT_AUDIT_ACTIONS = {
  PAYMENT_PLAN_PROPOSED: 'PAYMENT_PLAN_PROPOSED',
  PAYMENT_PLAN_APPROVED: 'PAYMENT_PLAN_APPROVED',
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
};

/**
 * Explicit allow-list snapshot for a PaymentPlan audit entry — matches
 * features/bookings/audit.ts's `sanitizeBookingSnapshot` discipline exactly:
 * a fresh object built from exactly the named fields, never a spread of the
 * source record. Never includes installment amounts/due dates (those are
 * audited on their own terms only if a future correction workflow needs it,
 * D-019's own open item) — only which plan changed, for which booking/
 * client, and its approval state.
 */
export function sanitizePaymentPlanSnapshot(record: {
  id: string;
  bookingId: string;
  clientId: string;
  approvedByStaffUserId: string | null;
  approvedAt: Date | null;
}): AuditPaymentPlanSnapshot {
  return {
    id: record.id,
    bookingId: record.bookingId,
    clientId: record.clientId,
    approvedByStaffUserId: record.approvedByStaffUserId,
    approvedAt: record.approvedAt ? record.approvedAt.toISOString() : null,
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

export type AuditPaymentRefundSnapshot = {
  paymentId: string;
  amount: string;
  reason: string;
};

/**
 * The audit afterState for a refund — deliberately narrower than a full
 * PaymentRefund row: the Payment it targets, the amount actually returned,
 * and the required reason (blueprint Section 11.7: "acting user, timestamp,
 * reason, and before/after values" — actor/timestamp already come from
 * AuditLog.actorId/createdAt). `amount` is passed as the same decimal string
 * already validated by schemas.ts, never converted to a binary float
 * (CLAUDE.md §8).
 */
export function sanitizePaymentRefundSnapshot(record: {
  paymentId: string;
  amount: string;
  reason: string;
}): AuditPaymentRefundSnapshot {
  return { paymentId: record.paymentId, amount: record.amount, reason: record.reason };
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
