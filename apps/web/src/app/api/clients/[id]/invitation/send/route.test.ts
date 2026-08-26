import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({ sendInvitation: vi.fn() }));
vi.mock('@/features/invitations/service', () => serviceMocks);

import { InvitationError } from '@/features/invitations/errors';

import { POST } from './route';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: 'ADMIN_MANAGER',
};
const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';

function request(
  body: unknown,
  headers: Record<string, string> = { 'Idempotency-Key': IDEMPOTENCY_KEY },
): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}/invitation/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function context(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: CLIENT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
});

describe('POST /api/clients/[id]/invitation/send', () => {
  it('returns 403 for a CLIENT caller, never calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role: 'CLIENT' } });
    const response = await POST(request({ deliveryMethod: 'MANUAL_EMAIL' }), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.sendInvitation).not.toHaveBeenCalled();
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const response = await POST(request({ deliveryMethod: 'MANUAL_EMAIL' }, {}), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.sendInvitation).not.toHaveBeenCalled();
  });

  it('returns 400 when the Idempotency-Key header is not a valid UUID', async () => {
    const response = await POST(
      request({ deliveryMethod: 'MANUAL_EMAIL' }, { 'Idempotency-Key': 'not-a-uuid' }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(serviceMocks.sendInvitation).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid deliveryMethod', async () => {
    const response = await POST(request({ deliveryMethod: 'CARRIER_PIGEON' }), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.sendInvitation).not.toHaveBeenCalled();
  });

  it('forwards user/id/deliveryMethod/idempotencyKey to the service and returns its result', async () => {
    const result = { invitation: { id: 'inv-1' }, delivery: 'reserved-only' };
    serviceMocks.sendInvitation.mockResolvedValue(result);

    const response = await POST(request({ deliveryMethod: 'MANUAL_EMAIL' }), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
    expect(serviceMocks.sendInvitation).toHaveBeenCalledWith(ADMIN_MANAGER, CLIENT_ID, {
      deliveryMethod: 'MANUAL_EMAIL',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it('never leaks tokenHash into the response, even though the service result carries it', async () => {
    serviceMocks.sendInvitation.mockResolvedValue({
      invitation: {
        id: 'inv-1',
        status: 'INVITATION_SENT',
        tokenHash: 'a'.repeat(64),
      },
      delivery: 'reserved-only',
      manualInvitationUrl: 'http://localhost:3000/activate/a-raw-token',
    });

    const response = await POST(request({ deliveryMethod: 'MANUAL_EMAIL' }), context());
    const body = (await response.json()) as { invitation: unknown; manualInvitationUrl: string };

    expect(body.invitation).not.toHaveProperty('tokenHash');
    expect(body.manualInvitationUrl).toBe('http://localhost:3000/activate/a-raw-token');
  });

  it('maps a thrown InvitationError (e.g. DELIVERY_DISABLED) to its declared envelope', async () => {
    serviceMocks.sendInvitation.mockRejectedValue(
      new InvitationError('DELIVERY_DISABLED', 'Automated email delivery is currently disabled.'),
    );

    const response = await POST(request({ deliveryMethod: 'AUTOMATED_EMAIL' }), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'DELIVERY_DISABLED',
        message: 'Automated email delivery is currently disabled.',
      },
    });
  });
});
