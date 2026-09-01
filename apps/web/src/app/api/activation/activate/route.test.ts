import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({ activateAccount: vi.fn() }));
vi.mock('@/features/activation/service', () => serviceMocks);

const cryptoMocks = vi.hoisted(() => ({ hashPassword: vi.fn(async () => 'hashed-value') }));
vi.mock('better-auth/crypto', () => cryptoMocks);

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
const VALID_PASSWORD = 'correct-horse-battery';
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
  return new Request('http://localhost:3000/api/activation/activate', {
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
  cryptoMocks.hashPassword.mockResolvedValue('hashed-value');
});

describe('POST /api/activation/activate', () => {
  it('returns 200 { activated: true } on success, hashing the password before calling the service', async () => {
    serviceMocks.activateAccount.mockResolvedValue({ activated: true });
    const response = await POST(
      request({ token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activated: true });
    expect(cryptoMocks.hashPassword).toHaveBeenCalledWith(VALID_PASSWORD);
    expect(serviceMocks.activateAccount).toHaveBeenCalledWith(VALID_TOKEN, 'hashed-value');
  });

  it('never returns the password or its hash in the response body', async () => {
    serviceMocks.activateAccount.mockResolvedValue({ activated: true });
    const response = await POST(
      request({ token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
    );
    const bodyText = JSON.stringify(await response.clone().json());
    expect(bodyText).not.toContain(VALID_PASSWORD);
    expect(bodyText).not.toContain('hashed-value');
  });

  it('sets Cache-Control: no-store and Referrer-Policy: no-referrer', async () => {
    serviceMocks.activateAccount.mockResolvedValue({ activated: true });
    const response = await POST(
      request({ token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('returns the generic 409 envelope on any eligibility or collision rejection', async () => {
    serviceMocks.activateAccount.mockRejectedValue(new ActivationError());
    const response = await POST(
      request({ token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'ACTIVATION_NOT_POSSIBLE',
        message: 'This invitation link is no longer valid.',
      },
    });
  });

  it('returns 400 field-level errors for a too-short password, never hashing or calling the service', async () => {
    const response = await POST(
      request({ token: VALID_TOKEN, password: 'short', confirmPassword: 'short' }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(
      body.error.details.some(
        (d: { message: string }) => d.message === 'Password must be at least 12 characters.',
      ),
    ).toBe(true);
    expect(cryptoMocks.hashPassword).not.toHaveBeenCalled();
    expect(serviceMocks.activateAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for mismatched passwords, never hashing or calling the service', async () => {
    const response = await POST(
      request({
        token: VALID_TOKEN,
        password: VALID_PASSWORD,
        confirmPassword: 'different-value-here',
      }),
    );

    expect(response.status).toBe(400);
    expect(cryptoMocks.hashPassword).not.toHaveBeenCalled();
    expect(serviceMocks.activateAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed token, never calling the service', async () => {
    const response = await POST(
      request({ token: 'not-valid', password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
    );
    expect(response.status).toBe(400);
    expect(serviceMocks.activateAccount).not.toHaveBeenCalled();
  });

  describe('Origin enforcement (D-037 Section 10)', () => {
    it('rejects a missing Origin with 403, never hashing or calling the service', async () => {
      const response = await POST(
        request(
          { token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD },
          { origin: null },
        ),
      );
      expect(response.status).toBe(403);
      expect(cryptoMocks.hashPassword).not.toHaveBeenCalled();
      expect(serviceMocks.activateAccount).not.toHaveBeenCalled();
    });

    it('rejects a mismatched Origin with 403', async () => {
      const response = await POST(
        request(
          { token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD },
          { origin: 'https://evil.example' },
        ),
      );
      expect(response.status).toBe(403);
    });
  });

  describe('declared Content-Length enforcement (D-037 Section 10)', () => {
    it('rejects an oversized declared Content-Length with 400, before any rate-limit check or hashing', async () => {
      const req = new Request('http://localhost:3000/api/activation/activate', {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          'Content-Length': '999999',
        },
        body: JSON.stringify({
          token: VALID_TOKEN,
          password: VALID_PASSWORD,
          confirmPassword: VALID_PASSWORD,
        }),
      });
      const response = await POST(req);
      expect(response.status).toBe(400);
      expect(rateLimitMocks.checkSourceRateLimit).not.toHaveBeenCalled();
      expect(cryptoMocks.hashPassword).not.toHaveBeenCalled();
      expect(serviceMocks.activateAccount).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting (D-037 Section 11)', () => {
    it('returns 429 when the SOURCE dimension rejects, never hashing or calling the service', async () => {
      rateLimitMocks.checkSourceRateLimit.mockResolvedValue(true);
      const response = await POST(
        request({ token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
      );

      expect(response.status).toBe(429);
      expect(rateLimitMocks.checkTokenRateLimit).not.toHaveBeenCalled();
      expect(cryptoMocks.hashPassword).not.toHaveBeenCalled();
      expect(serviceMocks.activateAccount).not.toHaveBeenCalled();
    });

    it('returns 429 when the TOKEN dimension rejects, never hashing (the slow step) or calling the service', async () => {
      rateLimitMocks.checkTokenRateLimit.mockResolvedValue(true);
      const response = await POST(
        request({ token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
      );

      expect(response.status).toBe(429);
      expect(cryptoMocks.hashPassword).not.toHaveBeenCalled();
      expect(serviceMocks.activateAccount).not.toHaveBeenCalled();
    });

    it('checks TOKEN rate limit with the SHA-256 digest of the token, never the raw token itself', async () => {
      await POST(
        request({ token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
      );
      expect(rateLimitMocks.checkTokenRateLimit).toHaveBeenCalledWith(
        hashInvitationToken(VALID_TOKEN),
      );
      expect(rateLimitMocks.checkTokenRateLimit).not.toHaveBeenCalledWith(VALID_TOKEN);
    });

    it('checks SOURCE, then TOKEN, then hashes the password, then calls the service, in that exact order', async () => {
      const order: string[] = [];
      rateLimitMocks.checkSourceRateLimit.mockImplementation(async () => {
        order.push('source');
        return false;
      });
      rateLimitMocks.checkTokenRateLimit.mockImplementation(async () => {
        order.push('token');
        return false;
      });
      cryptoMocks.hashPassword.mockImplementation(async () => {
        order.push('hash');
        return 'hashed-value';
      });
      serviceMocks.activateAccount.mockImplementation(async () => {
        order.push('service');
        return { activated: true };
      });

      await POST(
        request({ token: VALID_TOKEN, password: VALID_PASSWORD, confirmPassword: VALID_PASSWORD }),
      );

      expect(order).toEqual(['source', 'token', 'hash', 'service']);
    });
  });
});
