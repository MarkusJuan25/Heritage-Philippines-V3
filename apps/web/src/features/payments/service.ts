import { randomUUID } from 'node:crypto';

import { Prisma, PaymentStatus } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import { isResidualDatabaseConflict, isUniqueViolationOn } from '@/lib/prisma-errors';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { canAccessClient } from '@/features/assignments/authorization';

import {
  PAYMENT_ALLOCATION_AUDIT_ENTITY_TYPE,
  PAYMENT_AUDIT_ACTIONS,
  PAYMENT_AUDIT_ENTITY_TYPE,
  PAYMENT_PLAN_AUDIT_ENTITY_TYPE,
  RECEIPT_AUDIT_ENTITY_TYPE,
  sanitizeAllocationSnapshot,
  sanitizePaymentPlanSnapshot,
  sanitizePaymentRefundBeforeSnapshot,
  sanitizePaymentRefundSnapshot,
  sanitizePaymentStatusChangeSnapshot,
  sanitizePaymentStatusSnapshot,
  sanitizeReceiptSnapshot,
} from './audit';
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
import { PaymentError } from './errors';
import * as repository from './repository';
import type {
  AllocationRecord,
  BookingPaymentSummaryData,
  PaymentActor,
  PaymentPlanRecord,
  PaymentRecord,
  ReceiptRecord,
  RefundRecord,
} from './repository';
import type {
  ApprovePaymentPlanInput,
  ConfirmPaymentInput,
  CreateAllocationInput,
  IssueReceiptInput,
  ProposePaymentPlanInput,
  RecordPaymentInput,
  RefundPaymentInput,
  ReverseAllocationInput,
  ReversePaymentInput,
} from './schemas';

// --- Defense-in-depth actor assertions (.claude/rules/backend.md
// "Authentication vs. Authorization") ---
// Mirrors features/bookings/service.ts's `assertBookingActor` exactly: an
// *additional*, independent check protecting the service boundary itself —
// a future route layer's own role gate is not built in this Stage 2 (D-054
// §10), so every exported function below asserts its own role requirement
// first, before opening any transaction or calling any repository function.

function assertProposerActor(actor: AuthenticatedUser): PaymentActor {
  if (actor.role === 'TRAVEL_CONSULTANT') {
    return { id: actor.id, role: 'TRAVEL_CONSULTANT' };
  }
  throw new PaymentError(
    'ROLE_NOT_PERMITTED',
    'Only a Travel Consultant may propose a payment plan.',
  );
}

function assertFinanceActor(actor: AuthenticatedUser): PaymentActor {
  if (actor.role === 'FINANCE_ACCOUNTING') {
    return { id: actor.id, role: 'FINANCE_ACCOUNTING' };
  }
  throw new PaymentError(
    'ROLE_NOT_PERMITTED',
    'Only Finance/Accounting may perform this payment operation.',
  );
}

function assertStaffReadActor(actor: AuthenticatedUser): PaymentActor {
  if (
    actor.role === 'ADMIN_MANAGER' ||
    actor.role === 'TRAVEL_CONSULTANT' ||
    actor.role === 'FINANCE_ACCOUNTING'
  ) {
    return { id: actor.id, role: actor.role };
  }
  throw new PaymentError(
    'ROLE_NOT_PERMITTED',
    'This role is not permitted to view payment records.',
  );
}

function assertClientActor(actor: AuthenticatedUser): { id: string } {
  if (actor.role === 'CLIENT') {
    return { id: actor.id };
  }
  throw new PaymentError(
    'ROLE_NOT_PERMITTED',
    'This role is not permitted to access client payments.',
  );
}

// --- Shared conflict handling (lib/prisma-errors.ts's verified
// adapter-error recognition, shared with features/bookings and
// features/proposals) ---

// Exhausted serializable retries (SerializableRetriesExhaustedError) or a
// P2002 unmatched by a model-qualified isUniqueViolationOn check at the call
// site: mapped by each caller to its own safe conflict error. A CHECK
// violation is never a conflict: it stays an unknown error with the generic
// response, with no CHECK-constraint allowlist here (D-055).
function isOtherKnownConflict(error: unknown): boolean {
  return isResidualDatabaseConflict(error);
}

// A duplicate PaymentStatusHistory.idempotencyKey. That row is only ever
// written as a nested create inside a Payment create or update, and Prisma
// reports the violation against the parent model: `modelName: 'Payment'`
// with the history row's `idempotencyKey` field (verified against
// PostgreSQL in service.integration.test.ts). Payment has no
// `idempotencyKey` field of its own, so this match is unambiguous.
function isStatusHistoryKeyViolation(error: unknown): boolean {
  return isUniqueViolationOn(error, 'Payment', ['idempotencyKey']);
}

// --- Idempotent-replay resolution (D-019; D-054 §8) ---
// A retry is answered with its own prior result only when the stored record
// matches the request on every identifying field — the same Payment, the
// same target status or allocation, the same amount. A key the same kind of
// operation already used for a different request is IDEMPOTENCY_KEY_CONFLICT,
// never a "success" that hands back an unrelated record. Each operation
// checks only its own key table (D-054 §8's per-operation retry guarantee),
// so reuse of a key across different kinds of operation is not generally
// detected. recordPayment, confirmPayment, and reversePayment share
// PaymentStatusHistory's key column, so a key used by one of them is a
// conflict for the others; refundPayment additionally checks that column
// because a completing refund writes its key there too. Every replay also
// re-reads the Payment through the actor-scoped `findPaymentForActor`, so a
// key can never be used to read a Payment the actor is not assigned to
// (.claude/rules/admin-dashboard.md's
// "every fetch of a specific record re-checks authorization").

function idempotencyKeyConflict(): PaymentError {
  return new PaymentError(
    'IDEMPOTENCY_KEY_CONFLICT',
    'This idempotency key has already been used for a different request.',
  );
}

async function findScopedPaymentOrForbidden(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  paymentId: string,
): Promise<PaymentRecord> {
  const payment = await repository.findPaymentForActor(db, actor, paymentId);
  if (!payment) {
    throw new PaymentError('PAYMENT_FORBIDDEN', 'Payment not found or not accessible.');
  }
  return payment;
}

