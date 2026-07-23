import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  getLeadById: vi.fn(),
  updateLead: vi.fn(),
}));
vi.mock('@/features/leads/service', () => serviceMocks);

import { LeadError } from '@/features/leads/errors';

import { GET, PATCH } from './route';

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

function getRequest(): Request {
  return new Request(`http://localhost/api/leads/${LEAD_ID}`, { method: 'GET' });
}

function patchRequest(body: unknown): Request {
  return new Request(`http://localhost/api/leads/${LEAD_ID}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function context(id = LEAD_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/leads/[id]', () => {
  it('returns 401 with no session', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(401);
  });

  it('returns 403 for CLIENT', async () => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role: 'CLIENT' } });
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.getLeadById).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed id', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await GET(getRequest(), context('not-a-uuid'));
    expect(response.status).toBe(400);
    expect(serviceMocks.getLeadById).not.toHaveBeenCalled();
  });

  it('returns 200 with the Lead when authorized', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const lead = { id: LEAD_ID };
    serviceMocks.getLeadById.mockResolvedValue(lead);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ lead });
    expect(serviceMocks.getLeadById).toHaveBeenCalledWith(ADMIN_MANAGER, LEAD_ID);
  });

  it('returns the identical 403 LEAD_FORBIDDEN for a TRAVEL_CONSULTANT whether the Lead is missing or inaccessible', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.getLeadById.mockRejectedValue(
      new LeadError('LEAD_FORBIDDEN', 'Lead not found or not accessible.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error.code).toBe('LEAD_FORBIDDEN');
  });

  it('returns 404 LEAD_NOT_FOUND for ADMIN_MANAGER on a genuinely missing Lead', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getLeadById.mockRejectedValue(new LeadError('LEAD_NOT_FOUND', 'Lead not found.'));

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/leads/[id]', () => {
  it('returns 403 for a rejected role', async () => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role: 'FINANCE_ACCOUNTING' } });
    const response = await PATCH(patchRequest({ fullName: 'New Name' }), context());
    expect(response.status).toBe(403);
    expect(serviceMocks.updateLead).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown property', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await PATCH(patchRequest({ nickname: 'nope' }), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.updateLead).not.toHaveBeenCalled();
  });

  it('returns 200 with only { lead } when the patch did not touch email/phone', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const lead = { id: LEAD_ID, fullName: 'New Name' };
    serviceMocks.updateLead.mockResolvedValue({ lead });

    const response = await PATCH(patchRequest({ fullName: 'New Name' }), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ lead });
  });

  it('returns 200 with duplicate fields when the patch touched email', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const lead = { id: LEAD_ID, email: 'new@example.com' };
    serviceMocks.updateLead.mockResolvedValue({
      lead,
      duplicateMatches: [],
      restrictedMatchDetected: false,
    });

    const response = await PATCH(patchRequest({ email: 'new@example.com' }), context());
    const json = await response.json();

    expect(json).toEqual({ lead, duplicateMatches: [], restrictedMatchDetected: false });
  });

  it('returns 409 LEAD_LOCKED for a converted Lead', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateLead.mockRejectedValue(
      new LeadError(
        'LEAD_LOCKED',
        'This lead has been converted to a client and can no longer be edited.',
      ),
    );

    const response = await PATCH(patchRequest({ fullName: 'New Name' }), context());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error.code).toBe('LEAD_LOCKED');
  });
});
