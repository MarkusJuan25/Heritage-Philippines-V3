import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  getBookingById: vi.fn(),
}));
vi.mock('@/features/bookings/service', () => serviceMocks);

import { BookingError } from '@/features/bookings/errors';

import { GET } from './route';

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

function getRequest(): Request {
  return new Request(`http://localhost/api/bookings/${BOOKING_ID}`, { method: 'GET' });
}

function context(id = BOOKING_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/bookings/[id]', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.getBookingById).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await GET(getRequest(), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.getBookingById).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest(), context('not-a-uuid'));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.getBookingById).not.toHaveBeenCalled();
  });

  it('returns 200 with the Booking for ADMIN_MANAGER', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const booking = { id: BOOKING_ID, bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD' };
    serviceMocks.getBookingById.mockResolvedValue(booking);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ booking });
    expect(serviceMocks.getBookingById).toHaveBeenCalledWith(ADMIN_MANAGER, BOOKING_ID);
  });

  it('returns 200 with the Booking for an assigned TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    const booking = { id: BOOKING_ID };
    serviceMocks.getBookingById.mockResolvedValue(booking);

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(200);
    expect(serviceMocks.getBookingById).toHaveBeenCalledWith(TRAVEL_CONSULTANT, BOOKING_ID);
  });

  it('returns 403 BOOKING_FORBIDDEN (never 404) when an unassigned TRAVEL_CONSULTANT requests a Booking that either does not exist or is not theirs', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.getBookingById.mockRejectedValue(
      new BookingError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toEqual({
      error: { code: 'BOOKING_FORBIDDEN', message: 'Booking not found or not accessible.' },
    });
  });

  it('returns 404 BOOKING_NOT_FOUND for ADMIN_MANAGER when the Booking genuinely does not exist', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getBookingById.mockRejectedValue(
      new BookingError('BOOKING_NOT_FOUND', 'Booking not found.'),
    );

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(404);
  });
});
