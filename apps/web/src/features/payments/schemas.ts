import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';

// Every monetary amount in this feature is accepted as a decimal string,
// never a JavaScript `number` (CLAUDE.md §8; .claude/rules/database-security.md's
// "Monetary Values" rule: never binary floating-point). The regex matches
// `@db.Decimal(18, 2)`'s shape exactly — up to 16 digits before the decimal
// point (18 total minus the 2 required after it), exactly two after it, no
// leading zero on a multi-digit integer part, no sign, no exponent. The
// `.refine` below additionally rejects "0.00" using `Prisma.Decimal` itself
// (never `Number(...)`), matching every `*_amount_positive` CHECK constraint
// named in D-019 (`payment_amount_positive`, `installment_amount_positive`,
// `payment_refund_amount_positive`, `payment_allocation_amount_positive`,
// `receipt_amount_positive`).
const MONEY_STRING_PATTERN = /^(0|[1-9]\d{0,15})\.\d{2}$/;

export const positiveMoneyAmountSchema = z
  .string()
  .regex(
    MONEY_STRING_PATTERN,
    'amount must be a decimal string with exactly two decimal places (e.g. "150.00")',
  )
  .refine((value) => {
    // Zod runs every chained check independently, even after an earlier one
    // on the same schema has already failed (no short-circuit) — so a value
    // that already failed MONEY_STRING_PATTERN above (e.g. "abc") still
    // reaches this refine. Guard by re-testing the same pattern before ever
    // constructing a `Prisma.Decimal`, whose constructor throws a raw,
    // unhandled `DecimalError` for a non-numeric string rather than
    // returning a value — that must never escape this schema boundary.
    return MONEY_STRING_PATTERN.test(value) && new Prisma.Decimal(value).greaterThan(0);
  }, 'amount must be greater than zero');

const idempotencyKeySchema = z
  .string()
  .min(1, 'idempotencyKey must not be empty')
  .max(255, 'idempotencyKey must be at most 255 characters');

const reasonSchema = z
  .string()
  .trim()
  .min(1, 'reason must not be empty')
  .max(1000, 'reason must be at most 1000 characters');

const uuidSchema = z.string().uuid();

// --- Payment-plan proposal (D-054 §§3, 6; blueprint §11.3, §11.4) ---
// `.strict()` throughout this file, matching features/bookings/schemas.ts's
// established convention: an unrecognized property fails validation with a
// 400 rather than being silently stripped.

const proposedInstallmentSchema = z
  .object({
    sequenceNumber: z.number().int().positive(),
    isDeposit: z.boolean().default(false),
    amount: positiveMoneyAmountSchema,
    // Date-only, matching Installment.dueDate's `@db.Date` column — an
    // ISO calendar date string, never a full timestamp. The refine rejects a
    // well-shaped but impossible date (e.g. 2026-02-31, which `Date` would
    // otherwise silently roll over to 2026-03-03).
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'dueDate must be an ISO calendar date (YYYY-MM-DD)')
      .refine(isRealCalendarDate, 'dueDate must be a real calendar date'),
  })
  .strict();

function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const proposePaymentPlanSchema = z
  .object({
    bookingId: uuidSchema,
    installments: z.array(proposedInstallmentSchema).min(1, 'at least one installment is required'),
  })
  .strict()
  // D-019's installment-structure rules, surfaced as field-level validation
  // errors at the boundary; the service re-checks them (service.ts's
  // `installmentStructureViolation`) for any caller that bypasses this schema.
  .superRefine((plan, context) => {
    const seen = new Set<number>();
    plan.installments.forEach((installment, index) => {
      if (seen.has(installment.sequenceNumber)) {
        context.addIssue({
          code: 'custom',
          path: ['installments', index, 'sequenceNumber'],
          message: 'each installment must have a distinct sequenceNumber',
        });
      }
      seen.add(installment.sequenceNumber);
    });
    const deposits = plan.installments.flatMap((installment, index) =>
      installment.isDeposit ? [{ installment, index }] : [],
    );
    deposits.slice(1).forEach(({ index }) => {
      context.addIssue({
        code: 'custom',
        path: ['installments', index, 'isDeposit'],
        message: 'a payment plan may have at most one deposit installment',
      });
    });
    const deposit = deposits[0];
    if (deposit && deposit.installment.sequenceNumber !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['installments', deposit.index, 'sequenceNumber'],
        message: 'a deposit installment must be sequenceNumber 1',
      });
    }
  });
