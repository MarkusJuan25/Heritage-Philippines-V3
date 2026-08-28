import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({ activateAccount: vi.fn() }));
vi.mock('@/features/activation/service', () => serviceMocks);

const cryptoMocks = vi.hoisted(() => ({ hashPassword: vi.fn(async () => 'hashed-value') }));
vi.mock('better-auth/crypto', () => cryptoMocks);

import { ActivationError } from '@/features/activation/errors';

import { POST } from './route';

const VALID_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1L2';
const VALID_PASSWORD = 'correct-horse-battery';

function request(body: unknown): Request {
  return new Request('http://localhost/api/activation/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
});
