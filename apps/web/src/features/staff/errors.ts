export type StaffManagementErrorCode =
  | 'EMAIL_ALREADY_EXISTS'
  | 'STAFF_ACCOUNT_NOT_FOUND'
  | 'SELF_ACTION_FORBIDDEN'
  | 'LAST_ADMINISTRATOR_PROTECTED';

const STATUS_BY_CODE: Record<StaffManagementErrorCode, 403 | 404 | 409> = {
  EMAIL_ALREADY_EXISTS: 409,
  STAFF_ACCOUNT_NOT_FOUND: 404,
  SELF_ACTION_FORBIDDEN: 403,
  LAST_ADMINISTRATOR_PROTECTED: 409,
};

/**
 * A domain error raised by the staff-management service layer
 * (.claude/rules/backend.md's "Service-Level Business Rules"). Route
 * handlers translate this into the project's standard
 * `{ error: { code, message } }` envelope (see features/staff/http.ts)
 * instead of letting it fall through to withRole's generic 500 handler —
 * these are expected, named business-rule outcomes, not unexpected
 * failures.
 */
export class StaffManagementError extends Error {
  readonly status: 403 | 404 | 409;
  readonly code: StaffManagementErrorCode;

  constructor(code: StaffManagementErrorCode, message: string) {
    super(message);
    this.name = 'StaffManagementError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