/**
 * recordPayment's replay (D-054 §17 Rule 6). Called only after the actor's
 * access to `input.bookingId` has been verified, so an unassigned caller
 * learns nothing about a key. The key must name a Payment's initial PENDING
 * row — never a later status change — and that Payment must belong to the
 * same Booking with the same amount; anything else is
 * IDEMPOTENCY_KEY_CONFLICT, never the other Payment. A replay returns the
 * Payment as it is now, so a retry after the Payment was confirmed,
 * reversed, or refunded returns it in that status and creates nothing.
 */
async function resolveRecordReplay(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  input: RecordPaymentInput,
): Promise<PaymentRecord | null> {
  const history = await repository.findStatusHistoryByIdempotencyKey(db, input.idempotencyKey);
  if (!history) return null;
  if (history.previousStatus !== null || history.newStatus !== PaymentStatus.PENDING) {
    throw idempotencyKeyConflict();
  }
  const payment = await repository.findPaymentForActor(db, actor, history.paymentId);
  if (!payment || payment.bookingId !== input.bookingId || !payment.amount.equals(input.amount)) {
    throw idempotencyKeyConflict();
  }
  return payment;
}

async function resolveStatusTransitionReplay(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  input: { paymentId: string; idempotencyKey: string },
  targetStatus: PaymentStatus,
): Promise<PaymentRecord | null> {
  const history = await repository.findStatusHistoryByIdempotencyKey(db, input.idempotencyKey);
  if (!history) return null;
  if (history.paymentId !== input.paymentId || history.newStatus !== targetStatus) {
    throw idempotencyKeyConflict();
  }
  return findScopedPaymentOrForbidden(db, actor, history.paymentId);
}

async function resolveRefundReplay(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  input: RefundPaymentInput,
): Promise<RefundPaymentResult | null> {
  const existing = await repository.findRefundByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) return null;
  if (
    existing.paymentId !== input.paymentId ||
    !existing.amount.equals(input.amount) ||
    existing.allocationId !== (input.allocationId ?? null)
  ) {
    throw idempotencyKeyConflict();
  }
  const payment = await findScopedPaymentOrForbidden(db, actor, existing.paymentId);
  const refund: RefundRecord = {
    id: existing.id,
    paymentId: existing.paymentId,
    amount: existing.amount,
    reason: existing.reason,
  };
  return { refund, payment };
}

async function resolveAllocationReplay(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  input: CreateAllocationInput,
): Promise<AllocationRecord | null> {
  const existing = await repository.findAllocationByIdempotencyKey(db, input.idempotencyKey);
  if (!existing) return null;
  if (
    existing.paymentId !== input.paymentId ||
    existing.installmentId !== input.installmentId ||
    !existing.amount.equals(input.amount)
  ) {
    throw idempotencyKeyConflict();
  }
  await findScopedPaymentOrForbidden(db, actor, existing.paymentId);
  return existing;
}

async function resolveAllocationReversalReplay(
  db: Prisma.TransactionClient,
  actor: PaymentActor,
  input: ReverseAllocationInput,
): Promise<{ id: string; paymentAllocationId: string } | null> {
  const existing = await repository.findAllocationReversalByIdempotencyKey(
    db,
    input.idempotencyKey,
  );
  if (!existing) return null;
  if (existing.paymentAllocationId !== input.allocationId) {
    throw idempotencyKeyConflict();
  }
  const allocation = await repository.findAllocationForReversal(db, existing.paymentAllocationId);
  if (!allocation) {
    throw new PaymentError('PAYMENT_FORBIDDEN', 'Payment not found or not accessible.');
  }
  await findScopedPaymentOrForbidden(db, actor, allocation.paymentId);
  return existing;
}

// --- Payment-plan proposal and approval (D-054 §§3, 4, 6; blueprint §11.3, §11.4) ---

/**
 * D-019's installment-structure rules for a proposed plan, checked before
 * any database work so a violation gets a precise message rather than a
 * unique-index error reported as a generic plan conflict: sequence numbers
 * are distinct (`@@unique([paymentPlanId, sequenceNumber])`), at most one
 * installment is a deposit (`installment_active_deposit_key`), and a
 * deposit, when present, is `sequenceNumber` 1 (D-019). Whether a plan has a
 * deposit at all is left to the booking's own terms (D-019). Returns the
 * violation's message, or `null` when the structure is valid.
 */
function installmentStructureViolation(
  installments: ProposePaymentPlanInput['installments'],
): string | null {
  const sequenceNumbers = new Set(installments.map((installment) => installment.sequenceNumber));
  if (sequenceNumbers.size !== installments.length) {
    return 'Each installment must have a distinct sequence number.';
  }
  const deposits = installments.filter((installment) => installment.isDeposit);
  if (deposits.length > 1) {
    return 'A payment plan may have at most one deposit installment.';
  }
  if (deposits[0] && deposits[0].sequenceNumber !== 1) {
    return 'A deposit installment must be the first installment (sequence number 1).';
  }
  return null;
}

/**
 * Proposes a PaymentPlan's commercial terms for a Booking the acting Travel
 * Consultant is assigned to (D-054 §3). Requires the Booking's
 * `totalAmount`/`currencyCode` to already be set (D-019's own creation-order
 * invariant — a PaymentPlan may not exist before both are non-null).
 *
 * Deliberately NOT idempotent by a caller-supplied key (see schemas.ts's
 * `proposePaymentPlanSchema` doc comment): `PaymentPlan.bookingId @unique`
 * is the only natural uniqueness this operation has, and unlike
 * `createBooking`'s `proposalVersionId` race (where the racing request is
 * provably requesting the *same* outcome), a second `proposePaymentPlan`
 * call for a Booking that already has a plan could carry entirely different
 * installment content — silently returning the already-persisted plan would
 * misrepresent what was actually stored. Both an explicit pre-check and the
 * `bookingId` unique-constraint race (two concurrent first proposals) are
 * therefore treated identically as `PAYMENT_PLAN_CONFLICT`, never as a
 * silent idempotent success.
 */
