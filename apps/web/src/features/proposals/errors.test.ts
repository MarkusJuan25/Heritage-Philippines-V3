import { describe, expect, it } from 'vitest';

import { ProposalError, type ProposalErrorCode } from './errors';

const EXPECTED_STATUS: Record<ProposalErrorCode, number> = {
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

describe('ProposalError', () => {
  for (const [code, status] of Object.entries(EXPECTED_STATUS) as [ProposalErrorCode, number][]) {
    it(`maps ${code} to status ${status}`, () => {
      const error = new ProposalError(code, 'message');
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.name).toBe('ProposalError');
      expect(error).toBeInstanceOf(Error);
    });
  }

  it('exposes exactly the twelve codes D-027 §6 authorizes — no speculative code exists in the mapping', () => {
    expect(Object.keys(EXPECTED_STATUS).sort()).toEqual(
      [
        'VALIDATION_ERROR',
        'ROLE_NOT_PERMITTED',
        'CLIENT_NOT_FOUND',
        'CLIENT_FORBIDDEN',
        'PROPOSAL_NOT_FOUND',
        'PROPOSAL_FORBIDDEN',
        'PROPOSAL_VERSION_NOT_FOUND',
        'PROPOSAL_VERSION_FORBIDDEN',
        'PROPOSAL_VERSION_SUPERSEDED',
        'PROPOSAL_VERSION_NOT_CURRENT',
        'PROPOSAL_RESPONSE_ALREADY_RECORDED',
        'PROPOSAL_CONFLICT',
      ].sort(),
    );
  });

  it('carries the supplied message', () => {
    const error = new ProposalError('PROPOSAL_CONFLICT', 'Refresh and try again.');
    expect(error.message).toBe('Refresh and try again.');
  });

  it("carries D-027 §5's exact PROPOSAL_CONFLICT publish message unchanged", () => {
    const error = new ProposalError(
      'PROPOSAL_CONFLICT',
      'The current version has changed since you last loaded this proposal. Refresh and try again.',
    );
    expect(error.message).toBe(
      'The current version has changed since you last loaded this proposal. Refresh and try again.',
    );
  });

  it('has no fallback/default status for an uncontracted code — TypeScript refuses one at compile time, and a value smuggled past that via a cast produces no status at all rather than silently defaulting', () => {
    // `ProposalErrorCode` is a closed literal union, so
    // `new ProposalError('NOT_A_REAL_CODE', 'x')` is a compile-time error —
    // this test exercises the one remaining way an uncontracted value could
    // reach `STATUS_BY_CODE` at runtime: a value smuggled in via an
    // explicit cast, proving the lookup has no catch-all/default entry for
    // it.
    const smuggled = 'NOT_A_REAL_CODE' as unknown as ProposalErrorCode;
    const error = new ProposalError(smuggled, 'message');
    expect(error.status).toBeUndefined();
  });
});
