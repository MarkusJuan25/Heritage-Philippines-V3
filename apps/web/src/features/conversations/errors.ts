// The three controlled outcomes the conversations feature's authorization
// and validation model can produce (docs/HERITAGE_V3_DECISIONS_LOG.md
// D-051 §§3, 5, 6, 7, 15, 16). Mirrors every other feature's own
// code/status/class contract exactly (features/bookings/errors.ts's
// `BookingError`, features/proposals/errors.ts's `ProposalError`), never
// importing another feature's error type.
//
// - `ROLE_NOT_PERMITTED` (403): the authenticated actor's role can never
//   perform the attempted operation at all — e.g. a CLIENT calling a
//   staff-only function, or a FINANCE_ACCOUNTING/VISA_DOCUMENTATION actor
//   attempting to create a Conversation (D-051 §3 restricts creation to
//   CLIENT/ADMIN_MANAGER/TRAVEL_CONSULTANT only).
// - `CONVERSATION_FORBIDDEN` (403): the single, identical, non-enumerating
//   outcome D-051 §15 requires for every ownership/authorization denial —
//   a CLIENT accessing a Conversation they do not own, an unassigned
//   TRAVEL_CONSULTANT, a FINANCE_ACCOUNTING/VISA_DOCUMENTATION actor with
//   no active `ConversationParticipant` row, and a reply targeting a
//   nonexistent or malformed `conversationId` all produce this exact same
//   code — never distinguished from one another (D-051 §15).
// - `VALIDATION_ERROR` (400): a `category`, `body`, or `visibility` value
//   that fails its own schema (features/conversations/schemas.ts).
export type ConversationErrorCode =
  'ROLE_NOT_PERMITTED' | 'CONVERSATION_FORBIDDEN' | 'VALIDATION_ERROR';

const STATUS_BY_CODE: Record<ConversationErrorCode, 400 | 403> = {
  ROLE_NOT_PERMITTED: 403,
  CONVERSATION_FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
};

/**
 * A domain error raised by the conversations service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"), mirroring
 * `BookingError`/`ProposalError`/`ClientPortalError` exactly.
 */
export class ConversationError extends Error {
  readonly status: 400 | 403;
  readonly code: ConversationErrorCode;

  constructor(code: ConversationErrorCode, message: string) {
    super(message);
    this.name = 'ConversationError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