export async function proposePaymentPlan(
  actor: AuthenticatedUser,
  input: ProposePaymentPlanInput,
): Promise<PaymentPlanRecord> {
  const paymentActor = assertProposerActor(actor);

  const structureViolation = installmentStructureViolation(input.installments);
  if (structureViolation) {
    throw new PaymentError('PAYMENT_PLAN_CONFLICT', structureViolation);
  }

  try {
    return await runSerializableWithRetry(async (tx) => {
      const booking = await repository.findBookingFinancialsForActor(
        tx,
        paymentActor,
        input.bookingId,
      );
      if (!booking) {
        throw new PaymentError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.');
      }
      if (booking.totalAmount === null || booking.currencyCode === null) {
        throw new PaymentError(
          'PAYMENT_PLAN_CONFLICT',
          'This booking has no total amount and currency set yet; a payment plan cannot be proposed until both exist.',
        );
      }

      const existing = await repository.findPaymentPlanByBookingIdForActor(
        tx,
        paymentActor,
        input.bookingId,
      );
      if (existing) {
        throw new PaymentError(
          'PAYMENT_PLAN_CONFLICT',
          'A payment plan already exists for this booking.',
        );
      }

      const created = await repository.createPaymentPlanWithInstallments(tx, {
        id: randomUUID(),
        bookingId: input.bookingId,
        clientId: booking.clientId,
        proposedByStaffUserId: paymentActor.id,
        installments: input.installments.map((installment) => ({
          id: randomUUID(),
          sequenceNumber: installment.sequenceNumber,
          isDeposit: installment.isDeposit,
          amount: installment.amount,
          dueDate: new Date(`${installment.dueDate}T00:00:00.000Z`),
        })),
      });

      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.PAYMENT_PLAN_PROPOSED,
        entityType: PAYMENT_PLAN_AUDIT_ENTITY_TYPE,
        entityId: created.id,
        afterState: sanitizePaymentPlanSnapshot(created),
      });

      return created;
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (isUniqueViolationOn(error, 'PaymentPlan', ['bookingId']) || isOtherKnownConflict(error)) {
      throw new PaymentError(
        'PAYMENT_PLAN_CONFLICT',
        'A payment plan already exists for this booking.',
      );
    }
    throw error;
  }
}

/**
 * Approves a proposed PaymentPlan (Finance/Accounting only, D-054 §3/§6),
 * making it active and client-visible (blueprint §11.3). Reconciles the sum
 * of its Installments against `Booking.totalAmount` first (schema.prisma's
 * PaymentPlan model doc comment's reconciliation invariant) — a mismatch is
 * `PAYMENT_PLAN_CONFLICT`, never silently approved. Approving an
 * already-approved plan is an idempotent no-op (see schemas.ts's doc
 * comment on why no caller-supplied key is needed here), mirroring
 * `updateBookingStatus`'s identical "no-op if already in the target state"
 * pattern.
 */
export async function approvePaymentPlan(
  actor: AuthenticatedUser,
  input: ApprovePaymentPlanInput,
): Promise<PaymentPlanRecord> {
  const paymentActor = assertFinanceActor(actor);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const found = await repository.findPaymentPlanWithBookingForActor(
        tx,
        paymentActor,
        input.paymentPlanId,
      );
      if (!found) {
        throw new PaymentError(
          'PAYMENT_PLAN_FORBIDDEN',
          'Payment plan not found or not accessible.',
        );
      }
      const { plan, booking } = found;

      if (plan.approvedAt !== null) {
        return plan;
      }

      if (booking.totalAmount === null) {
        throw new PaymentError(
          'PAYMENT_PLAN_CONFLICT',
          'This booking has no total amount set; the payment plan cannot be approved.',
        );
      }

      const installmentTotal = await repository.sumInstallmentAmounts(tx, plan.id);
      if (!installmentTotal.equals(booking.totalAmount)) {
        throw new PaymentError(
          'PAYMENT_PLAN_CONFLICT',
          'The installments do not sum to the booking total amount; the payment plan cannot be approved.',
        );
      }

      const updated = await repository.approvePaymentPlanRow(tx, {
        id: plan.id,
        approvedByStaffUserId: paymentActor.id,
        approvedAt: new Date(),
      });

      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.PAYMENT_PLAN_APPROVED,
        entityType: PAYMENT_PLAN_AUDIT_ENTITY_TYPE,
        entityId: updated.id,
        beforeState: { approvedAt: null },
        afterState: sanitizePaymentPlanSnapshot(updated),
      });

      return updated;
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (isOtherKnownConflict(error)) {
      throw new PaymentError('PAYMENT_PLAN_CONFLICT', 'This payment plan could not be approved.');
    }
    throw error;
  }
}

// --- Manual/external payment recording, confirmation, reversal, refund
// (D-054 §§3, 4, 6, 8; D-019) ---

/**
 * Records that a payment was received outside this system (bank transfer,
 * over-the-counter deposit, or other manual/external channel) — Finance/
 * Accounting only. This is the *only* way a Payment enters this system
 * (D-054 §6): no online payment gateway, hosted checkout, or card/e-wallet
 * integration exists or is authorized. The created Payment starts `PENDING`
 * (D-019/D-054 §4) — a separate `confirmPayment` call is required before it
 * counts toward any balance.
 *
 * Idempotent by the required `idempotencyKey` (D-054 §17 Rule 6), stored on
 * the new Payment's initial PENDING status-history row: a retry with the
 * same key, Booking, and amount returns the original Payment (in its
 * current status) and writes nothing; see `resolveRecordReplay`. Two
 * genuine payments of equal amount need distinct keys. A concurrent
 * duplicate loses on the key's unique index (or a serialization failure,
 * retried) and is answered by the same replay.
 */
