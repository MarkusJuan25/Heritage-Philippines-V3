// Approved D-022/Stage B2 error-code-to-status mapping. `VALIDATION_ERROR`
// is included here (in addition to the schema-boundary VALIDATION_ERROR
// produced by http.ts's own `validationErrorResponse`) for the one
// server-state-dependent validation failure that cannot be expressed as a
// pure request-shape check: the PATCH final-contact-state invariant
// (service.ts's `updateLead` — "a lead must retain at least one of email or
// phone" evaluated against the patch *combined* with the existing record,
// which schemas.ts cannot see). Every other code mirrors an identical
// existing code+status pair already defined in
// features/bookings/errors.ts's BookingError or
// features/assignments/errors.ts's AssignmentError.
export type LeadErrorCode =
  | 'VALIDATION_ERROR'
  | 'ROLE_NOT_PERMITTED'
  | 'LEAD_NOT_FOUND'
  | 'LEAD_FORBIDDEN'
  | 'LEAD_LOCKED'
  | 'REASON_REQUIRED'
  | 'INVALID_STATUS_TRANSITION'
  | 'CONVERSION_ENDPOINT_REQUIRED'
  | 'LEAD_CONFLICT';

const STATUS_BY_CODE: Record<LeadErrorCode, 400 | 403 | 404 | 409> = {
  VALIDATION_ERROR: 400,
  ROLE_NOT_PERMITTED: 403,
  LEAD_NOT_FOUND: 404,
  LEAD_FORBIDDEN: 403,
  LEAD_LOCKED: 409,
  REASON_REQUIRED: 409,
  INVALID_STATUS_TRANSITION: 409,
  CONVERSION_ENDPOINT_REQUIRED: 409,
  LEAD_CONFLICT: 409,
};

/**
 * A domain error raised by the Lead-management service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"), mirroring
 * features/bookings/errors.ts's BookingError and
 * features/assignments/errors.ts's AssignmentError. Route handlers
 * translate this into the project's standard `{ error: { code, message } }`
 * envelope (see features/leads/http.ts) instead of letting it fall through
 * to withRole's generic 500 handler.
 *
 * `LEAD_NOT_FOUND` vs. `LEAD_FORBIDDEN` follows the exact
 * ADMIN_MANAGER-vs-TRAVEL_CONSULTANT anti-enumeration split
 * BookingError documents: for ADMIN_MANAGER (unconditional access), a
 * missing Lead is unambiguously NOT_FOUND (404); for TRAVEL_CONSULTANT
 * (access conditional on an active assignment), "does not exist" and
 * "exists but not assigned to this actor" are indistinguishable and must
 * both produce the identical LEAD_FORBIDDEN (403) — D-022 §8 fixes this
 * status literally.
 *
 * `ROLE_NOT_PERMITTED` is the service layer's own defense-in-depth check
 * (service.ts's `assertLeadActor`), independent of and in addition to
 * `withRole`'s route-level role gate.
 */
export class LeadError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: LeadErrorCode;

  constructor(code: LeadErrorCode, message: string) {
    super(message);
    this.name = 'LeadError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
