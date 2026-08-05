// Approved D-027 §6 error-code-to-status mapping — the "full
// controlled-error-code-to-status map" D-027 §6 defines verbatim for every
// Proposal / ROS endpoint this checkpoint authorizes. `CLIENT_NOT_FOUND`/
// `CLIENT_FORBIDDEN` are this feature's own codes (not an import of
// features/clients/errors.ts's `ClientError`), produced when a Proposal
// operation's target Client cannot be resolved via the reused, unchanged
// `canAccessClient` (D-027 §3) — mirroring how every other feature in this
// codebase (features/bookings/errors.ts's `PROPOSAL_VERSION_NOT_FOUND`/
// `PROPOSAL_VERSION_FORBIDDEN`, features/assignments/errors.ts's
// `LEAD_NOT_FOUND`/`CLIENT_NOT_FOUND`/`BOOKING_NOT_FOUND`) defines its own
// complete error-code union rather than importing another feature's error
// type, even where the underlying meaning overlaps.
//
// This file defines the code/status/class contract only. It does not
// decide *when* each code is thrown or in what order competing checks run
// (D-027 §5's publish ordering, D-027 §7's response-recording ordering) —
// that lookup/ordering logic belongs to the service layer, a later stage of
// this checkpoint.
export type ProposalErrorCode =
  | 'VALIDATION_ERROR'
  | 'ROLE_NOT_PERMITTED'
  | 'CLIENT_NOT_FOUND'
  | 'CLIENT_FORBIDDEN'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_FORBIDDEN'
  | 'PROPOSAL_VERSION_NOT_FOUND'
  | 'PROPOSAL_VERSION_FORBIDDEN'
  | 'PROPOSAL_VERSION_SUPERSEDED'
  | 'PROPOSAL_VERSION_NOT_CURRENT'
  | 'PROPOSAL_RESPONSE_ALREADY_RECORDED'
  | 'PROPOSAL_CONFLICT';

const STATUS_BY_CODE: Record<ProposalErrorCode, 400 | 403 | 404 | 409> = {
  VALIDATION_ERROR: 400,
  ROLE_NOT_PERMITTED: 403,
  CLIENT_NOT_FOUND: 404,
  CLIENT_FORBIDDEN: 403,
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_FORBIDDEN: 403,
  PROPOSAL_VERSION_NOT_FOUND: 404,
  PROPOSAL_VERSION_FORBIDDEN: 403,
  PROPOSAL_VERSION_SUPERSEDED: 409,
  PROPOSAL_VERSION_NOT_CURRENT: 409,
  PROPOSAL_RESPONSE_ALREADY_RECORDED: 409,
  PROPOSAL_CONFLICT: 409,
};

/**
 * A domain error raised by the Proposal / ROS service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"), mirroring
 * features/bookings/errors.ts's `BookingError`, features/clients/errors.ts's
 * `ClientError`, and features/leads/errors.ts's `LeadError` exactly. A later
 * route-handler stage translates this into the project's standard
 * `{ error: { code, message } }` envelope instead of letting it fall
 * through to `withRole`'s generic 500 handler.
 *
 * `PROPOSAL_NOT_FOUND`/`PROPOSAL_FORBIDDEN` and
 * `PROPOSAL_VERSION_NOT_FOUND`/`PROPOSAL_VERSION_FORBIDDEN` each follow the
 * same ADMIN_MANAGER-vs-TRAVEL_CONSULTANT anti-enumeration split this
 * codebase already establishes (`BookingError`, `ClientError`, `LeadError`):
 * for `ADMIN_MANAGER` (unconditional read access, D-027 §3), a missing
 * Proposal/ProposalVersion is unambiguously `..._NOT_FOUND` (404); for
 * `TRAVEL_CONSULTANT` (access conditional on an active Client assignment),
 * "does not exist" and "exists but not assigned to this actor" are
 * indistinguishable and must both produce the identical `..._FORBIDDEN`
 * (403) — D-027 §5 fixes this literally for the Travel-Consultant-only
 * publish route specifically.
 *
 * `ROLE_NOT_PERMITTED` is the service layer's own defense-in-depth check (a
 * later stage's `assertProposalAuthorAccess`/actor guard), independent of
 * and in addition to `withRole`'s route-level role gate (D-027 §3).
 *
 * `PROPOSAL_CONFLICT` covers both the publish endpoint's stale
 * `expectedCurrentVersionId` case and any residual database/serialization
 * conflict (D-027 §5), mirroring `BookingError`'s identical
 * `BOOKING_CONFLICT` dual role.
 */
export class ProposalError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: ProposalErrorCode;

  constructor(code: ProposalErrorCode, message: string) {
    super(message);
    this.name = 'ProposalError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
