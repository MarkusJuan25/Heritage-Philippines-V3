import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  setBookingAssignment: vi.fn(),
}));
vi.mock('@/features/assignments/service', () => serviceMocks);

import { AssignmentError } from '@/features/assignments/errors';

import { PUT } from './route';

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

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const STAFF_ID = '4fa85f64-5717-4562-b3fc-2c963f66afa6';

function putRequest(body: unknown): Request {
  return new Request(`http://localhost/api/bookings/${BOOKING_ID}/assignment`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function context(id = BOOKING_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/bookings/[id]/assignment', () => {
  it.each([
    'TRAVEL_CONSULTANT',
    'CLIENT',
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'SYSTEM_ADMINISTRATOR',
  ])('returns 403 for a non-ADMIN_MANAGER caller (%s), never calling the service', async (role) => {
    getSessionMock.mockResolvedValue({ user: { ...TRAVEL_CONSULTANT, role } });

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.setBookingAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-UUID booking id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context('not-a-uuid'));

    expect(response.status).toBe(400);
    expect(serviceMocks.setBookingAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing assignedStaffId', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PUT(putRequest({}), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.setBookingAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-UUID assignedStaffId', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PUT(putRequest({ assignedStaffId: 'not-a-uuid' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.setBookingAssignment).not.toHaveBeenCalled();
  });

  it('returns 200 and forwards user/id/body to setBookingAssignment', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const assignment = { id: 'assignment-1', assignedStaffId: STAFF_ID, bookingId: BOOKING_ID };
    serviceMocks.setBookingAssignment.mockResolvedValue(assignment);

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ assignment });
    expect(serviceMocks.setBookingAssignment).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      BOOKING_ID,
      STAFF_ID,
      undefined,
    );
  });

  it('forwards an optional reason to setBookingAssignment', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setBookingAssignment.mockResolvedValue({ id: 'assignment-1' });

    await PUT(putRequest({ assignedStaffId: STAFF_ID, reason: 'Rebalancing workload' }), context());

    expect(serviceMocks.setBookingAssignment).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      BOOKING_ID,
      STAFF_ID,
      'Rebalancing workload',
    );
  });

  it('maps a thrown AssignmentError (BOOKING_NOT_FOUND) to its declared envelope', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setBookingAssignment.mockRejectedValue(
      new AssignmentError('BOOKING_NOT_FOUND', 'Booking not found.'),
    );

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found.' },
    });
  });

  it('maps REASON_REQUIRED (replacing without a reason) to its declared envelope', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setBookingAssignment.mockRejectedValue(
      new AssignmentError(
        'REASON_REQUIRED',
        'A reason is required when replacing an existing assignment.',
      ),
    );

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error.code).toBe('REASON_REQUIRED');
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setBookingAssignment.mockRejectedValue(new Error('unexpected db failure'));

    const response = await PUT(putRequest({ assignedStaffId: STAFF_ID }), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
