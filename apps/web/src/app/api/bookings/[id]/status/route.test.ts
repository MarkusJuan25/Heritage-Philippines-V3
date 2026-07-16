import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  updateBookingStatus: vi.fn(),
}));
vi.mock('@/features/bookings/service', () => serviceMocks);

import { BookingError } from '@/features/bookings/errors';

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

function putRequest(body: unknown): Request {
  return new Request(`http://localhost/api/bookings/${BOOKING_ID}/status`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function context(id = BOOKING_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const VALID_BODY = { expectedStatus: 'DRAFT', newStatus: 'PENDING_CONFIRMATION' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/bookings/[id]/status', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await PUT(putRequest(VALID_BODY), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.updateBookingStatus).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s), never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await PUT(putRequest(VALID_BODY), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.updateBookingStatus).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID booking id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PUT(putRequest(VALID_BODY), context('not-a-uuid'));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.updateBookingStatus).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing expectedStatus', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PUT(putRequest({ newStatus: 'PENDING_CONFIRMATION' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.updateBookingStatus).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid status value', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PUT(
      putRequest({ expectedStatus: 'DRAFT', newStatus: 'NOT_A_STATUS' }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.updateBookingStatus).not.toHaveBeenCalled();
  });

  it('returns 400 when the body includes a reason field, and never calls the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PUT(
      putRequest({ ...VALID_BODY, reason: 'Client requested change' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.updateBookingStatus).not.toHaveBeenCalled();
  });

  it('returns 400 for any other unrecognized property in the body', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PUT(
      putRequest({ ...VALID_BODY, bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD' }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.updateBookingStatus).not.toHaveBeenCalled();
  });

  it('returns 200 with the updated Booking for ADMIN_MANAGER', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const booking = { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' };
    serviceMocks.updateBookingStatus.mockResolvedValue(booking);

    const response = await PUT(putRequest(VALID_BODY), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ booking });
    expect(serviceMocks.updateBookingStatus).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      BOOKING_ID,
      VALID_BODY,
    );
  });

  it('returns 200 with the updated Booking for an assigned TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    const booking = { id: BOOKING_ID, status: 'PENDING_CONFIRMATION' };
    serviceMocks.updateBookingStatus.mockResolvedValue(booking);

    const response = await PUT(putRequest(VALID_BODY), context());

    expect(response.status).toBe(200);
    expect(serviceMocks.updateBookingStatus).toHaveBeenCalledWith(
      TRAVEL_CONSULTANT,
      BOOKING_ID,
      VALID_BODY,
    );
  });

  it('returns 200 for a same-status idempotent replay (the service resolves it as a no-op)', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const booking = { id: BOOKING_ID, status: 'DRAFT' };
    serviceMocks.updateBookingStatus.mockResolvedValue(booking);

    const response = await PUT(
      putRequest({ expectedStatus: 'DRAFT', newStatus: 'DRAFT' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ booking });
  });

  it('returns 404 BOOKING_NOT_FOUND for ADMIN_MANAGER when the booking genuinely does not exist', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateBookingStatus.mockRejectedValue(
      new BookingError('BOOKING_NOT_FOUND', 'Booking not found.'),
    );

    const response = await PUT(putRequest(VALID_BODY), context());

    expect(response.status).toBe(404);
  });

  it('returns 403 BOOKING_FORBIDDEN for an unassigned/inaccessible TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.updateBookingStatus.mockRejectedValue(
      new BookingError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.'),
    );

    const response = await PUT(putRequest(VALID_BODY), context());

    expect(response.status).toBe(403);
  });

  it('returns 409 BOOKING_CONFLICT for a stale expectedStatus', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateBookingStatus.mockRejectedValue(
      new BookingError(
        'BOOKING_CONFLICT',
        'This booking has changed since it was last loaded. Refresh and try again.',
      ),
    );

    const response = await PUT(putRequest(VALID_BODY), context());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error.code).toBe('BOOKING_CONFLICT');
  });

  it('returns 409 INVALID_STATUS_TRANSITION for a disallowed transition', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateBookingStatus.mockRejectedValue(
      new BookingError(
        'INVALID_STATUS_TRANSITION',
        'Cannot transition a booking from DRAFT to COMPLETED.',
      ),
    );

    const response = await PUT(
      putRequest({ expectedStatus: 'DRAFT', newStatus: 'COMPLETED' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateBookingStatus.mockRejectedValue(new Error('unexpected db failure'));

    const response = await PUT(putRequest(VALID_BODY), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