export type ProposePaymentPlanInput = z.infer<typeof proposePaymentPlanSchema>;

// No `idempotencyKey` field: `PaymentPlan` has no such column (D-019 names
// one only for PaymentAllocation, PaymentAllocationReversal, PaymentRefund,
// and PaymentStatusHistory's CONFIRMED/REVERSED/REFUNDED transitions — never
// for PaymentPlan approval). Approval is naturally idempotent by its own
// state instead: approving an already-approved plan is a safe no-op
// (service.ts), mirroring features/bookings/service.ts's
// `updateBookingStatus`'s "newStatus === current status" idempotent-no-op
// check — no caller-supplied key is needed because re-approving changes no
// content and carries no ambiguity risk.
export const approvePaymentPlanSchema = z
  .object({
    paymentPlanId: uuidSchema,
  })
  .strict();
export type ApprovePaymentPlanInput = z.infer<typeof approvePaymentPlanSchema>;

// --- Manual/external payment recording and confirmation (D-054 §6) ---
// No payment-gateway field of any kind is accepted here (D-054 §12's
// explicit exclusion) — this schema only ever records that money was
// already received outside this system.
//
// `idempotencyKey` is required (D-054 §17 Rule 6, September 25, 2026): a
// resubmitted request would otherwise create a second PENDING Payment that
// no operation can cancel (§17 Rule 1). `Payment` has no key column; the key
// is stored on the Payment's initial PENDING `PaymentStatusHistory` row,
// whose `idempotencyKey` column is already nullable and unique, and which
// D-019's `payment_status_history_idempotency_key_required` CHECK permits
// (it requires a key only for CONFIRMED, REVERSED, and REFUNDED).
export const recordPaymentSchema = z
  .object({
    bookingId: uuidSchema,
    amount: positiveMoneyAmountSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const confirmPaymentSchema = z
  .object({
    paymentId: uuidSchema,
    reason: reasonSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentSchema>;

export const reversePaymentSchema = z
  .object({
    paymentId: uuidSchema,
    reason: reasonSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

// `allocationId` is optional — per D-019's PaymentRefundAllocation model
// doc comment, "any portion of a PaymentRefund's amount not represented by
// a PaymentRefundAllocation row is, by construction, a refund from unapplied
// Booking credit," so a refund need not target a specific allocation.
export const refundPaymentSchema = z
  .object({
    paymentId: uuidSchema,
    amount: positiveMoneyAmountSchema,
    reason: reasonSchema,
    idempotencyKey: idempotencyKeySchema,
    allocationId: uuidSchema.optional(),
  })
  .strict();
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;

export const issueReceiptSchema = z
  .object({
    paymentId: uuidSchema,
  })
  .strict();
export type IssueReceiptInput = z.infer<typeof issueReceiptSchema>;

// --- Allocation (D-054 §4; D-019) ---

export const createAllocationSchema = z
  .object({
    paymentId: uuidSchema,
    installmentId: uuidSchema,
    amount: positiveMoneyAmountSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type CreateAllocationInput = z.infer<typeof createAllocationSchema>;

export const reverseAllocationSchema = z
  .object({
    allocationId: uuidSchema,
    reason: reasonSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type ReverseAllocationInput = z.infer<typeof reverseAllocationSchema>;

// --- Reads ---

export const bookingIdParamSchema = z.object({ bookingId: uuidSchema });
