import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  createBooking: vi.fn(),
  listBookings: vi.fn(),
}));
vi.mock('@/features/bookings/service', () => serviceMocks);

import { BookingError } from '@/features/bookings/errors';

import { GET, POST } from './route';

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

const PROPOSAL_VERSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/bookings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/bookings${query}`, { method: 'GET' });
}

// This route has no dynamic segments, but Next.js's App Router (and this
// project's `withRole` wrapper, see @/lib/auth/guards.ts) still passes a
// `{ params: Promise<{}> }` context as the handler's second argument for
// every route, dynamic or not.
function context(): { params: Promise<Record<string, never>> } {
  return { params: Promise.resolve({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/bookings', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest({ proposalVersionId: PROPOSAL_VERSION_ID }), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.createBooking).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await POST(
        postRequest({ proposalVersionId: PROPOSAL_VERSION_ID }),
        context(),
      );

      expect(response.status).toBe(403);
      expect(serviceMocks.createBooking).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a missing/invalid proposalVersionId, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({ proposalVersionId: 'not-a-uuid' }), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createBooking).not.toHaveBeenCalled();
  });

  it('returns 400 when the body includes a caller-supplied bookingReference, and never calls the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({
        proposalVersionId: PROPOSAL_VERSION_ID,
        bookingReference: 'CALLER-SUPPLIED',
      }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createBooking).not.toHaveBeenCalled();
  });

  it('returns 400 for any other unrecognized property in the body, and never calls the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({ proposalVersionId: PROPOSAL_VERSION_ID, status: 'CONFIRMED' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createBooking).not.toHaveBeenCalled();
  });

  it('accepts a body containing only proposalVersionId (the strict boundary does not reject the valid shape)', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const booking = { id: 'booking-1' };
    serviceMocks.createBooking.mockResolvedValue({ booking, created: true });

    const response = await POST(postRequest({ proposalVersionId: PROPOSAL_VERSION_ID }), context());

    expect(response.status).toBe(201);
    expect(serviceMocks.createBooking).toHaveBeenCalledWith(ADMIN_MANAGER, {
      proposalVersionId: PROPOSAL_VERSION_ID,
    });
  });

  it('returns 201 with the created Booking for ADMIN_MANAGER when a new Booking is created', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const booking = { id: 'booking-1', bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD' };
    serviceMocks.createBooking.mockResolvedValue({ booking, created: true });

    const response = await POST(postRequest({ proposalVersionId: PROPOSAL_VERSION_ID }), context());
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json).toEqual({ booking });
    expect(serviceMocks.createBooking).toHaveBeenCalledWith(ADMIN_MANAGER, {
      proposalVersionId: PROPOSAL_VERSION_ID,
    });
  });

  it('returns 201 for an assigned TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    const booking = { id: 'booking-1' };
    serviceMocks.createBooking.mockResolvedValue({ booking, created: true });

    const response = await POST(postRequest({ proposalVersionId: PROPOSAL_VERSION_ID }), context());

    expect(response.status).toBe(201);
    expect(serviceMocks.createBooking).toHaveBeenCalledWith(TRAVEL_CONSULTANT, {
      proposalVersionId: PROPOSAL_VERSION_ID,
    });
  });

  it('returns 200 (not 201) with the existing Booking for an idempotent replay', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const booking = { id: 'booking-1' };
    serviceMocks.createBooking.mockResolvedValue({ booking, created: false });

    const response = await POST(postRequest({ proposalVersionId: PROPOSAL_VERSION_ID }), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ booking });
  });

  it('translates a BookingError into the standard error envelope', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.createBooking.mockRejectedValue(
      new BookingError(
        'PROPOSAL_VERSION_FORBIDDEN',
        'Proposal version not found or not accessible.',
      ),
    );

    const response = await POST(postRequest({ proposalVersionId: PROPOSAL_VERSION_ID }), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toEqual({
      error: {
        code: 'PROPOSAL_VERSION_FORBIDDEN',
        message: 'Proposal version not found or not accessible.',
      },
    });
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.createBooking.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(postRequest({ proposalVersionId: PROPOSAL_VERSION_ID }), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});

describe('GET /api/bookings', () => {
  it('returns 403 for CLIENT', async () => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role: 'CLIENT' } });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.listBookings).not.toHaveBeenCalled();
  });

  it('returns the actor-scoped paginated list for ADMIN_MANAGER', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const result = { items: [{ id: 'booking-1' }], page: 1, pageSize: 20, total: 1 };
    serviceMocks.listBookings.mockResolvedValue(result);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(serviceMocks.listBookings).toHaveBeenCalledWith(ADMIN_MANAGER, {
      page: 1,
      pageSize: 20,
    });
  });

  it('parses page/pageSize query params', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.listBookings.mockResolvedValue({ items: [], page: 2, pageSize: 5, total: 0 });

    await GET(getRequest('?page=2&pageSize=5'), context());

    expect(serviceMocks.listBookings).toHaveBeenCalledWith(TRAVEL_CONSULTANT, {
      page: 2,
      pageSize: 5,
    });
  });

  it('returns 400 for an invalid pageSize', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest('?pageSize=1000'), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.listBookings).not.toHaveBeenCalled();
  });
});
