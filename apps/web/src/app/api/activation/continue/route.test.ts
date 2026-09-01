import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({ continueInvitation: vi.fn() }));
vi.mock('@/features/activation/service', () => serviceMocks);

const rateLimitMocks = vi.hoisted(() => ({
  checkSourceRateLimit: vi.fn(async () => false),
  checkTokenRateLimit: vi.fn(async () => false),
}));
vi.mock('@/features/activation/rate-limit', () => rateLimitMocks);

const { getServerEnvMock } = vi.hoisted(() => ({ getServerEnvMock: vi.fn() }));
vi.mock('@/lib/env', () => ({ getServerEnv: getServerEnvMock }));

import { ActivationError } from '@/features/activation/errors';
import { hashInvitationToken } from '@/features/invitations/token';

import { POST } from './route';

const VALID_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1L2';
const ORIGIN = 'http://localhost:3000';

function request(
  body: unknown,
  init?: { origin?: string | null; contentType?: string | null },
): Request {
  const headers = new Headers();
  const origin = init?.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.set('Origin', origin);
  const contentType = init?.contentType === undefined ? 'application/json' : init.contentType;
  if (contentType !== null) headers.set('Content-Type', contentType);
  return new Request('http://localhost:3000/api/activation/continue', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getServerEnvMock.mockReturnValue({ BETTER_AUTH_URL: ORIGIN });
  rateLimitMocks.checkSourceRateLimit.mockResolvedValue(false);
  rateLimitMocks.checkTokenRateLimit.mockResolvedValue(false);
});

describe('POST /api/activation/continue', () => {
  it('returns 200 { opened: true } on success', async () => {
    serviceMocks.continueInvitation.mockResolvedValue({ opened: true });
    const response = await POST(request({ token: VALID_TOKEN }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ opened: true });
    expect(serviceMocks.continueInvitation).toHaveBeenCalledWith(VALID_TOKEN);
  });

  it('sets Cache-Control: no-store and Referrer-Policy: no-referrer', async () => {
    serviceMocks.continueInvitation.mockResolvedValue({ opened: true });
    const response = await POST(request({ token: VALID_TOKEN }));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('returns the generic 409 envelope when the service rejects ineligibility, never leaking a cause', async () => {
    serviceMocks.continueInvitation.mockRejectedValue(new ActivationError());
    const response = await POST(request({ token: VALID_TOKEN }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'ACTIVATION_NOT_POSSIBLE',
        message: 'This invitation link is no longer valid.',
      },
    });
  });

  it('returns 400 for a malformed token, never calling the service', async () => {
    const response = await POST(request({ token: 'not-valid' }));
    expect(response.status).toBe(400);
    expect(serviceMocks.continueInvitation).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing token field', async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(400);
    expect(serviceMocks.continueInvitation).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON', async () => {
    const response = await POST(
      new Request('http://localhost:3000/api/activation/continue', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });

  describe('Origin enforcement (D-037 Section 10)', () => {
    it('rejects a missing Origin with 403, before any rate-limit check or service call', async () => {
      const response = await POST(request({ token: VALID_TOKEN }, { origin: null }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: { code: 'FORBIDDEN', message: 'Request rejected.' },
      });
      expect(rateLimitMocks.checkSourceRateLimit).not.toHaveBeenCalled();
      expect(serviceMocks.continueInvitation).not.toHaveBeenCalled();
    });

    it('rejects a mismatched Origin with 403', async () => {
      const response = await POST(
        request({ token: VALID_TOKEN }, { origin: 'https://evil.example' }),
      );
      expect(response.status).toBe(403);
      expect(serviceMocks.continueInvitation).not.toHaveBeenCalled();
    });
  });

  describe('Content-Type enforcement (D-037 Section 10)', () => {
    it('rejects a non-JSON Content-Type with 400, before any rate-limit check', async () => {
      const response = await POST(request({ token: VALID_TOKEN }, { contentType: 'text/plain' }));
      expect(response.status).toBe(400);
      expect(rateLimitMocks.checkSourceRateLimit).not.toHaveBeenCalled();
    });
  });

  describe('declared Content-Length enforcement (D-037 Section 10)', () => {
    it('rejects an oversized declared Content-Length with 400, before any rate-limit check', async () => {
      const req = new Request('http://localhost:3000/api/activation/continue', {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          'Content-Length': '999999',
        },
        body: JSON.stringify({ token: VALID_TOKEN }),
      });
      const response = await POST(req);
      expect(response.status).toBe(400);
      expect(rateLimitMocks.checkSourceRateLimit).not.toHaveBeenCalled();
      expect(serviceMocks.continueInvitation).not.toHaveBeenCalled();
    });

    it('rejects a real oversized body end-to-end even with no Content-Length header, never reaching the service', async () => {
      const oversized = 'a'.repeat(5000);
      const req = new Request('http://localhost:3000/api/activation/continue', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: `{"token":"${oversized}"}`,
      });
      const response = await POST(req);
      expect(response.status).toBe(400);
      expect(rateLimitMocks.checkTokenRateLimit).not.toHaveBeenCalled();
      expect(serviceMocks.continueInvitation).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting (D-037 Section 11)', () => {
    it('returns 429 RATE_LIMITED when the SOURCE dimension rejects, before reading the body', async () => {
      rateLimitMocks.checkSourceRateLimit.mockResolvedValue(true);
      const response = await POST(
        new Request('http://localhost:3000/api/activation/continue', {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: 'this is not even valid json',
        }),
      );

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
      });
      expect(rateLimitMocks.checkTokenRateLimit).not.toHaveBeenCalled();
      expect(serviceMocks.continueInvitation).not.toHaveBeenCalled();
    });

    it('returns 429 RATE_LIMITED when the TOKEN dimension rejects, after a valid body is parsed', async () => {
      rateLimitMocks.checkTokenRateLimit.mockResolvedValue(true);
      const response = await POST(request({ token: VALID_TOKEN }));

      expect(response.status).toBe(429);
      expect(rateLimitMocks.checkSourceRateLimit).toHaveBeenCalledTimes(1);
      expect(rateLimitMocks.checkTokenRateLimit).toHaveBeenCalledTimes(1);
      expect(serviceMocks.continueInvitation).not.toHaveBeenCalled();
    });

    it('checks TOKEN rate limit with the SHA-256 digest of the token, never the raw token itself', async () => {
      await POST(request({ token: VALID_TOKEN }));
      expect(rateLimitMocks.checkTokenRateLimit).toHaveBeenCalledWith(
        hashInvitationToken(VALID_TOKEN),
      );
      expect(rateLimitMocks.checkTokenRateLimit).not.toHaveBeenCalledWith(VALID_TOKEN);
    });

    it('checks SOURCE before TOKEN and TOKEN before the service call', async () => {
      const order: string[] = [];
      rateLimitMocks.checkSourceRateLimit.mockImplementation(async () => {
        order.push('source');
        return false;
      });
      rateLimitMocks.checkTokenRateLimit.mockImplementation(async () => {
        order.push('token');
        return false;
      });
      serviceMocks.continueInvitation.mockImplementation(async () => {
        order.push('service');
        return { opened: true };
      });

      await POST(request({ token: VALID_TOKEN }));

      expect(order).toEqual(['source', 'token', 'service']);
    });
  });
});
