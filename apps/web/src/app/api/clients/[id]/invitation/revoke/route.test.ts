import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({ revokeInvitation: vi.fn() }));
vi.mock('@/features/invitations/service', () => serviceMocks);

import { POST } from './route';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: 'ADMIN_MANAGER',
};
const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function request(body: unknown): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}/invitation/revoke`, {
    method: 'POST',
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

describe('POST /api/clients/[id]/invitation/revoke', () => {
  it('returns 400 when reason is missing (admin-dashboard.md: destructive actions require a reason)', async () => {
    const response = await POST(request({}), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.revokeInvitation).not.toHaveBeenCalled();
  });

  it('forwards user/id/reason to the service', async () => {
    const invitation = { id: 'inv-1', status: 'INVITATION_REVOKED' };
    serviceMocks.revokeInvitation.mockResolvedValue(invitation);

    const response = await POST(request({ reason: 'client requested cancellation' }), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ invitation });
    expect(serviceMocks.revokeInvitation).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      CLIENT_ID,
      'client requested cancellation',
    );
  });
});
