import { beforeEach, describe, expect, it, vi } from 'vitest';

// `withRole` (guards.ts) reads the session through `./auth`, which eagerly
// constructs a real Better Auth/Prisma client at import time — mock it
// before the route module is imported, the same technique guards.test.ts
// uses.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  setLeadAssignment: vi.fn(),
  endLeadAssignment: vi.fn(),
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
const SYSTEM_ADMINISTRATOR = {
  id: 'sysadmin-1',
  email: 'sysadmin@example.test',
  name: 'Sys Admin',
  role: 'SYSTEM_ADMINISTRATOR',
};
const TRAVEL_CONSULTANT = {
  id: 'tc-1',
  email: 'tc@example.test',
  name: 'TC',
  role: 'TRAVEL_CONSULTANT',
};

const LEAD_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const STAFF_ID = '4fa85f64-5717-4562-b3fc-2c963f66afa6';

function putRequest(body: unknown): Request {
  return new Request(`http://localhost/api/leads/${LEAD_ID}/assignment`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function deleteRequest(body: unknown): Request {
  return new Request(`http://localhost/api/leads/${LEAD_ID}/assignment`, {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}

function context(id: string = LEAD_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/leads/[id]/assignment', () => {
  it('returns 401 when unauthenticated', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());
    expect(response.status).toBe(401);
    expect(serviceMocks.setLeadAssignment).not.toHaveBeenCalled();
  });

  it('returns 403 for SYSTEM_ADMINISTRATOR — no implicit operational permission', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.setLeadAssignment).not.toHaveBeenCalled();
  });

  it('returns 403 for TRAVEL_CONSULTANT (an unrelated staff role for this mutation)', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.setLeadAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid lead id', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context('not-a-uuid'));
    expect(response.status).toBe(400);
    expect(serviceMocks.setLeadAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid body', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await PUT(putRequest({ assignedStaffId: 'not-a-uuid' }), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.setLeadAssignment).not.toHaveBeenCalled();
  });

  it('returns 200 with the assignment envelope on success, forwarding user/id/body to the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const assignment = { id: 'assignment-1', assignedStaffId: STAFF_ID };
    serviceMocks.setLeadAssignment.mockResolvedValue(assignment);

    const response = await PUT(
      putRequest({ assignedStaffId: STAFF_ID, reason: 'Reassigning' }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ assignment });
    expect(serviceMocks.setLeadAssignment).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      LEAD_ID,
      STAFF_ID,
      'Reassigning',
    );
  });

  it('maps a thrown AssignmentError to its declared status and the standard error envelope', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setLeadAssignment.mockRejectedValue(
      new AssignmentError('LEAD_NOT_FOUND', 'Lead not found.'),
    );

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'LEAD_NOT_FOUND', message: 'Lead not found.' },
    });
  });

  it('returns a generic 500 envelope, never a raw error, when the service throws unexpectedly', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setLeadAssignment.mockRejectedValue(new Error('boom: internal detail'));

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
  });
});

describe('DELETE /api/leads/[id]/assignment', () => {
  it('returns 403 for SYSTEM_ADMINISTRATOR', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const response = await DELETE(deleteRequest({ reason: 'Archiving' }), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.endLeadAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 when reason is missing', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await DELETE(deleteRequest({}), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.endLeadAssignment).not.toHaveBeenCalled();
  });

  it('returns 200 with a null assignment when nothing was active (idempotent)', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.endLeadAssignment.mockResolvedValue(null);

    const response = await DELETE(deleteRequest({ reason: 'Archiving lead' }), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ assignment: null });
    expect(serviceMocks.endLeadAssignment).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      LEAD_ID,
      'Archiving lead',
    );
  });

  it('returns 200 with the ended assignment on success', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const ended = { id: 'assignment-1', endedAt: '2026-07-20T10:00:00.000Z' };
    serviceMocks.endLeadAssignment.mockResolvedValue(ended);

    const response = await DELETE(deleteRequest({ reason: 'Archiving lead' }), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ assignment: ended });
  });
});
