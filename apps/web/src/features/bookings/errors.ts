export type BookingErrorCode =
  | 'ROLE_NOT_PERMITTED'
  | 'PROPOSAL_VERSION_NOT_FOUND'
  | 'PROPOSAL_VERSION_FORBIDDEN'
  | 'PROPOSAL_VERSION_NOT_ACCEPTED'
  | 'BOOKING_NOT_FOUND'
  | 'BOOKING_FORBIDDEN'
  | 'BOOKING_CONFLICT';

const STATUS_BY_CODE: Record<BookingErrorCode, 403 | 404 | 409> = {
  ROLE_NOT_PERMITTED: 403,
  PROPOSAL_VERSION_NOT_FOUND: 404,
  PROPOSAL_VERSION_FORBIDDEN: 403,
  PROPOSAL_VERSION_NOT_ACCEPTED: 409,
  BOOKING_NOT_FOUND: 404,
  BOOKING_FORBIDDEN: 403,
  BOOKING_CONFLICT: 409,
};

/**
 * A domain error raised by the booking service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"), mirroring
 * features/assignments/errors.ts's AssignmentError and
 * features/staff/errors.ts's StaffManagementError. Route handlers translate
 * this into the project's standard `{ error: { code, message } }` envelope
 * (see features/bookings/http.ts) instead of letting it fall through to
 * withRole's generic 500 handler.
 *
 * Unlike AssignmentError/StaffManagementError, this class *does* carry a
 * 403 status for two codes (PROPOSAL_VERSION_FORBIDDEN, BOOKING_FORBIDDEN).
 * That is not a coarse role-based 403 — those are still decided entirely by
 * withRole before a route handler ever calls into this feature's service
 * layer, exactly as documented on the other two error classes. It is a
 * fine-grained, per-resource authorization outcome, the same class of
 * decision features/assignments/authorization.ts's `canAccessLead`/
 * `canAccessClient` already make (returning a plain 403 result rather than
 * throwing), applied here for an ADMIN_MANAGER-vs-TRAVEL_CONSULTANT split:
 * for an ADMIN_MANAGER (unconditional access), a missing ProposalVersion or
 * Booking is unambiguously NOT_FOUND (404); for a TRAVEL_CONSULTANT (access
 * conditional on an active Client assignment), "does not exist" and "exists
 * but not assigned to this actor" are indistinguishable from the caller's
 * point of view and must both produce the identical FORBIDDEN (403) —
 * never a 404 — so an unassigned Travel Consultant can never learn whether
 * a given id exists (the same resource-existence-leak protection
 * `canAccessLead`/`canAccessClient`'s doc comment describes).
 *
 * `ROLE_NOT_PERMITTED` is different again: it is the service layer's own
 * defense-in-depth check (service.ts's `assertBookingActor`), independent
 * of and in addition to `withRole`'s route-level role gate — see that
 * function's doc comment for why both checks exist.
 */
export class BookingError extends Error {
  readonly status: 403 | 404 | 409;
  readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode, message: string) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