export async function recordPayment(
  actor: AuthenticatedUser,
  input: RecordPaymentInput,
): Promise<PaymentRecord> {
  const paymentActor = assertFinanceActor(actor);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const booking = await repository.findBookingFinancialsForActor(
        tx,
        paymentActor,
        input.bookingId,
      );
      if (!booking) {
        throw new PaymentError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.');
      }
      const replay = await resolveRecordReplay(tx, paymentActor, input);
      if (replay) {
        return replay;
      }
      // D-054 §17 Rule 4: a Payment against a Booking with no currency could
      // never receive a Receipt. D-019's booking_financials_pairing
      // constraint sets `totalAmount` and `currencyCode` together, so this
      // one check also guarantees a total. Checked only after the assignment
      // check above, and before anything is written. A PaymentPlan is not
      // required.
      if (booking.currencyCode === null) {
        throw new PaymentError(
          'BOOKING_CURRENCY_NOT_SET',
          "This booking's currency is not set yet; a payment cannot be recorded against it.",
        );
      }

      const created = await repository.createPendingPayment(tx, {
        id: randomUUID(),
        bookingId: input.bookingId,
        clientId: booking.clientId,
        amount: input.amount,
        changedByUserId: paymentActor.id,
        idempotencyKey: input.idempotencyKey,
      });

      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.PAYMENT_RECORDED,
        entityType: PAYMENT_AUDIT_ENTITY_TYPE,
        entityId: created.id,
        afterState: { bookingId: created.bookingId, amount: input.amount },
      });

      return created;
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (isStatusHistoryKeyViolation(error)) {
      // The losing side of a concurrent duplicate. Access to the Booking was
      // verified in the rolled-back attempt; the replay re-reads the Payment
      // through the actor-scoped lookup.
      const replay = await resolveRecordReplay(prisma, paymentActor, input);
      if (replay) return replay;
    }
    if (isOtherKnownConflict(error)) {
      throw new PaymentError(
        'PAYMENT_CONFLICT',
        'This payment could not be recorded. Please try again.',
      );
    }
    throw error;
  }
}

/**
 * Confirms a `PENDING` Payment (Finance/Accounting only) — D-054 §4's exact
 * lifecycle: only a `PENDING` Payment may be confirmed. Idempotent by the
 * caller-supplied `idempotencyKey` (D-019): a retry presenting the same key
 * returns the already-confirmed Payment unchanged, never double-applying the
 * confirmation.
 */
export async function confirmPayment(
  actor: AuthenticatedUser,
  input: ConfirmPaymentInput,
): Promise<PaymentRecord> {
  const paymentActor = assertFinanceActor(actor);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const replay = await resolveStatusTransitionReplay(
        tx,
        paymentActor,
        input,
        PaymentStatus.CONFIRMED,
      );
      if (replay) {
        return replay;
      }

      const found = await findScopedPaymentOrForbidden(tx, paymentActor, input.paymentId);
      if (found.status !== PaymentStatus.PENDING) {
        throw new PaymentError(
          'INVALID_PAYMENT_TRANSITION',
          `Only a PENDING payment may be confirmed (current status: ${found.status}).`,
        );
      }

      const updated = await repository.transitionPaymentStatus(tx, {
        paymentId: found.id,
        previousStatus: found.status,
        newStatus: PaymentStatus.CONFIRMED,
        changedByUserId: paymentActor.id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });

      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.PAYMENT_STATUS_CHANGED,
        entityType: PAYMENT_AUDIT_ENTITY_TYPE,
        entityId: updated.id,
        beforeState: sanitizePaymentStatusSnapshot(found.status),
        afterState: sanitizePaymentStatusChangeSnapshot(updated.status, input.reason),
      });

      return updated;
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (isStatusHistoryKeyViolation(error)) {
      const replay = await resolveStatusTransitionReplay(
        prisma,
        paymentActor,
        input,
        PaymentStatus.CONFIRMED,
      );
      if (replay) return replay;
    }
    if (isOtherKnownConflict(error)) {
      throw new PaymentError(
        'PAYMENT_CONFLICT',
        'This payment could not be confirmed. Please try again.',
      );
    }
    throw error;
  }
}

/**
 * Reverses a `CONFIRMED` Payment (Finance/Accounting only) — D-054 §4's
 * exact rule: available only while the Payment has zero refunds recorded
 * against it (D-019: "refunded and reversed are mutually exclusive"); a
 * Payment that has already reached any terminal status has no correction
 * path this entry defines (D-054 §13). Idempotent by `idempotencyKey`, same
 * mechanism as `confirmPayment`.
 */
export async function reversePayment(
  actor: AuthenticatedUser,
  input: ReversePaymentInput,
): Promise<PaymentRecord> {
  const paymentActor = assertFinanceActor(actor);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const replay = await resolveStatusTransitionReplay(
        tx,
        paymentActor,
        input,
        PaymentStatus.REVERSED,
      );
      if (replay) {
        return replay;
      }

      const found = await findScopedPaymentOrForbidden(tx, paymentActor, input.paymentId);
      if (found.status !== PaymentStatus.CONFIRMED) {
        throw new PaymentError(
          'INVALID_PAYMENT_TRANSITION',
          `Only a CONFIRMED payment may be reversed (current status: ${found.status}).`,
        );
      }

      const refundedTotal = await repository.sumRefundsForPayment(tx, found.id);
      if (refundedTotal.greaterThan(0)) {
        throw new PaymentError(
          'INVALID_PAYMENT_TRANSITION',
          'A payment with any refund recorded against it can never be reversed.',
        );
      }

      const updated = await repository.transitionPaymentStatus(tx, {
        paymentId: found.id,
        previousStatus: found.status,
        newStatus: PaymentStatus.REVERSED,
        changedByUserId: paymentActor.id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });

      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.PAYMENT_STATUS_CHANGED,
        entityType: PAYMENT_AUDIT_ENTITY_TYPE,
        entityId: updated.id,
        beforeState: sanitizePaymentStatusSnapshot(found.status),
        afterState: sanitizePaymentStatusChangeSnapshot(updated.status, input.reason),
      });

      return updated;
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (isStatusHistoryKeyViolation(error)) {
      const replay = await resolveStatusTransitionReplay(
        prisma,
        paymentActor,
        input,
        PaymentStatus.REVERSED,
      );
      if (replay) return replay;
    }
    if (isOtherKnownConflict(error)) {
      throw new PaymentError(
        'PAYMENT_CONFLICT',
        'This payment could not be reversed. Please try again.',
      );
    }
    throw error;
  }
}

export type RefundPaymentResult = { refund: RefundRecord; payment: PaymentRecord };

