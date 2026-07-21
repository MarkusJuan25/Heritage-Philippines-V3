import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  deactivateStaffAccount: vi.fn(),
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

function postRequest(body: unknown): Request {
  return new Request(`http://localhost/api/staff/${STAFF_ID}/deactivate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function context(id = STAFF_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/staff/[id]/deactivate', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest({ reason: 'No longer with the company' }), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.deactivateStaffAccount).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)(
    'returns 403 for a non-SYSTEM_ADMINISTRATOR caller (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...SYSTEM_ADMINISTRATOR, role } });

      const response = await POST(postRequest({ reason: 'No longer with the company' }), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.deactivateStaffAccount).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await POST(
      postRequest({ reason: 'No longer with the company' }),
      context('not-a-uuid'),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.deactivateStaffAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const request = new Request(`http://localhost/api/staff/${STAFF_ID}/deactivate`, {
      method: 'POST',
      body: '{not valid json',
    });

    const response = await POST(request, context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.deactivateStaffAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing reason, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await POST(postRequest({}), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.deactivateStaffAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for a blank (whitespace-only) reason, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await POST(postRequest({ reason: '   ' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.deactivateStaffAccount).not.toHaveBeenCalled();
  });

  it('returns 200 and forwards actor/id/reason to deactivateStaffAccount', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const account = { id: STAFF_ID, isActive: false };
    serviceMocks.deactivateStaffAccount.mockResolvedValue(account);

    const response = await POST(postRequest({ reason: 'No longer with the company' }), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ account });
    expect(serviceMocks.deactivateStaffAccount).toHaveBeenCalledWith(
      SYSTEM_ADMINISTRATOR,
      STAFF_ID,
      'No longer with the company',
    );
  });

  it('translates a StaffManagementError (SELF_ACTION_FORBIDDEN) into the standard envelope', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.deactivateStaffAccount.mockRejectedValue(
      new StaffManagementError(
        'SELF_ACTION_FORBIDDEN',
        'You cannot perform this action on your own account.',
      ),
    );

    const response = await POST(postRequest({ reason: 'No longer with the company' }), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toEqual({
      error: {
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot perform this action on your own account.',
      },
    });
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.deactivateStaffAccount.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(postRequest({ reason: 'No longer with the company' }), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
