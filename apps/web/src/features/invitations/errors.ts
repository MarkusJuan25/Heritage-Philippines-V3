export type InvitationErrorCode =
  | 'CLIENT_NOT_FOUND'
  | 'CLIENT_FORBIDDEN'
  | 'CLIENT_EMAIL_MISSING'
  | 'INVITATION_NOT_FOUND'
  | 'INVITATION_ALREADY_EXISTS'
  | 'INVITATION_NOT_SENDABLE'
  | 'INVITATION_ALREADY_ACTIVATED'
  | 'DELIVERY_DISABLED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVITATION_SEND_OPERATION_STALE';

const STATUS_BY_CODE: Record<InvitationErrorCode, 400 | 403 | 404 | 409> = {
  CLIENT_NOT_FOUND: 404,
  CLIENT_FORBIDDEN: 403,
  CLIENT_EMAIL_MISSING: 409,
  INVITATION_NOT_FOUND: 404,
  INVITATION_ALREADY_EXISTS: 409,
  INVITATION_NOT_SENDABLE: 409,
  INVITATION_ALREADY_ACTIVATED: 409,
  DELIVERY_DISABLED: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  // Optimistic-concurrency precondition failure (Stage 3 Correction Pass
  // 1 §3): the caller's `expectedCurrentSendOperationId`/`expectedUpdatedAt`
  // no longer matches the invitation's actual current values — a newer
  // resend/reissue has already superseded the state this request was
  // computed against. A stable 409, never a silent mutation.
  INVITATION_SEND_OPERATION_STALE: 409,
};

/**
 * A domain error raised by the invitation service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"). Route
 * handlers translate this into the project's standard
 * `{ error: { code, message } }` envelope (see features/invitations/http.ts)
 * instead of letting it fall through to withRole's generic 500 handler —
 * these are expected, named business-rule outcomes, not unexpected
 * failures. Mirrors features/staff/errors.ts and features/clients/errors.ts.
 */
export class InvitationError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: InvitationErrorCode;

  constructor(code: InvitationErrorCode, message: string) {
    super(message);
    this.name = 'InvitationError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
