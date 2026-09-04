// The two controlled outcomes the Client Home / Overview composition can
// produce (docs/HERITAGE_V3_DECISIONS_LOG.md D-040 §§2, 3, 7). This feature
// is composition-only — it owns no database table, opens no transaction,
// and never authors an AuditLog row — so its error surface is deliberately
// tiny, mirroring the code/status/class contract every other feature's
// errors.ts already establishes (features/clients/errors.ts's `ClientError`,
// features/proposals/errors.ts's `ProposalError`, etc.), never importing
// another feature's error type.
//
// - `FORBIDDEN` (403): the authenticated user is not a CLIENT. Decided in
//   `getClientOverview` before any owned-client resolution or feature read
//   (D-040 §2 layer 3). `client/layout.tsx` (D-040 §7) handles this as a
//   rendered "Client area" panel, so it is never thrown to the route error
//   boundary — the status is carried only for a future route handler.
// - `PROFILE_NOT_SET_UP` (403): the user is a CLIENT but has no
//   `ClientProfile` linking them to a `Client` yet (Contract A resolved
//   `null` — D-040 §2 layer 2, §7 "No profile"). Also handled as a rendered
//   panel, never surfaced to the error boundary. It never reveals whether a
//   `ClientProfile` row is genuinely absent as opposed to anything else —
//   the message is calm and generic.
export type ClientPortalErrorCode = 'FORBIDDEN' | 'PROFILE_NOT_SET_UP';

const STATUS_BY_CODE: Record<ClientPortalErrorCode, 403> = {
  FORBIDDEN: 403,
  PROFILE_NOT_SET_UP: 403,
};

/**
 * A domain error raised by the client-portal overview composition
 * (.claude/rules/backend.md's "Service-Level Business Rules"), mirroring
 * every other feature's own domain-error class exactly. A later route
 * handler (Stage 6c is UI-only; a portal API surface is a separate later
 * slice) would translate this into the project's standard
 * `{ error: { code, message } }` envelope; today `client/layout.tsx`
 * inspects `code` directly to pick the correct rendered state.
 */
export class ClientPortalError extends Error {
  readonly status: 403;
  readonly code: ClientPortalErrorCode;

  constructor(code: ClientPortalErrorCode, message: string) {
    super(message);
    this.name = 'ClientPortalError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
