import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  getLeadStatusHistory: vi.fn(),
}));
vi.mock('@/features/leads/service', () => serviceMocks);

import { LeadError } from '@/features/leads/errors';

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

const LEAD_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/leads/${LEAD_ID}/status-history${query}`, {
    method: 'GET',
  });
}

function context(id = LEAD_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/leads/[id]/status-history', () => {
  it('returns 401 with no session', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(401);
    expect(serviceMocks.getLeadStatusHistory).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });
      const response = await GET(getRequest(), context());
      expect(response.status).toBe(403);
      expect(serviceMocks.getLeadStatusHistory).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a malformed id', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await GET(getRequest(), context('not-a-uuid'));
    expect(response.status).toBe(400);
    expect(serviceMocks.getLeadStatusHistory).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid pageSize, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await GET(getRequest('?pageSize=1000'), context());
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.getLeadStatusHistory).not.toHaveBeenCalled();
  });

  it('forwards default pagination when no query params are given', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const result = { items: [], page: 1, pageSize: 20, total: 0 };
    serviceMocks.getLeadStatusHistory.mockResolvedValue(result);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(serviceMocks.getLeadStatusHistory).toHaveBeenCalledWith(ADMIN_MANAGER, LEAD_ID, {
      page: 1,
      pageSize: 20,
    });
  });

  it('parses and forwards page/pageSize query params', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.getLeadStatusHistory.mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 5,
      total: 0,
    });

    await GET(getRequest('?page=2&pageSize=5'), context());

    expect(serviceMocks.getLeadStatusHistory).toHaveBeenCalledWith(TRAVEL_CONSULTANT, LEAD_ID, {
      page: 2,
      pageSize: 5,
    });
  });

  it('returns 200 with the exact D-023 §8 item shape', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const result = {
      items: [
        {
          id: 'history-1',
          previousStatus: null,
          newStatus: 'NEW',
          changedByUserId: 'actor-1',
          changedByName: 'Admin Manager',
          createdAt: '2026-07-23T00:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    };
    serviceMocks.getLeadStatusHistory.mockResolvedValue(result);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
  });

  it('returns the identical 403 LEAD_FORBIDDEN for a TRAVEL_CONSULTANT whether the Lead is missing or inaccessible', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.getLeadStatusHistory.mockRejectedValue(
      new LeadError('LEAD_FORBIDDEN', 'Lead not found or not accessible.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error.code).toBe('LEAD_FORBIDDEN');
  });

  it('returns 404 LEAD_NOT_FOUND for ADMIN_MANAGER on a genuinely missing Lead', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getLeadStatusHistory.mockRejectedValue(
      new LeadError('LEAD_NOT_FOUND', 'Lead not found.'),
    );

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(404);
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getLeadStatusHistory.mockRejectedValue(new Error('unexpected db failure'));

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