/**
 * Refunds a `CONFIRMED` Payment, in full or in part (Finance/Accounting
 * only) — D-054 §4: available only while cumulative refunds remain below
 * the Payment's full amount. When this refund brings cumulative refunds to
 * exactly the Payment's amount, the Payment transitions to `REFUNDED` in the
 * same transaction (D-019). When `allocationId` is supplied, this refund
 * also reduces that specific `PaymentAllocation`'s active balance (D-019's
 * `PaymentRefundAllocation` model), never exceeding that allocation's own
 * remaining amount; when omitted, the refund comes entirely from this
 * Payment's own unallocated credit (D-054 §17 Rule 2).
 *
 * Idempotent by the caller-supplied `idempotencyKey`: the same key is used
 * for both the `PaymentRefund` row and (only if this refund completes the
 * Payment) its `PaymentStatusHistory` transition — safe because they are
 * `@unique` on two independent columns of two independent tables, so
 * reusing one value cannot collide between them, and a retry presenting the
 * same key finds the already-created `PaymentRefund` and returns
 * immediately.
 */
export async function refundPayment(
  actor: AuthenticatedUser,
  input: RefundPaymentInput,
): Promise<RefundPaymentResult> {
  const paymentActor = assertFinanceActor(actor);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const replay = await resolveRefundReplay(tx, paymentActor, input);
      if (replay) {
        return replay;
      }
      // The same key is also written to the REFUNDED status-history row
      // below; a key already held by some other status transition can never
      // become this refund's key.
      if (await repository.findStatusHistoryByIdempotencyKey(tx, input.idempotencyKey)) {
        throw idempotencyKeyConflict();
      }

      const found = await findScopedPaymentOrForbidden(tx, paymentActor, input.paymentId);
      if (found.status !== PaymentStatus.CONFIRMED) {
        throw new PaymentError(
          'INVALID_PAYMENT_TRANSITION',
          `Only a CONFIRMED payment may be refunded (current status: ${found.status}).`,
        );
      }

      const existingRefundTotal = await repository.sumRefundsForPayment(tx, found.id);
      const amount = new Prisma.Decimal(input.amount);
      const newRefundTotal = existingRefundTotal.plus(amount);
      if (newRefundTotal.greaterThan(found.amount)) {
        throw new PaymentError(
          'REFUND_EXCEEDS_REMAINING',
          'This refund would exceed the payment amount not already refunded.',
        );
      }

      if (input.allocationId) {
        const allocation = await repository.findAllocationForRefund(tx, input.allocationId);
        // A reversed allocation no longer counts toward any Installment
        // (D-019's net-active-allocation formula), so a refund can never be
        // linked to it — schema.prisma's PaymentRefundAllocation doc
        // comment caps refund allocations at the allocation's "still-active,
        // non-reversed" amount.
        if (!allocation || allocation.paymentId !== found.id || allocation.isReversed) {
          throw new PaymentError(
            'ALLOCATION_NOT_PERMITTED',
            'The specified allocation does not belong to this payment or is no longer active.',
          );
        }
        const newAllocationRefundTotal = allocation.refundAllocatedTotal.plus(amount);
        if (newAllocationRefundTotal.greaterThan(allocation.amount)) {
          throw new PaymentError(
            'REFUND_EXCEEDS_REMAINING',
            'This refund would exceed the remaining allocated amount for the specified allocation.',
          );
        }
      }

      // D-054 §17 Rule 2: after this refund, the Payment's net active
      // allocation must still not exceed its own net contribution. A refund
      // linked to an allocation lowers both sides by the same amount; an
      // unlinked refund lowers only the net contribution, so it can come
      // only from this Payment's own unallocated credit — never another
      // Payment's. This also guarantees booking-level unapplied credit
      // stays >= 0 and that a fully REFUNDED Payment keeps no net active
      // allocation (schema.prisma's PaymentAllocation doc comment).
      const netActiveAfter = (
        await repository.sumNetActiveAllocationsForPayment(tx, found.id)
      ).minus(input.allocationId ? amount : 0);
      const netContributionAfter = found.amount.minus(newRefundTotal);
      if (netActiveAfter.greaterThan(netContributionAfter)) {
        throw new PaymentError(
          'REFUND_EXCEEDS_REMAINING',
          input.allocationId
            ? "This refund would leave the payment's allocations exceeding what it still contributes."
            : "This refund would exceed this payment's own unallocated credit; link it to the allocation whose installment balance it reopens.",
        );
      }

      const refund = await repository.createRefund(tx, {
        id: randomUUID(),
        paymentId: found.id,
        amount: input.amount,
        reason: input.reason,
        performedByStaffUserId: paymentActor.id,
        idempotencyKey: input.idempotencyKey,
        allocationId: input.allocationId,
      });

      const completesRefund = newRefundTotal.equals(found.amount);
      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.PAYMENT_REFUNDED,
        entityType: PAYMENT_AUDIT_ENTITY_TYPE,
        entityId: found.id,
        beforeState: sanitizePaymentRefundBeforeSnapshot({
          status: found.status,
          refundedTotal: existingRefundTotal.toFixed(2),
        }),
        afterState: sanitizePaymentRefundSnapshot({
          paymentId: found.id,
          amount: input.amount,
          reason: input.reason,
          allocationId: input.allocationId ?? null,
          status: completesRefund ? PaymentStatus.REFUNDED : found.status,
          refundedTotal: newRefundTotal.toFixed(2),
        }),
      });

      let payment: PaymentRecord = found;
      if (completesRefund) {
        payment = await repository.transitionPaymentStatus(tx, {
          paymentId: found.id,
          previousStatus: found.status,
          newStatus: PaymentStatus.REFUNDED,
          changedByUserId: paymentActor.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        });

        await repository.insertAuditLog(tx, {
          actorId: paymentActor.id,
          action: PAYMENT_AUDIT_ACTIONS.PAYMENT_STATUS_CHANGED,
          entityType: PAYMENT_AUDIT_ENTITY_TYPE,
          entityId: payment.id,
          beforeState: sanitizePaymentStatusSnapshot(found.status),
          afterState: sanitizePaymentStatusChangeSnapshot(payment.status, input.reason),
        });
      }

      return { refund, payment };
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (isUniqueViolationOn(error, 'PaymentRefund', ['idempotencyKey'])) {
      const replay = await resolveRefundReplay(prisma, paymentActor, input);
      if (replay) return replay;
    }
    if (isOtherKnownConflict(error)) {
      throw new PaymentError(
        'PAYMENT_CONFLICT',
        'This refund could not be recorded. Please try again.',
      );
    }
    throw error;
  }
}

