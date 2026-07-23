import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  createLead: vi.fn(),
  listLeads: vi.fn(),
}));
vi.mock('@/features/leads/service', () => serviceMocks);

import { LeadError } from '@/features/leads/errors';

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

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/leads', { method: 'POST', body: JSON.stringify(body) });
}

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/leads${query}`, { method: 'GET' });
}

function context(): { params: Promise<Record<string, never>> } {
  return { params: Promise.resolve({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/leads', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(
      postRequest({ fullName: 'Juan', source: 'Walk-in', email: 'juan@example.com' }),
      context(),
    );

    expect(response.status).toBe(401);
    expect(serviceMocks.createLead).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s)',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await POST(
        postRequest({ fullName: 'Juan', source: 'Walk-in', email: 'juan@example.com' }),
        context(),
      );

      expect(response.status).toBe(403);
      expect(serviceMocks.createLead).not.toHaveBeenCalled();
    },
  );

  it('returns 400 when neither email nor phone is present', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({ fullName: 'Juan', source: 'Walk-in' }), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createLead).not.toHaveBeenCalled();
  });

  it('returns 400 when the body includes a caller-supplied status', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({
        fullName: 'Juan',
        source: 'Walk-in',
        email: 'juan@example.com',
        status: 'QUALIFIED',
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.createLead).not.toHaveBeenCalled();
  });

  it('returns 201 with the created Lead and duplicate fields for ADMIN_MANAGER', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const lead = { id: 'lead-1' };
    serviceMocks.createLead.mockResolvedValue({
      lead,
      duplicateMatches: [],
      restrictedMatchDetected: false,
    });

    const response = await POST(
      postRequest({ fullName: 'Juan', source: 'Walk-in', email: 'juan@example.com' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json).toEqual({ lead, duplicateMatches: [], restrictedMatchDetected: false });
    expect(serviceMocks.createLead).toHaveBeenCalledWith(ADMIN_MANAGER, {
      fullName: 'Juan',
      source: 'Walk-in',
      email: 'juan@example.com',
    });
  });

  it('returns 201 for an eligible TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.createLead.mockResolvedValue({
      lead: { id: 'lead-1' },
      duplicateMatches: [],
      restrictedMatchDetected: false,
    });

    const response = await POST(
      postRequest({ fullName: 'Juan', source: 'Phone inquiry', phone: '0917 123 4567' }),
      context(),
    );

    expect(response.status).toBe(201);
  });

  it('translates a LeadError into the standard error envelope', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.createLead.mockRejectedValue(
      new LeadError('VALIDATION_ERROR', 'A lead must retain at least one of email or phone.'),
    );

    const response = await POST(
      postRequest({ fullName: 'Juan', source: 'Walk-in', email: 'juan@example.com' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 500 with the generic envelope for an unexpected error', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.createLead.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(
      postRequest({ fullName: 'Juan', source: 'Walk-in', email: 'juan@example.com' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});

describe('GET /api/leads', () => {
  it('returns 403 for CLIENT', async () => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role: 'CLIENT' } });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.listLeads).not.toHaveBeenCalled();
  });

  it('returns the paginated list for ADMIN_MANAGER', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const result = { items: [{ id: 'lead-1' }], page: 1, pageSize: 20, total: 1 };
    serviceMocks.listLeads.mockResolvedValue(result);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(serviceMocks.listLeads).toHaveBeenCalledWith(ADMIN_MANAGER, { page: 1, pageSize: 20 });
  });

  it('parses status/source/search/page/pageSize query params', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.listLeads.mockResolvedValue({ items: [], page: 2, pageSize: 5, total: 0 });

    await GET(
      getRequest('?page=2&pageSize=5&status=QUALIFIED&source=Contact&search=juan'),
      context(),
    );

    expect(serviceMocks.listLeads).toHaveBeenCalledWith(TRAVEL_CONSULTANT, {
      page: 2,
      pageSize: 5,
      status: 'QUALIFIED',
      source: 'Contact',
      search: 'juan',
    });
  });

  it('returns 400 for an invalid pageSize', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest('?pageSize=1000'), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.listLeads).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid status filter', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest('?status=NOT_A_STATUS'), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.listLeads).not.toHaveBeenCalled();
  });
});
