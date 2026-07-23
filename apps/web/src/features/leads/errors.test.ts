import { describe, expect, it } from 'vitest';

import { LeadError, type LeadErrorCode } from './errors';

const EXPECTED_STATUS: Record<LeadErrorCode, number> = {
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

describe('LeadError', () => {
  for (const [code, status] of Object.entries(EXPECTED_STATUS) as [LeadErrorCode, number][]) {
    it(`maps ${code} to status ${status}`, () => {
      const error = new LeadError(code, 'message');
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.name).toBe('LeadError');
      expect(error).toBeInstanceOf(Error);
    });
  }

  it('carries the supplied message', () => {
    const error = new LeadError('LEAD_CONFLICT', 'Refresh and try again.');
    expect(error.message).toBe('Refresh and try again.');
  });
});
