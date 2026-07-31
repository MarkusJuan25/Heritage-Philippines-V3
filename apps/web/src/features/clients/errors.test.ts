import { describe, expect, it } from 'vitest';

import { ClientError, type ClientErrorCode } from './errors';

const EXPECTED_STATUS: Record<ClientErrorCode, number> = {
  VALIDATION_ERROR: 400,
  ROLE_NOT_PERMITTED: 403,
  CLIENT_FORBIDDEN: 403,
  CLIENT_NOT_FOUND: 404,
  CLIENT_CONFLICT: 409,
};

describe('ClientError', () => {
  for (const [code, status] of Object.entries(EXPECTED_STATUS) as [ClientErrorCode, number][]) {
    it(`maps ${code} to status ${status}`, () => {
      const error = new ClientError(code, 'message');
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.name).toBe('ClientError');
      expect(error).toBeInstanceOf(Error);
    });
  }

  it('carries the supplied message', () => {
    const error = new ClientError('CLIENT_CONFLICT', 'Refresh and try again.');
    expect(error.message).toBe('Refresh and try again.');
  });

  it("carries D-025 §9's exact CLIENT_NOT_FOUND message unchanged", () => {
    const error = new ClientError('CLIENT_NOT_FOUND', 'Client not found.');
    expect(error.message).toBe('Client not found.');
  });

  it("carries D-025 §9's exact CLIENT_FORBIDDEN message unchanged", () => {
    const error = new ClientError('CLIENT_FORBIDDEN', 'You do not have access to this client.');
    expect(error.message).toBe('You do not have access to this client.');
  });

  it("carries D-025 §9's exact CLIENT_CONFLICT message unchanged", () => {
    const error = new ClientError(
      'CLIENT_CONFLICT',
      'This client has changed since it was last loaded. Refresh and try again.',
    );
    expect(error.message).toBe(
      'This client has changed since it was last loaded. Refresh and try again.',
    );
  });

  it("carries D-025 §5's exact combined-contact VALIDATION_ERROR message unchanged", () => {
    const error = new ClientError(
      'VALIDATION_ERROR',
      'A client must retain at least one of email or phone.',
    );
    expect(error.message).toBe('A client must retain at least one of email or phone.');
  });
});
