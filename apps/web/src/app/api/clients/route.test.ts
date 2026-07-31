import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  listClients: vi.fn(),
}));
vi.mock('@/features/clients/service', () => serviceMocks);

import * as route from './route';
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

const PROHIBITED_ROLES = [
  'SYSTEM_ADMINISTRATOR',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
];

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/clients${query}`, { method: 'GET' });
}

function context(): { params: Promise<Record<string, never>> } {
  return { params: Promise.resolve({}) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/clients', () => {
  it('allows ADMIN_MANAGER', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.listClients.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(200);
    expect(serviceMocks.listClients).toHaveBeenCalled();
  });

  it('allows TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.listClients.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(200);
    expect(serviceMocks.listClients).toHaveBeenCalled();
  });

  it.each(PROHIBITED_ROLES)('rejects role %s before the service is ever called', async (role) => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.listClients).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.listClients).not.toHaveBeenCalled();
  });

  it('applies page/pageSize defaults', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.listClients.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    await GET(getRequest(), context());

    expect(serviceMocks.listClients).toHaveBeenCalledWith(ADMIN_MANAGER, {
      page: 1,
      pageSize: 20,
    });
  });

  it('coerces and forwards page/pageSize/search', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.listClients.mockResolvedValue({ items: [], page: 2, pageSize: 5, total: 0 });

    await GET(getRequest('?page=2&pageSize=5&search=juan'), context());

    expect(serviceMocks.listClients).toHaveBeenCalledWith(TRAVEL_CONSULTANT, {
      page: 2,
      pageSize: 5,
      search: 'juan',
    });
  });

  it('rejects a whitespace-only search value before calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest('?search=%20%20%20'), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.listClients).not.toHaveBeenCalled();
  });

  it('rejects an invalid pageSize before calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest('?pageSize=1000'), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.listClients).not.toHaveBeenCalled();
  });

  it('rejects an invalid page before calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest('?page=0'), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.listClients).not.toHaveBeenCalled();
  });

  it('returns exactly { items, page, pageSize, total }', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const result = { items: [{ id: 'client-1' }], page: 1, pageSize: 20, total: 1 };
    serviceMocks.listClients.mockResolvedValue(result);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(Object.keys(json).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
  });

  it('returns the sanitized generic INTERNAL_ERROR envelope for an unexpected service error, without leaking the thrown message', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.listClients.mockRejectedValue(
      new Error('unexpected db failure: password=hunter2'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('hunter2');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });

  it('does not export a POST handler', () => {
    expect((route as Record<string, unknown>).POST).toBeUndefined();
  });
});
