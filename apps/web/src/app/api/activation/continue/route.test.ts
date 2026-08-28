import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({ continueInvitation: vi.fn() }));
vi.mock('@/features/activation/service', () => serviceMocks);

import { ActivationError } from '@/features/activation/errors';

import { POST } from './route';

const VALID_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1L2';

function request(body: unknown): Request {
  return new Request('http://localhost/api/activation/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
      new Request('http://localhost/api/activation/continue', { method: 'POST', body: 'not json' }),
    );
    expect(response.status).toBe(400);
  });
});
