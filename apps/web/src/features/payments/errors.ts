export type PaymentErrorCode =
  | 'ROLE_NOT_PERMITTED'
  | 'BOOKING_NOT_FOUND'
  | 'BOOKING_FORBIDDEN'
  | 'PAYMENT_PLAN_NOT_FOUND'
  | 'PAYMENT_PLAN_FORBIDDEN'
  | 'PAYMENT_PLAN_CONFLICT'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_FORBIDDEN'
  | 'INVALID_PAYMENT_TRANSITION'
  | 'PAYMENT_CONFLICT'
  | 'ALLOCATION_NOT_PERMITTED'
  | 'ALLOCATION_REVERSAL_NOT_PERMITTED'
  | 'REFUND_EXCEEDS_REMAINING'
  | 'RECEIPT_NOT_PERMITTED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'BOOKING_CURRENCY_NOT_SET';

const STATUS_BY_CODE: Record<PaymentErrorCode, 403 | 404 | 409> = {
  ROLE_NOT_PERMITTED: 403,
  BOOKING_NOT_FOUND: 404,
  BOOKING_FORBIDDEN: 403,
  PAYMENT_PLAN_NOT_FOUND: 404,
  PAYMENT_PLAN_FORBIDDEN: 403,
  PAYMENT_PLAN_CONFLICT: 409,
  PAYMENT_NOT_FOUND: 404,
  PAYMENT_FORBIDDEN: 403,
  INVALID_PAYMENT_TRANSITION: 409,
  PAYMENT_CONFLICT: 409,
  ALLOCATION_NOT_PERMITTED: 409,
  ALLOCATION_REVERSAL_NOT_PERMITTED: 409,
  REFUND_EXCEEDS_REMAINING: 409,
  RECEIPT_NOT_PERMITTED: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  BOOKING_CURRENCY_NOT_SET: 409,
};

/**
 * A domain error raised by the Payments service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"), mirroring
 * features/bookings/errors.ts's BookingError exactly — same shape, same
 * translation responsibility (a future route layer maps this to the
 * project's standard `{ error: { code, message } }` envelope; not built in
 * this Stage 2, D-054 §10).
 *
 * `BOOKING_NOT_FOUND`/`BOOKING_FORBIDDEN` and `PAYMENT_PLAN_NOT_FOUND`/
 * `PAYMENT_PLAN_FORBIDDEN` and `PAYMENT_NOT_FOUND`/`PAYMENT_FORBIDDEN` each
 * follow the identical ADMIN_MANAGER-vs-scoped-role split BookingError's own
 * doc comment describes: for ADMIN_MANAGER (unconditional visibility, D-054
 * §3), a missing record is unambiguously NOT_FOUND (404); for a
 * TRAVEL_CONSULTANT or FINANCE_ACCOUNTING actor (access conditional on an
 * active booking-level StaffAssignment — see repository.ts's
 * `bookingAssignmentFilter`), "does not exist" and "exists but not assigned
 * to this actor" are indistinguishable from the caller's point of view and
 * must both produce the identical FORBIDDEN (403) — never a 404 — so an
 * unassigned actor can never learn whether a given id exists.
 *
 * `ROLE_NOT_PERMITTED` is the service layer's own defense-in-depth check
 * (service.ts's `assertPaymentPlanActor`/`assertPaymentActor`), independent
 * of and in addition to a future route-level role gate — see
 * `assertBookingActor`'s doc comment in features/bookings/service.ts for why
 * both checks exist.
 *
 * `PAYMENT_PLAN_CONFLICT`/`PAYMENT_CONFLICT` cover both a genuine residual
 * database conflict (exhausted write-conflict retries, or an unmatched
 * P2002) and a business-rule conflict this entry defines (a PaymentPlan that
 * already exists for a Booking, one that is already approved, one whose
 * installments do not yet sum to Booking.totalAmount, one whose installment
 * structure breaks D-019's sequence/deposit rules, or a Booking whose
 * totalAmount/currencyCode are not yet both set — D-019's reconciliation and
 * financials-pairing invariants). A CHECK-constraint violation is never
 * mapped to any of these codes: it stays an unknown error (D-055). `INVALID_PAYMENT_TRANSITION` covers every
 * D-054 §4 terminal-state or mutual-exclusion violation: reversing a Payment
 * that already has a refund, refunding or reversing a Payment that has
 * already reached any terminal status (REJECTED, CANCELLED, FAILED,
 * REVERSED, fully REFUNDED), or confirming a Payment that is not currently
 * PENDING. No operation moves a Payment to REJECTED, CANCELLED, or FAILED
 * yet (D-054 §17 Rule 1 defers them). `ALLOCATION_NOT_PERMITTED` covers
 * both D-019 cross-row invariants this entry enforces: an Installment whose
 * PaymentPlan is not yet approved (D-054 §4's decided invariant), and an
 * allocation total that would exceed the Payment's own net contribution.
 * `ALLOCATION_REVERSAL_NOT_PERMITTED` is D-019's own default service policy:
 * an allocation that already has a PaymentRefundAllocation row against it
 * must not be reversed (D-054 §13's corrected wording — no override
 * mechanism is defined). `REFUND_EXCEEDS_REMAINING` is D-019's cumulative-
 * refund cap (never exceed the Payment's own amount). `RECEIPT_NOT_PERMITTED`
 * covers issuing a *new* receipt for a Payment that is not currently
 * CONFIRMED (D-054 §17 Rule 3); a Payment that already has a Receipt gets
 * that Receipt back instead, whatever its status.
 * `BOOKING_CURRENCY_NOT_SET` rejects recording a Payment against a Booking
 * whose `currencyCode` is not yet set (D-054 §17 Rule 4): such a Payment
 * could never receive a Receipt.
 * `IDEMPOTENCY_KEY_CONFLICT` is a caller-supplied idempotency key that the
 * same kind of operation already used for a *different* request — another
 * Payment, another target status, another allocation, or a different
 * amount. A retry is only ever answered with its own prior result
 * (.claude/rules/backend.md's "Idempotency for Sensitive Operations"; D-054
 * §8), never with the unrelated record the key already names. Keys are
 * checked per operation (D-054 §8's per-operation retry guarantee): a key
 * used by one kind of operation is not generally detected when reused by
 * another kind. The exceptions share PaymentStatusHistory's key column:
 * recordPayment (D-054 §17 Rule 6), confirmPayment, and reversePayment each
 * reject the others' keys, and refundPayment also rejects a key already held
 * by a status change, because a refund that completes a Payment writes its
 * own key there too.
 */
export class PaymentError extends Error {
  readonly status: 403 | 404 | 409;
  readonly code: PaymentErrorCode;

  constructor(code: PaymentErrorCode, message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
