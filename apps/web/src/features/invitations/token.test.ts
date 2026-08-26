import { describe, expect, it } from 'vitest';

import {
  buildResendIdempotencyKey,
  computeExpiryFromNow,
  generateInvitationToken,
  hashInvitationToken,
} from './token';

describe('generateInvitationToken', () => {
  it('generates a 24-character token over the expected alphabet', () => {
    const token = generateInvitationToken();
    expect(token).toHaveLength(24);
    expect(token).toMatch(/^[a-zA-Z0-9\-_]{24}$/);
  });

  it('never repeats a token across many calls (collision smoke test)', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateInvitationToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('hashInvitationToken', () => {
  it('is a deterministic 64-character hex SHA-256 digest', () => {
    const digest = hashInvitationToken('a-fixed-raw-token');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvitationToken('a-fixed-raw-token')).toBe(digest);
  });

  it('produces different digests for different tokens', () => {
    expect(hashInvitationToken('token-a')).not.toBe(hashInvitationToken('token-b'));
  });

  it('never returns the raw token itself', () => {
    const raw = 'do-not-leak-this-raw-token';
    expect(hashInvitationToken(raw)).not.toContain(raw);
  });
});

describe('computeExpiryFromNow', () => {
  it('is exactly seven calendar days from the given instant', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiry = computeExpiryFromNow(now);
    expect(expiry.toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });

  it('defaults to the current time when no instant is given', () => {
    const before = Date.now();
    const expiry = computeExpiryFromNow();
    const after = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(expiry.getTime()).toBeLessThanOrEqual(after + sevenDaysMs);
  });
});

describe('buildResendIdempotencyKey', () => {
  it('namespaces the send-operation id under this feature', () => {
    expect(buildResendIdempotencyKey('abc-123')).toBe('portal-invitation/abc-123');
  });
});
