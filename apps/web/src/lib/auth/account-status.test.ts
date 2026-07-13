import { describe, expect, it } from 'vitest';

import { assertAccountIsActive } from './account-status';

describe('assertAccountIsActive', () => {
  it('does not throw when the user is active', () => {
    expect(() => assertAccountIsActive({ isActive: true })).not.toThrow();
  });

  it('does not throw when there is no user (defensive — should not happen for a valid session.userId)', () => {
    expect(() => assertAccountIsActive(null)).not.toThrow();
    expect(() => assertAccountIsActive(undefined)).not.toThrow();
  });

  it('throws a FORBIDDEN APIError with code ACCOUNT_DEACTIVATED when the user is inactive', () => {
    let caught: unknown;
    try {
      assertAccountIsActive({ isActive: false });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as { status: string; statusCode: number; body?: { code?: string } };
    expect(error.status).toBe('FORBIDDEN');
    expect(error.statusCode).toBe(403);
    expect(error.body?.code).toBe('ACCOUNT_DEACTIVATED');
  });
});
