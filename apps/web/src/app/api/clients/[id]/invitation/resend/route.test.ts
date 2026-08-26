import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({ resendInvitation: vi.fn() }));
vi.mock('@/features/invitations/service', () => serviceMocks);

import { POST } from './route';

const TRAVEL_CONSULTANT = {
  id: 'tc-1',
  email: 'tc@example.test',
  name: 'TC',
  role: 'TRAVEL_CONSULTANT',
};
const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const IDEMPOTENCY_KEY = '22222222-2222-4222-8222-222222222222';
const CONCURRENCY = {
  expectedCurrentSendOperationId: null,
  expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
};

function request(
  body: unknown,
  headers: Record<string, string> = { 'Idempotency-Key': IDEMPOTENCY_KEY },
): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}/invitation/resend`, {
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
  getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
});

describe('POST /api/clients/[id]/invitation/resend', () => {
  it('allows TRAVEL_CONSULTANT (assignment ownership is enforced in the service layer)', async () => {
    const result = { invitation: { id: 'inv-1' }, delivery: 'reserved-only' };
    serviceMocks.resendInvitation.mockResolvedValue(result);

    const response = await POST(
      request({ deliveryMethod: 'AUTOMATED_EMAIL', ...CONCURRENCY }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.resendInvitation).toHaveBeenCalledWith(
      TRAVEL_CONSULTANT,
      CLIENT_ID,
      { deliveryMethod: 'AUTOMATED_EMAIL', idempotencyKey: IDEMPOTENCY_KEY },
      {
        expectedCurrentSendOperationId: null,
        expectedUpdatedAt: new Date(CONCURRENCY.expectedUpdatedAt),
      },
    );
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'returns 403 for %s, never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...TRAVEL_CONSULTANT, role } });
      const response = await POST(
        request({ deliveryMethod: 'AUTOMATED_EMAIL', ...CONCURRENCY }),
        context(),
      );
      expect(response.status).toBe(403);
      expect(serviceMocks.resendInvitation).not.toHaveBeenCalled();
    },
  );

  it('requires a valid Idempotency-Key header', async () => {
    const response = await POST(
      request({ deliveryMethod: 'AUTOMATED_EMAIL', ...CONCURRENCY }, {}),
      context(),
    );
    expect(response.status).toBe(400);
  });

  it('requires expectedCurrentSendOperationId and expectedUpdatedAt in the body', async () => {
    const response = await POST(request({ deliveryMethod: 'AUTOMATED_EMAIL' }), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.resendInvitation).not.toHaveBeenCalled();
  });

  it('maps a thrown INVITATION_SEND_OPERATION_STALE to a 409', async () => {
    const { InvitationError } = await import('@/features/invitations/errors');
    serviceMocks.resendInvitation.mockRejectedValue(
      new InvitationError(
        'INVITATION_SEND_OPERATION_STALE',
        'This invitation has changed since you last loaded it. Refresh and try again.',
      ),
    );

    const response = await POST(
      request({ deliveryMethod: 'AUTOMATED_EMAIL', ...CONCURRENCY }),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'INVITATION_SEND_OPERATION_STALE',
        message: 'This invitation has changed since you last loaded it. Refresh and try again.',
      },
    });
  });
});
