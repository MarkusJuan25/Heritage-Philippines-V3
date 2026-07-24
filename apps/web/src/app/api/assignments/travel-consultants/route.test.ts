import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  listEligibleTravelConsultants: vi.fn(),
}));
vi.mock('@/features/assignments/service', () => serviceMocks);

import { AssignmentError } from '@/features/assignments/errors';

import { GET } from './route';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};

const REJECTED_ROLES = [
  'SYSTEM_ADMINISTRATOR',
  'TRAVEL_CONSULTANT',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
];

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/assignments/travel-consultants${query}`, {
    method: 'GET',
  });
}

function context(): { params: Promise<Record<string, never>> } {
  return { params: Promise.resolve({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/assignments/travel-consultants', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.listEligibleTravelConsultants).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)('returns 403 for a rejected role (%s)', async (role) => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.listEligibleTravelConsultants).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid pageSize, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest('?pageSize=1000'), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.listEligibleTravelConsultants).not.toHaveBeenCalled();
  });

  it('forwards default pagination when no query params are given', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const result = { items: [], page: 1, pageSize: 20, total: 0 };
    serviceMocks.listEligibleTravelConsultants.mockResolvedValue(result);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(serviceMocks.listEligibleTravelConsultants).toHaveBeenCalledWith(ADMIN_MANAGER, {
      page: 1,
      pageSize: 20,
    });
  });

  it('parses and forwards search/page/pageSize query params', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const result = {
      items: [{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }],
      page: 2,
      pageSize: 5,
      total: 1,
    };
    serviceMocks.listEligibleTravelConsultants.mockResolvedValue(result);

    const response = await GET(getRequest('?search=maria&page=2&pageSize=5'), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(serviceMocks.listEligibleTravelConsultants).toHaveBeenCalledWith(ADMIN_MANAGER, {
      search: 'maria',
      page: 2,
      pageSize: 5,
    });
  });

  it('translates an AssignmentError into the standard error envelope', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.listEligibleTravelConsultants.mockRejectedValue(
      new AssignmentError('ROLE_NOT_PERMITTED', 'This role is not permitted.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error.code).toBe('ROLE_NOT_PERMITTED');
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.listEligibleTravelConsultants.mockRejectedValue(
      new Error('unexpected db failure'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
