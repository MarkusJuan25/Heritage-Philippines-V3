import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  reactivateStaffAccount: vi.fn(),
}));
vi.mock('@/features/staff/service', () => serviceMocks);

import { StaffManagementError } from '@/features/staff/errors';

import { POST } from './route';

const SYSTEM_ADMINISTRATOR = {
  id: 'sysadmin-1',
  email: 'sysadmin@example.test',
  name: 'Sys Admin',
  role: 'SYSTEM_ADMINISTRATOR',
};

const REJECTED_ROLES = [
  'ADMIN_MANAGER',
  'TRAVEL_CONSULTANT',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
];

const STAFF_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function postRequest(): Request {
  return new Request(`http://localhost/api/staff/${STAFF_ID}/reactivate`, { method: 'POST' });
}

function context(id = STAFF_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/staff/[id]/reactivate', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.reactivateStaffAccount).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)(
    'returns 403 for a non-SYSTEM_ADMINISTRATOR caller (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...SYSTEM_ADMINISTRATOR, role } });

      const response = await POST(postRequest(), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.reactivateStaffAccount).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await POST(postRequest(), context('not-a-uuid'));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.reactivateStaffAccount).not.toHaveBeenCalled();
  });

  it('returns 200 and forwards actor/id to reactivateStaffAccount', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const account = { id: STAFF_ID, isActive: true };
    serviceMocks.reactivateStaffAccount.mockResolvedValue(account);

    const response = await POST(postRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ account });
    expect(serviceMocks.reactivateStaffAccount).toHaveBeenCalledWith(
      SYSTEM_ADMINISTRATOR,
      STAFF_ID,
    );
  });

  it('translates a StaffManagementError (STAFF_ACCOUNT_NOT_FOUND) into the standard envelope', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.reactivateStaffAccount.mockRejectedValue(
      new StaffManagementError('STAFF_ACCOUNT_NOT_FOUND', 'Staff account not found.'),
    );

    const response = await POST(postRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json).toEqual({
      error: { code: 'STAFF_ACCOUNT_NOT_FOUND', message: 'Staff account not found.' },
    });
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.reactivateStaffAccount.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(postRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