// --- Receipt issuance (D-054 §§4, 6; D-019) ---

/**
 * The result of `issueReceipt`: the Receipt exactly as issued, plus the
 * Payment's *current* status as a separate field (D-054 §17 Rule 3). A
 * Receipt is an immutable snapshot of the payment at issuance; a caller
 * must read `paymentStatus` to tell a preserved Receipt for a since-
 * REFUNDED or since-REVERSED payment apart from one for a current,
 * unrefunded payment. Nothing is ever written onto the Receipt itself.
 */
export type IssueReceiptResult = { receipt: ReceiptRecord; paymentStatus: PaymentStatus };

/**
 * Issues the official Receipt for a Payment (Finance/Accounting only) —
 * D-054 §17 Rule 3:
 *   - If the Payment already has a Receipt, that same Receipt is returned
 *     unchanged, whatever the Payment's current status (including
 *     REFUNDED or REVERSED). No second Receipt and no second
 *     RECEIPT_ISSUED audit entry is ever written; the original is
 *     preserved exactly as issued.
 *   - Otherwise a new Receipt is issued only while `status` is
 *     `CONFIRMED` (a partially refunded Payment stays CONFIRMED) — never
 *     for REFUNDED, REVERSED, or any pre-confirmation status.
 * Both paths run only after `findPaymentForActor` has confirmed the actor
 * is assigned to the Payment's Booking. `receiptNumber` is server-generated
 * (`randomUUID()`) — D-019 requires only uniqueness, no prefix format is
 * yet approved.
 */
export async function issueReceipt(
  actor: AuthenticatedUser,
  input: IssueReceiptInput,
): Promise<IssueReceiptResult> {
  const paymentActor = assertFinanceActor(actor);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const found = await findScopedPaymentOrForbidden(tx, paymentActor, input.paymentId);

      const existing = await repository.findReceiptByPaymentId(tx, found.id);
      if (existing) {
        return { receipt: existing, paymentStatus: found.status };
      }

      if (found.status !== PaymentStatus.CONFIRMED) {
        throw new PaymentError(
          'RECEIPT_NOT_PERMITTED',
          `A new receipt may only be issued for a CONFIRMED payment (current status: ${found.status}).`,
        );
      }

      const currencyCode = await repository.findBookingCurrencyCode(tx, found.bookingId);
      if (!currencyCode) {
        throw new PaymentError(
          'RECEIPT_NOT_PERMITTED',
          'This booking has no currency set; a receipt cannot be issued.',
        );
      }

      const created = await repository.createReceipt(tx, {
        id: randomUUID(),
        paymentId: found.id,
        receiptNumber: randomUUID(),
        issuedByStaffUserId: paymentActor.id,
        amount: found.amount.toFixed(2),
        currencyCode,
      });

      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.RECEIPT_ISSUED,
        entityType: RECEIPT_AUDIT_ENTITY_TYPE,
        entityId: created.id,
        afterState: sanitizeReceiptSnapshot({
          paymentId: created.paymentId,
          receiptNumber: created.receiptNumber,
          amount: created.amount.toFixed(2),
        }),
      });

      return { receipt: created, paymentStatus: found.status };
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    // A concurrent request issued the Receipt first: return that one,
    // re-checking assignment rather than reading it unscoped.
    if (isUniqueViolationOn(error, 'Receipt', ['paymentId'])) {
      const payment = await findScopedPaymentOrForbidden(prisma, paymentActor, input.paymentId);
      const existing = await repository.findReceiptByPaymentId(prisma, payment.id);
      if (existing) return { receipt: existing, paymentStatus: payment.status };
    }
    if (isOtherKnownConflict(error)) {
      throw new PaymentError(
        'RECEIPT_NOT_PERMITTED',
        'This receipt could not be issued. Please try again.',
      );
    }
    throw error;
  }
}

// --- Allocation and allocation reversal (D-054 §4; D-019) ---

/**
 * Allocates a portion of a Payment's net contribution to a specific
 * Installment (Finance/Accounting only). Enforces both D-019 cross-row
 * invariants: the Payment and Installment must resolve to the same Booking,
 * and the active allocation total for the Payment must never exceed its own
 * net contribution — the latter check alone already excludes allocating
 * against a Payment that is not `CONFIRMED`/`REFUNDED`, since a non-
 * CONFIRMED/REFUNDED Payment's net contribution is always exactly zero
 * (calculations.ts's `computeNetContribution`), and every allocation amount
 * must be positive. Also enforces D-054 §4's decided invariant: the target
 * Installment's PaymentPlan must already be approved. Idempotent by
 * `idempotencyKey` (D-019).
 */
