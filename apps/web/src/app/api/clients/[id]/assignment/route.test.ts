import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  setClientAssignment: vi.fn(),
  endClientAssignment: vi.fn(),
}));
vi.mock('@/features/assignments/service', () => serviceMocks);

import { AssignmentError } from '@/features/assignments/errors';

import { DELETE, PUT } from './route';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};
const TRAVEL_CONSULTANT = {
  id: 'tc-1',
  email: 'tc@example.test',
  name: 'TC',
  role: 'TRAVEL_CONSULTANT',
};

const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const STAFF_ID = '4fa85f64-5717-4562-b3fc-2c963f66afa6';

function putRequest(body: unknown): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}/assignment`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function deleteRequest(body: unknown): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}/assignment`, {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}

function context(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: CLIENT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/clients/[id]/assignment', () => {
  it('returns 403 for a non-ADMIN_MANAGER caller (e.g. TRAVEL_CONSULTANT)', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.setClientAssignment).not.toHaveBeenCalled();
  });

  it('returns 200 and forwards user/id/body to setClientAssignment', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const assignment = { id: 'assignment-1', assignedStaffId: STAFF_ID };
    serviceMocks.setClientAssignment.mockResolvedValue(assignment);

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ assignment });
    expect(serviceMocks.setClientAssignment).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      CLIENT_ID,
      STAFF_ID,
      undefined,
    );
  });

  it('maps a thrown AssignmentError (e.g. CLIENT_NOT_FOUND) to its declared envelope', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setClientAssignment.mockRejectedValue(
      new AssignmentError('CLIENT_NOT_FOUND', 'Client not found.'),
    );

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' },
    });
  });
});

describe('DELETE /api/clients/[id]/assignment', () => {
  it('returns 400 when reason is missing', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await DELETE(deleteRequest({}), context());
    expect(response.status).toBe(400);
  });

  it('returns 200 with the service result, forwarding user/id/reason to endClientAssignment', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.endClientAssignment.mockResolvedValue(null);

    const response = await DELETE(deleteRequest({ reason: 'No longer engaged' }), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ assignment: null });
    expect(serviceMocks.endClientAssignment).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      CLIENT_ID,
      'No longer engaged',
    );
  });
});
