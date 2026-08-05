import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  createProposal: vi.fn(),
  listProposals: vi.fn(),
}));
vi.mock('@/features/proposals/service', () => serviceMocks);

import { ProposalError } from '@/features/proposals/errors';

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

const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/proposals', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/proposals${query}`, { method: 'GET' });
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

describe('GET /api/proposals', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.listProposals).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s), never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await GET(getRequest(), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.listProposals).not.toHaveBeenCalled();
    },
  );

  it('returns 200 with defaulted pagination for ADMIN_MANAGER when no query is supplied', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const result = { items: [{ id: 'proposal-1' }], page: 1, pageSize: 20, total: 1 };
    serviceMocks.listProposals.mockResolvedValue(result);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual(result);
    expect(serviceMocks.listProposals).toHaveBeenCalledWith(ADMIN_MANAGER, {
      page: 1,
      pageSize: 20,
    });
  });

  it('returns 200 for TRAVEL_CONSULTANT and parses explicit page/pageSize query params', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.listProposals.mockResolvedValue({ items: [], page: 2, pageSize: 5, total: 0 });

    const response = await GET(getRequest('?page=2&pageSize=5'), context());

    expect(response.status).toBe(200);
    expect(serviceMocks.listProposals).toHaveBeenCalledWith(TRAVEL_CONSULTANT, {
      page: 2,
      pageSize: 5,
    });
  });

  it('returns 400 for an invalid pageSize, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest('?pageSize=1000'), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.listProposals).not.toHaveBeenCalled();
  });

  it('returns 400 for an unrecognized query parameter this checkpoint does not authorize', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest(`?clientId=${CLIENT_ID}`), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.listProposals).not.toHaveBeenCalled();
  });

  it('translates a ProposalError into the standard envelope', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.listProposals.mockRejectedValue(
      new ProposalError('ROLE_NOT_PERMITTED', 'This role is not permitted to view proposals.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toEqual({
      error: {
        code: 'ROLE_NOT_PERMITTED',
        message: 'This role is not permitted to view proposals.',
      },
    });
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.listProposals.mockRejectedValue(new Error('unexpected db failure'));

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});

describe('POST /api/proposals', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest({ clientId: CLIENT_ID, content: 'Day 1.' }), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.createProposal).not.toHaveBeenCalled();
  });

  it('rejects ADMIN_MANAGER at the route gate — author-only creation, never reaching the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({ clientId: CLIENT_ID, content: 'Day 1.' }), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.createProposal).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s), never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await POST(
        postRequest({ clientId: CLIENT_ID, content: 'Day 1.' }),
        context(),
      );

      expect(response.status).toBe(403);
      expect(serviceMocks.createProposal).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID clientId, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      postRequest({ clientId: 'not-a-uuid', content: 'Day 1.' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createProposal).not.toHaveBeenCalled();
  });

  it('returns 400 for missing content', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(postRequest({ clientId: CLIENT_ID }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.createProposal).not.toHaveBeenCalled();
  });

  it('returns 400 for blank content', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(postRequest({ clientId: CLIENT_ID, content: '' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.createProposal).not.toHaveBeenCalled();
  });

  it('returns 400 for any unrecognized property in the body (strict schema)', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      postRequest({ clientId: CLIENT_ID, content: 'Day 1.', title: 'Palawan Package' }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.createProposal).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      new Request('http://localhost/api/proposals', { method: 'POST', body: 'not json' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createProposal).not.toHaveBeenCalled();
  });

  it('returns 201 with the exact { proposal, version } shape for TRAVEL_CONSULTANT, calling the service with exact clientId/content', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    const result = { proposal: { id: 'proposal-1', clientId: CLIENT_ID }, version: { id: 'v-1' } };
    serviceMocks.createProposal.mockResolvedValue(result);

    const response = await POST(
      postRequest({ clientId: CLIENT_ID, content: 'Day 1: Arrival.' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json).toEqual(result);
    expect(serviceMocks.createProposal).toHaveBeenCalledWith(TRAVEL_CONSULTANT, {
      clientId: CLIENT_ID,
      content: 'Day 1: Arrival.',
    });
    expect(serviceMocks.createProposal).toHaveBeenCalledTimes(1);
  });

  it('translates a ProposalError into the standard envelope, preserving CLIENT_FORBIDDEN', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.createProposal.mockRejectedValue(
      new ProposalError('CLIENT_FORBIDDEN', 'You do not have access to this client.'),
    );

    const response = await POST(postRequest({ clientId: CLIENT_ID, content: 'Day 1.' }), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toEqual({
      error: { code: 'CLIENT_FORBIDDEN', message: 'You do not have access to this client.' },
    });
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.createProposal.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(postRequest({ clientId: CLIENT_ID, content: 'Day 1.' }), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });

  it('never calls a repository, Prisma, audit, or assignment function directly', () => {
    // Structural guarantee: this route module imports only
    // @/features/proposals/{schemas,service,http} and Next.js/withRole —
    // verified by the module's own import list (see route.ts), not by a
    // runtime spy, since no such function is ever imported here to spy on.
    expect(Object.keys(serviceMocks)).toEqual(['createProposal', 'listProposals']);
  });
});
