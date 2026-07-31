// Approved D-025 §9 error-code-to-status mapping. `VALIDATION_ERROR` is
// included here (in addition to any schema-boundary `VALIDATION_ERROR`) for
// the one server-state-dependent validation failure that cannot be
// expressed as a pure request-shape check: the PATCH combined email/phone
// retention invariant (service.ts's `updateClient` — "a client must retain
// at least one of email or phone" evaluated against the patch *combined*
// with the existing record, which schemas.ts cannot see — D-025 §11).
// Every code mirrors an identical existing code+status pair already defined
// in features/leads/errors.ts's `LeadError` (`VALIDATION_ERROR`,
// `ROLE_NOT_PERMITTED`) or is this feature's own D-025-authorized addition
// (`CLIENT_FORBIDDEN`, `CLIENT_NOT_FOUND`, `CLIENT_CONFLICT`).
export type ClientErrorCode =
  | 'VALIDATION_ERROR'
  | 'ROLE_NOT_PERMITTED'
  | 'CLIENT_FORBIDDEN'
  | 'CLIENT_NOT_FOUND'
  | 'CLIENT_CONFLICT';

const STATUS_BY_CODE: Record<ClientErrorCode, 400 | 403 | 404 | 409> = {
  VALIDATION_ERROR: 400,
  ROLE_NOT_PERMITTED: 403,
  CLIENT_FORBIDDEN: 403,
  CLIENT_NOT_FOUND: 404,
  CLIENT_CONFLICT: 409,
};

/**
 * A domain error raised by the Client-management service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"), mirroring
 * features/leads/errors.ts's `LeadError` exactly. Route handlers (a later
 * stage) translate this into the project's standard
 * `{ error: { code, message } }` envelope instead of letting it fall
 * through to a generic 500 handler.
 *
 * `CLIENT_NOT_FOUND` vs. `CLIENT_FORBIDDEN` follows the exact
 * ADMIN_MANAGER-vs-TRAVEL_CONSULTANT anti-enumeration split `LeadError`
 * already documents (D-025 §7/§9): for `ADMIN_MANAGER` (unconditional
 * access), a missing Client is unambiguously `CLIENT_NOT_FOUND` (404); for
 * `TRAVEL_CONSULTANT` (access conditional on an active assignment), "does
 * not exist" and "exists but not assigned to this actor" are
 * indistinguishable and must both produce the identical `CLIENT_FORBIDDEN`
 * (403).
 *
 * `ROLE_NOT_PERMITTED` is the service layer's own defense-in-depth check
 * (service.ts's `assertClientActor`) — no route guard exists yet for this
 * feature, so this is the sole authorization boundary today.
 */
export class ClientError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: ClientErrorCode;

  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
