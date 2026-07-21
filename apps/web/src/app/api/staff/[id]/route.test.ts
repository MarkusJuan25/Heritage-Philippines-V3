import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  getStaffAccountById: vi.fn(),
  changeStaffRole: vi.fn(),
}));
vi.mock('@/features/staff/service', () => serviceMocks);

import { StaffManagementError } from '@/features/staff/errors';

import { GET, PATCH } from './route';

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

function getRequest(): Request {
  return new Request(`http://localhost/api/staff/${STAFF_ID}`, { method: 'GET' });
}

function patchRequest(body: unknown): Request {
  return new Request(`http://localhost/api/staff/${STAFF_ID}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function context(id = STAFF_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/staff/[id]', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.getStaffAccountById).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)(
    'returns 403 for a non-SYSTEM_ADMINISTRATOR caller (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...SYSTEM_ADMINISTRATOR, role } });

      const response = await GET(getRequest(), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.getStaffAccountById).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await GET(getRequest(), context('not-a-uuid'));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.getStaffAccountById).not.toHaveBeenCalled();
  });

  it('returns 200 with the account for a valid id', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const account = { id: STAFF_ID, name: 'Maria Santos', role: 'TRAVEL_CONSULTANT' };
    serviceMocks.getStaffAccountById.mockResolvedValue(account);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ account });
    expect(serviceMocks.getStaffAccountById).toHaveBeenCalledWith(STAFF_ID);
  });

  it('translates a StaffManagementError (STAFF_ACCOUNT_NOT_FOUND) into the standard envelope', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.getStaffAccountById.mockRejectedValue(
      new StaffManagementError('STAFF_ACCOUNT_NOT_FOUND', 'Staff account not found.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json).toEqual({
      error: { code: 'STAFF_ACCOUNT_NOT_FOUND', message: 'Staff account not found.' },
    });
  });
});

describe('PATCH /api/staff/[id]', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ role: 'FINANCE_ACCOUNTING' }), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.changeStaffRole).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)(
    'returns 403 for a non-SYSTEM_ADMINISTRATOR caller (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...SYSTEM_ADMINISTRATOR, role } });

      const response = await PATCH(patchRequest({ role: 'FINANCE_ACCOUNTING' }), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.changeStaffRole).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await PATCH(
      patchRequest({ role: 'FINANCE_ACCOUNTING' }),
      context('not-a-uuid'),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.changeStaffRole).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing role, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await PATCH(patchRequest({}), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.changeStaffRole).not.toHaveBeenCalled();
  });

  it('returns 400 for role: CLIENT, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await PATCH(patchRequest({ role: 'CLIENT' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.changeStaffRole).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid role value, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await PATCH(patchRequest({ role: 'NOT_A_REAL_ROLE' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.changeStaffRole).not.toHaveBeenCalled();
  });

  it('returns 200 and forwards actor/id/role to changeStaffRole', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const account = { id: STAFF_ID, role: 'FINANCE_ACCOUNTING' };
    serviceMocks.changeStaffRole.mockResolvedValue(account);

    const response = await PATCH(patchRequest({ role: 'FINANCE_ACCOUNTING' }), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ account });
    expect(serviceMocks.changeStaffRole).toHaveBeenCalledWith(
      SYSTEM_ADMINISTRATOR,
      STAFF_ID,
      'FINANCE_ACCOUNTING',
    );
  });

  it('translates a StaffManagementError (LAST_ADMINISTRATOR_PROTECTED) into the standard envelope', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.changeStaffRole.mockRejectedValue(
      new StaffManagementError(
        'LAST_ADMINISTRATOR_PROTECTED',
        'This action would leave no active System Administrator account. Promote another account to System Administrator first.',
      ),
    );

    const response = await PATCH(patchRequest({ role: 'FINANCE_ACCOUNTING' }), context());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error.code).toBe('LAST_ADMINISTRATOR_PROTECTED');
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.changeStaffRole.mockRejectedValue(new Error('unexpected db failure'));

    const response = await PATCH(patchRequest({ role: 'FINANCE_ACCOUNTING' }), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
