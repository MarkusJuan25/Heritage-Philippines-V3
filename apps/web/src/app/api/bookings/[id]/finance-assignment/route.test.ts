import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  setBookingFinanceAssignment: vi.fn(),
  endBookingFinanceAssignment: vi.fn(),
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
const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const FINANCE_ID = '11111111-1111-4111-8111-111111111111';

function request(method: 'PUT' | 'DELETE', body: unknown): Request {
  return new Request(`http://localhost/api/bookings/${BOOKING_ID}/finance-assignment`, {
    method,
    body: JSON.stringify(body),
  });
}

function context(id = BOOKING_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/bookings/[id]/finance-assignment', () => {
  it('returns 401 without a session', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await PUT(request('PUT', { assignedStaffId: FINANCE_ID }), context());
    expect(response.status).toBe(401);
    expect(serviceMocks.setBookingFinanceAssignment).not.toHaveBeenCalled();
  });

  it.each([
    'SYSTEM_ADMINISTRATOR',
    'TRAVEL_CONSULTANT',
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'CLIENT',
  ])('returns 403 for %s, never calling the service', async (role) => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });
    const response = await PUT(request('PUT', { assignedStaffId: FINANCE_ID }), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.setBookingFinanceAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-UUID booking id', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await PUT(request('PUT', { assignedStaffId: FINANCE_ID }), context('x'));
    expect(response.status).toBe(400);
    expect(serviceMocks.setBookingFinanceAssignment).not.toHaveBeenCalled();
  });

  it('sets or replaces the assignment through the service, passing the reason', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setBookingFinanceAssignment.mockResolvedValue({ id: 'assignment-1' });

    const response = await PUT(
      request('PUT', { assignedStaffId: FINANCE_ID, reason: 'Ben on leave' }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assignment: { id: 'assignment-1' } });
    expect(serviceMocks.setBookingFinanceAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-1', role: 'ADMIN_MANAGER' }),
      BOOKING_ID,
      FINANCE_ID,
      'Ben on leave',
    );
  });

  it('maps an AssignmentError to its code and status', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.setBookingFinanceAssignment.mockRejectedValue(
      new AssignmentError('ASSIGNEE_INELIGIBLE_ROLE', 'The assignee must be Finance/Accounting.'),
    );
    const response = await PUT(request('PUT', { assignedStaffId: FINANCE_ID }), context());
    const json = await response.json();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(json.error.code).toBe('ASSIGNEE_INELIGIBLE_ROLE');
  });
});

describe('DELETE /api/bookings/[id]/finance-assignment', () => {
  it.each(['TRAVEL_CONSULTANT', 'FINANCE_ACCOUNTING'])(
    'returns 403 for %s, never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });
      const response = await DELETE(request('DELETE', { reason: 'r' }), context());
      expect(response.status).toBe(403);
      expect(serviceMocks.endBookingFinanceAssignment).not.toHaveBeenCalled();
    },
  );

  it('requires a reason before calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await DELETE(request('DELETE', {}), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.endBookingFinanceAssignment).not.toHaveBeenCalled();
  });

  it('ends the assignment with the reason, returning null when none was active', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.endBookingFinanceAssignment.mockResolvedValue(null);
    const response = await DELETE(request('DELETE', { reason: 'Trip settled' }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assignment: null });
    expect(serviceMocks.endBookingFinanceAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN_MANAGER' }),
      BOOKING_ID,
      'Trip settled',
    );
  });
});