export async function createAllocation(
  actor: AuthenticatedUser,
  input: CreateAllocationInput,
): Promise<AllocationRecord> {
  const paymentActor = assertFinanceActor(actor);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const replay = await resolveAllocationReplay(tx, paymentActor, input);
      if (replay) {
        return replay;
      }

      const payment = await findScopedPaymentOrForbidden(tx, paymentActor, input.paymentId);

      // A missing Installment and one under a different Booking produce the
      // identical error, so this lookup (unscoped by actor) never reveals
      // whether an Installment id exists elsewhere.
      const installment = await repository.findInstallmentForAllocation(tx, input.installmentId);
      if (!installment || installment.bookingId !== payment.bookingId) {
        throw new PaymentError(
          'ALLOCATION_NOT_PERMITTED',
          "The installment does not belong to this payment's booking.",
        );
      }
      if (installment.planApprovedAt === null) {
        throw new PaymentError(
          'ALLOCATION_NOT_PERMITTED',
          'An allocation may only target an installment belonging to an already-approved payment plan.',
        );
      }

      const refundedTotal = await repository.sumRefundsForPayment(tx, payment.id);
      const netContribution = computeNetContribution({
        status: payment.status,
        amount: payment.amount,
        refundedTotal,
      });
      // D-054 §17 Rule 2: net of refunds already linked to this Payment's
      // allocations, not the gross allocated total.
      const existingNetActive = await repository.sumNetActiveAllocationsForPayment(tx, payment.id);
      const amount = new Prisma.Decimal(input.amount);
      if (existingNetActive.plus(amount).greaterThan(netContribution)) {
        throw new PaymentError(
          'ALLOCATION_NOT_PERMITTED',
          "This allocation would exceed the payment's own net contribution.",
        );
      }

      // D-054 §17 Rule 5: the Installment's net active allocation (D-019's
      // formula — reversals, reversed Payments, and linked refunds already
      // excluded) may never exceed its amount. Read inside this SERIALIZABLE
      // transaction, so concurrent allocations to the same Installment are
      // serialized and together can never overfill it. Any excess stays as
      // unapplied credit; nothing is allocated automatically.
      const installmentNetActive = await repository.sumNetActiveAllocationsForInstallment(
        tx,
        installment.id,
      );
      if (installmentNetActive.plus(amount).greaterThan(installment.amount)) {
        throw new PaymentError(
          'ALLOCATION_NOT_PERMITTED',
          "This allocation would exceed the installment's remaining amount.",
        );
      }

      const created = await repository.createAllocation(tx, {
        id: randomUUID(),
        paymentId: input.paymentId,
        installmentId: input.installmentId,
        amount: input.amount,
        allocatedByStaffUserId: paymentActor.id,
        idempotencyKey: input.idempotencyKey,
      });

      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.PAYMENT_ALLOCATION_CREATED,
        entityType: PAYMENT_ALLOCATION_AUDIT_ENTITY_TYPE,
        entityId: created.id,
        afterState: sanitizeAllocationSnapshot({
          paymentId: created.paymentId,
          installmentId: created.installmentId,
          amount: input.amount,
        }),
      });

      return created;
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (isUniqueViolationOn(error, 'PaymentAllocation', ['idempotencyKey'])) {
      const replay = await resolveAllocationReplay(prisma, paymentActor, input);
      if (replay) return replay;
    }
    if (isOtherKnownConflict(error)) {
      throw new PaymentError('ALLOCATION_NOT_PERMITTED', 'This allocation could not be created.');
    }
    throw error;
  }
}

/**
 * Reverses exactly one PaymentAllocation (Finance/Accounting only) — D-019's
 * default service policy, restated precisely by D-054 §13: an allocation
 * that already has any PaymentRefundAllocation row against it must not be
 * reversed, and no override mechanism is defined. At most one reversal per
 * allocation ever (`paymentAllocationId @unique`). Idempotent by
 * `idempotencyKey`.
 */
export async function reverseAllocation(
  actor: AuthenticatedUser,
  input: ReverseAllocationInput,
): Promise<{ id: string; paymentAllocationId: string }> {
  const paymentActor = assertFinanceActor(actor);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const replay = await resolveAllocationReversalReplay(tx, paymentActor, input);
      if (replay) {
        return replay;
      }

      // A missing allocation and one on an unassigned Booking are the same
      // PAYMENT_FORBIDDEN, so an unassigned actor never learns an id exists.
      const allocation = await repository.findAllocationForReversal(tx, input.allocationId);
      if (!allocation) {
        throw new PaymentError('PAYMENT_FORBIDDEN', 'Payment not found or not accessible.');
      }
      await findScopedPaymentOrForbidden(tx, paymentActor, allocation.paymentId);

      if (allocation.hasReversal) {
        throw new PaymentError(
          'ALLOCATION_REVERSAL_NOT_PERMITTED',
          'This allocation has already been reversed.',
        );
      }
      if (allocation.hasRefundAllocation) {
        throw new PaymentError(
          'ALLOCATION_REVERSAL_NOT_PERMITTED',
          'This allocation already has a refund allocated against it and cannot be reversed.',
        );
      }

      const created = await repository.createAllocationReversal(tx, {
        id: randomUUID(),
        paymentAllocationId: allocation.id,
        reversedByStaffUserId: paymentActor.id,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });

      await repository.insertAuditLog(tx, {
        actorId: paymentActor.id,
        action: PAYMENT_AUDIT_ACTIONS.PAYMENT_ALLOCATION_REVERSED,
        entityType: PAYMENT_ALLOCATION_AUDIT_ENTITY_TYPE,
        entityId: allocation.id,
        afterState: { paymentAllocationId: allocation.id, reason: input.reason },
      });

      return created;
    });
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    if (
      isUniqueViolationOn(error, 'PaymentAllocationReversal', ['idempotencyKey']) ||
      isUniqueViolationOn(error, 'PaymentAllocationReversal', ['paymentAllocationId'])
    ) {
      const replay = await resolveAllocationReversalReplay(prisma, paymentActor, input);
      if (replay) return replay;
    }
    if (isOtherKnownConflict(error)) {
      throw new PaymentError(
        'ALLOCATION_REVERSAL_NOT_PERMITTED',
        'This reversal could not be recorded.',
      );
    }
    throw error;
  }
}

// --- Reads: booking payment summary (D-054 §§5, 6, 7) ---

export type InstallmentSummary = {
  id: string;
  dueDate: Date;
  amount: Prisma.Decimal;
  outstandingAmount: Prisma.Decimal;
};

/**
 * One PaymentAllocation as Finance/Accounting needs to see it to act on it
 * (D-054 §6's "view balances, allocations, and full payment history"): the
 * ids `reverseAllocation`/`refundPayment` take, how much of it has already
 * been refunded through it, and whether it has been reversed. Staff-only —
 * the client view never carries these internal record ids.
 */
export type AllocationSummary = {
  id: string;
  paymentId: string;
  amount: Prisma.Decimal;
  refundedAmount: Prisma.Decimal;
  isReversed: boolean;
};

export type StaffInstallmentSummary = InstallmentSummary & { allocations: AllocationSummary[] };

