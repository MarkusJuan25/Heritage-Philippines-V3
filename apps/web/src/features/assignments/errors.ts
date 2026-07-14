export type AssignmentErrorCode =
  | 'LEAD_NOT_FOUND'
  | 'CLIENT_NOT_FOUND'
  | 'ASSIGNEE_NOT_FOUND'
  | 'ASSIGNEE_INACTIVE'
  | 'ASSIGNEE_INELIGIBLE_ROLE'
  | 'REASON_REQUIRED'
  | 'ASSIGNMENT_CONFLICT';

const STATUS_BY_CODE: Record<AssignmentErrorCode, 404 | 409> = {
  LEAD_NOT_FOUND: 404,
  CLIENT_NOT_FOUND: 404,
  ASSIGNEE_NOT_FOUND: 404,
  ASSIGNEE_INACTIVE: 409,
  ASSIGNEE_INELIGIBLE_ROLE: 409,
  REASON_REQUIRED: 409,
  ASSIGNMENT_CONFLICT: 409,
};

/**
 * A domain error raised by the assignment-management service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"), mirroring
 * features/staff/errors.ts's StaffManagementError. Route handlers translate
 * this into the project's standard `{ error: { code, message } }` envelope
 * (see features/assignments/http.ts) instead of letting it fall through to
 * withRole's generic 500 handler — these are expected, named business-rule
 * outcomes, not unexpected failures. Authentication (401) and role-based
 * forbidden (403) outcomes are never represented here — those are decided
 * entirely by withRole/authorize.ts before a route handler ever calls into
 * this feature's service layer.
 */
export class AssignmentError extends Error {
  readonly status: 404 | 409;
  readonly code: AssignmentErrorCode;

  constructor(code: AssignmentErrorCode, message: string) {
    super(message);
    this.name = 'AssignmentError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
