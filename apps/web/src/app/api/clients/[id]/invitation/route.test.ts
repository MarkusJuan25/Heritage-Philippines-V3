import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  getInvitationForClient: vi.fn(),
  prepareInvitation: vi.fn(),
}));
vi.mock('@/features/invitations/service', () => serviceMocks);

import { InvitationError } from '@/features/invitations/errors';

import { GET, POST } from './route';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: 'ADMIN_MANAGER',
};
const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function request(method: string): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}/invitation`, { method });
}

function context(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: CLIENT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/clients/[id]/invitation', () => {
  it.each(['SYSTEM_ADMINISTRATOR', 'CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION'])(
    'returns 403 for %s',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });
      const response = await GET(request('GET'), context());
      expect(response.status).toBe(403);
      expect(serviceMocks.getInvitationForClient).not.toHaveBeenCalled();
    },
  );

  it('returns { invitation: null } for a client with no invitation yet', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getInvitationForClient.mockResolvedValue(null);

    const response = await GET(request('GET'), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ invitation: null });
  });

  it('maps a thrown InvitationError to its declared envelope', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getInvitationForClient.mockRejectedValue(
      new InvitationError('CLIENT_NOT_FOUND', 'Client not found.'),
    );

    const response = await GET(request('GET'), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' },
    });
  });
});

describe('POST /api/clients/[id]/invitation (prepare)', () => {
  it('returns 403 for a CLIENT caller', async () => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role: 'CLIENT' } });
    const response = await POST(request('POST'), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.prepareInvitation).not.toHaveBeenCalled();
  });

  it('returns 201 with the prepared invitation', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const invitation = { id: 'inv-1', status: 'INVITATION_PREPARED' };
    serviceMocks.prepareInvitation.mockResolvedValue(invitation);

    const response = await POST(request('POST'), context());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ invitation });
    expect(serviceMocks.prepareInvitation).toHaveBeenCalledWith(ADMIN_MANAGER, CLIENT_ID);
  });
});
