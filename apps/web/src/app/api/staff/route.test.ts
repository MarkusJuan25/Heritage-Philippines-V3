import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  listStaffAccounts: vi.fn(),
  createStaffAccount: vi.fn(),
}));
vi.mock('@/features/staff/service', () => serviceMocks);

import { StaffManagementError } from '@/features/staff/errors';

import { GET, POST } from './route';

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

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/staff${query}`, { method: 'GET' });
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/staff', {
    method: 'POST',
    body: JSON.stringify(body),
  });
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

describe('GET /api/staff', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.listStaffAccounts).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)(
    'returns 403 for a non-SYSTEM_ADMINISTRATOR caller (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...SYSTEM_ADMINISTRATOR, role } });

      const response = await GET(getRequest(), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.listStaffAccounts).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for an invalid pageSize, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await GET(getRequest('?pageSize=1000'), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.listStaffAccounts).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid role filter, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await GET(getRequest('?role=NOT_A_ROLE'), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.listStaffAccounts).not.toHaveBeenCalled();
  });

  it('forwards default pagination when no query params are given', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const result = { items: [], page: 1, pageSize: 20, total: 0 };
    serviceMocks.listStaffAccounts.mockResolvedValue(result);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(serviceMocks.listStaffAccounts).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it('parses and forwards role/isActive/search/page/pageSize query params', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const result = { items: [{ id: 'staff-1' }], page: 2, pageSize: 5, total: 1 };
    serviceMocks.listStaffAccounts.mockResolvedValue(result);

    const response = await GET(
      getRequest('?role=TRAVEL_CONSULTANT&isActive=true&search=maria&page=2&pageSize=5'),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(serviceMocks.listStaffAccounts).toHaveBeenCalledWith({
      role: 'TRAVEL_CONSULTANT',
      isActive: true,
      search: 'maria',
      page: 2,
      pageSize: 5,
    });
  });
});

describe('POST /api/staff', () => {
  const VALID_BODY = {
    name: 'Maria Santos',
    email: 'maria.santos@example.test',
    role: 'TRAVEL_CONSULTANT',
  };

  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest(VALID_BODY), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.createStaffAccount).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)(
    'returns 403 for a non-SYSTEM_ADMINISTRATOR caller (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...SYSTEM_ADMINISTRATOR, role } });

      const response = await POST(postRequest(VALID_BODY), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.createStaffAccount).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for malformed JSON, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const request = new Request('http://localhost/api/staff', {
      method: 'POST',
      body: '{not valid json',
    });

    const response = await POST(request, context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createStaffAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing required field, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await POST(
      postRequest({ email: 'maria.santos@example.test', role: 'TRAVEL_CONSULTANT' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createStaffAccount).not.toHaveBeenCalled();
  });

  it('returns 400 for role: CLIENT, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });

    const response = await POST(postRequest({ ...VALID_BODY, role: 'CLIENT' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.createStaffAccount).not.toHaveBeenCalled();
  });

  it('calls createStaffAccount with the actor and the validated (trimmed/lowercased) input', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    const account = { id: 'staff-1', ...VALID_BODY, isActive: true };
    serviceMocks.createStaffAccount.mockResolvedValue({
      account,
      initialPassword: 'generated-password',
    });

    const response = await POST(
      postRequest({ ...VALID_BODY, email: '  Maria.Santos@Example.TEST  ' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json).toEqual({ account, initialPassword: 'generated-password' });
    expect(serviceMocks.createStaffAccount).toHaveBeenCalledWith(SYSTEM_ADMINISTRATOR, {
      name: 'Maria Santos',
      email: 'maria.santos@example.test',
      role: 'TRAVEL_CONSULTANT',
    });
  });

  it('translates a StaffManagementError into the standard error envelope', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.createStaffAccount.mockRejectedValue(
      new StaffManagementError(
        'EMAIL_ALREADY_EXISTS',
        'An account with this email address already exists.',
      ),
    );

    const response = await POST(postRequest(VALID_BODY), context());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json).toEqual({
      error: {
        code: 'EMAIL_ALREADY_EXISTS',
        message: 'An account with this email address already exists.',
      },
    });
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: SYSTEM_ADMINISTRATOR });
    serviceMocks.createStaffAccount.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(postRequest(VALID_BODY), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
