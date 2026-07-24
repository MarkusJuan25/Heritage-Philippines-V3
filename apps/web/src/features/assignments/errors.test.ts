import { describe, expect, it } from 'vitest';

import { AssignmentError, type AssignmentErrorCode } from './errors';

// Mirrors features/leads/errors.test.ts's LeadError test exactly — this
// feature previously had no direct errors.test.ts, exercising every code
// only indirectly through service.test.ts's `.rejects.toMatchObject`
// assertions. D-023 §6's new ROLE_NOT_PERMITTED code (the eligible-
// Travel-Consultant read's own service-layer defense-in-depth check)
// is the first 403 this class produces, so it is worth proving
// exhaustively alongside every pre-existing code.
const EXPECTED_STATUS: Record<AssignmentErrorCode, number> = {
  ROLE_NOT_PERMITTED: 403,
  LEAD_NOT_FOUND: 404,
  CLIENT_NOT_FOUND: 404,
  BOOKING_NOT_FOUND: 404,
  ASSIGNEE_NOT_FOUND: 404,
  ASSIGNEE_INACTIVE: 409,
  ASSIGNEE_INELIGIBLE_ROLE: 409,
  REASON_REQUIRED: 409,
  ASSIGNMENT_CONFLICT: 409,
};

describe('AssignmentError', () => {
  for (const [code, status] of Object.entries(EXPECTED_STATUS) as [AssignmentErrorCode, number][]) {
    it(`maps ${code} to status ${status}`, () => {
      const error = new AssignmentError(code, 'message');
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.name).toBe('AssignmentError');
      expect(error).toBeInstanceOf(Error);
    });
  }

  it('carries the supplied message', () => {
    const error = new AssignmentError('ROLE_NOT_PERMITTED', 'Not permitted.');
    expect(error.message).toBe('Not permitted.');
  });
});
