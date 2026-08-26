import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({ confirmManualSend: vi.fn() }));
vi.mock('@/features/invitations/service', () => serviceMocks);

import { POST } from './route';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: 'ADMIN_MANAGER',
};
const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const IDEMPOTENCY_KEY = '44444444-4444-4444-8444-444444444444';

function request(
  headers: Record<string, string> = { 'Idempotency-Key': IDEMPOTENCY_KEY },
): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}/invitation/confirm-manual-sent`, {
    method: 'POST',
    headers,
  });
}

function context(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: CLIENT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
});

describe('POST /api/clients/[id]/invitation/confirm-manual-sent', () => {
  it('forwards user/id/idempotencyKey to the service with no body', async () => {
    const invitation = { id: 'inv-1', deliveryState: 'MANUALLY_CONFIRMED' };
    serviceMocks.confirmManualSend.mockResolvedValue(invitation);

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ invitation });
    expect(serviceMocks.confirmManualSend).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      CLIENT_ID,
      IDEMPOTENCY_KEY,
    );
  });

  it('requires a valid Idempotency-Key header', async () => {
    const response = await POST(request({}), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.confirmManualSend).not.toHaveBeenCalled();
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'returns 403 for %s',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });
      const response = await POST(request(), context());
      expect(response.status).toBe(403);
      expect(serviceMocks.confirmManualSend).not.toHaveBeenCalled();
    },
  );
});