export type PaymentSummaryItem = {
  id: string;
  amount: Prisma.Decimal;
  status: PaymentStatus;
  receipt: { receiptNumber: string; issuedAt: Date } | null;
};

export type BookingPaymentSummary = {
  bookingId: string;
  totalAmount: Prisma.Decimal | null;
  currencyCode: string | null;
  planApproved: boolean;
  confirmedAmountPaid: Prisma.Decimal;
  remainingBalance: Prisma.Decimal | null;
  overpayment: Prisma.Decimal | null;
  unappliedCredit: Prisma.Decimal;
  nextPaymentDue: Date | null;
  installments: InstallmentSummary[];
  payments: PaymentSummaryItem[];
};

export type StaffBookingPaymentSummary = Omit<BookingPaymentSummary, 'installments'> & {
  installments: StaffInstallmentSummary[];
};

/**
 * Composes the full D-019 balance/allocation picture for one Booking from
 * `repository.findBookingPaymentSummaryData`'s raw nested read, using only
 * `calculations.ts`'s pure formula functions — the exact same composition
 * for both the staff-facing summary and the client-facing summary below, so
 * neither ever recomputes anything independently (D-054 §7's "never
 * recomputed independently in the client portal").
 */
function buildBookingPaymentSummary(
  bookingId: string,
  data: BookingPaymentSummaryData,
): StaffBookingPaymentSummary {
  const netConfirmedAmountPaid = computeNetConfirmedAmountPaid(
    data.payments.map((payment) => ({
      status: payment.status,
      amount: payment.amount,
      refundedTotal: payment.refundedTotal,
    })),
  );

  const installmentComputations =
    data.plan?.installments.map((installment) => {
      const netActiveAllocation = computeNetActiveAllocation(installment.allocations);
      return {
        id: installment.id,
        dueDate: installment.dueDate,
        amount: installment.amount,
        netActiveAllocation,
        outstandingAmount: computeOutstandingInstallmentAmount(
          installment.amount,
          netActiveAllocation,
        ),
        allocations: installment.allocations.map((allocation) => ({
          id: allocation.id,
          paymentId: allocation.paymentId,
          amount: allocation.amount,
          refundedAmount: allocation.refundAllocatedTotal,
          isReversed: allocation.isReversed,
        })),
      };
    }) ?? [];

  const netActiveAllocationsByInstallment = installmentComputations.map(
    (installment) => installment.netActiveAllocation,
  );

  const installments: StaffInstallmentSummary[] = installmentComputations.map((installment) => ({
    id: installment.id,
    dueDate: installment.dueDate,
    amount: installment.amount,
    outstandingAmount: installment.outstandingAmount,
    allocations: installment.allocations,
  }));

  return {
    bookingId,
    totalAmount: data.booking.totalAmount,
    currencyCode: data.booking.currencyCode,
    planApproved: data.plan !== null && data.plan.approvedAt !== null,
    confirmedAmountPaid: netConfirmedAmountPaid,
    remainingBalance:
      data.booking.totalAmount !== null
        ? computeRemainingBalance(data.booking.totalAmount, netConfirmedAmountPaid)
        : null,
    overpayment:
      data.booking.totalAmount !== null
        ? computeOverpayment(data.booking.totalAmount, netConfirmedAmountPaid)
        : null,
    unappliedCredit: computeUnappliedCredit(
      netConfirmedAmountPaid,
      netActiveAllocationsByInstallment,
    ),
    nextPaymentDue: computeNextPaymentDue(
      installments.map((installment) => ({
        dueDate: installment.dueDate,
        outstandingAmount: installment.outstandingAmount,
      })),
    ),
    installments,
    payments: data.payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      status: payment.status,
      receipt: payment.receipt,
    })),
  };
}

/**
 * The staff-facing payment summary for one Booking (D-054 §6): balances,
 * allocations, and full payment history, scoped to what `actor` may see —
 * ADMIN_MANAGER unconditionally, TRAVEL_CONSULTANT/FINANCE_ACCOUNTING only
 * for a Booking they are assigned to. A read-only function: no transaction,
 * no write, no audit entry.
 */
export async function getBookingPaymentSummaryForStaff(
  actor: AuthenticatedUser,
  bookingId: string,
): Promise<StaffBookingPaymentSummary> {
  const paymentActor = assertStaffReadActor(actor);

  const booking = await repository.findBookingFinancialsForActor(prisma, paymentActor, bookingId);
  if (!booking) {
    throw paymentActor.role === 'ADMIN_MANAGER'
      ? new PaymentError('BOOKING_NOT_FOUND', 'Booking not found.')
      : new PaymentError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.');
  }

  const data = await repository.findBookingPaymentSummaryData(prisma, bookingId);
  if (!data) {
    throw new PaymentError('BOOKING_NOT_FOUND', 'Booking not found.');
  }

  return buildBookingPaymentSummary(bookingId, data);
}

/**
 * The read-only, ownership-scoped client Payments & Receipts view (D-054
 * §7): one summary per Booking that has an *approved* PaymentPlan, for the
 * authenticated client's own Bookings only — an unapproved, proposed-only
 * plan never appears here. `canAccessClient` (features/assignments/authorization.ts)
 * runs before any Payments repository read, exactly mirroring
 * features/bookings/service.ts's `assertClientPortalAccess` pattern.
 */
export async function getClientPaymentSummaries(
  actor: AuthenticatedUser,
  clientId: string,
): Promise<BookingPaymentSummary[]> {
  assertClientActor(actor);

  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) {
    throw new PaymentError('BOOKING_FORBIDDEN', 'Payments for this client are not accessible.');
  }

  const bookingIds = await repository.findApprovedBookingIdsForClient(prisma, clientId);

  const summaries: BookingPaymentSummary[] = [];
  for (const bookingId of bookingIds) {
    const data = await repository.findBookingPaymentSummaryData(prisma, bookingId);
    if (data) {
      const { installments, ...summary } = buildBookingPaymentSummary(bookingId, data);
      summaries.push({
        ...summary,
        installments: installments.map((installment) => ({
          id: installment.id,
          dueDate: installment.dueDate,
          amount: installment.amount,
          outstandingAmount: installment.outstandingAmount,
        })),
      });
    }
  }
  return summaries;
}
