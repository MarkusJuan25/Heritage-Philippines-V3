import { beforeEach, describe, expect, it, vi } from 'vitest';

// `withRole` (guards.ts) reads the session through `./auth`, which eagerly
// constructs a real Better Auth/Prisma client at import time — mock it
// before the route module is imported, the same technique every other Lead
// route test in this codebase uses.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({ convertLead: vi.fn() }));
vi.mock('@/features/leads/service', () => serviceMocks);

import { LeadError } from '@/features/leads/errors';

import { POST } from './route';

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
const CLIENT_ID = '4fa85f64-5717-4562-b3fc-2c963f66afa6';

// The mutation-style, assignment-free LeadRecord shape (D-024 §9) —
// deliberately no `assignment` key, unlike GET /api/leads/[id]'s richer
// LeadRecordWithAssignment.
const CONVERTED_LEAD = {
  id: LEAD_ID,
  status: 'CONVERTED_TO_CLIENT',
  fullName: 'Juan Dela Cruz',
  email: 'juan@example.com',
  phone: null,
  normalizedEmail: 'juan@example.com',
  normalizedPhone: null,
  source: 'Walk-in',
  notes: null,
  clientId: 'client-1',
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
};

function postRequest(body: unknown): Request {
  return new Request(`http://localhost/api/leads/${LEAD_ID}/conversion`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function rawPostRequest(rawBody: string): Request {
  return new Request(`http://localhost/api/leads/${LEAD_ID}/conversion`, {
    method: 'POST',
    body: rawBody,
  });
}

function context(id: string = LEAD_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/leads/[id]/conversion', () => {
  it('returns 401 when there is no authenticated session, without calling the service', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest({ expectedStatus: 'QUALIFIED' }), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.convertLead).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s), without calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await POST(postRequest({ expectedStatus: 'QUALIFIED' }), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.convertLead).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for malformed JSON, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(rawPostRequest('{not valid json'), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.convertLead).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty body, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({}), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.convertLead).not.toHaveBeenCalled();
  });

  it('returns 400 when expectedStatus is missing, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({ clientId: CLIENT_ID }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.convertLead).not.toHaveBeenCalled();
  });

  it('returns 400 when expectedStatus is not the QUALIFIED literal, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({ expectedStatus: 'NEW' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.convertLead).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed clientId UUID, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({ expectedStatus: 'QUALIFIED', clientId: 'not-a-uuid' }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.convertLead).not.toHaveBeenCalled();
  });

  it('returns 400 for an unknown request property, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({ expectedStatus: 'QUALIFIED', reason: 'not accepted' }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.convertLead).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid lead id param, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({ expectedStatus: 'QUALIFIED' }),
      context('not-a-uuid'),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.convertLead).not.toHaveBeenCalled();
  });

  it('returns 200 with the exact, assignment-free create-new response', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.convertLead.mockResolvedValue({
      lead: CONVERTED_LEAD,
      client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
      clientCreated: true,
    });

    const response = await POST(postRequest({ expectedStatus: 'QUALIFIED' }), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      lead: CONVERTED_LEAD,
      client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
      clientCreated: true,
    });
    expect(Object.keys(json).sort()).toEqual(['client', 'clientCreated', 'lead']);
    expect(json.lead).not.toHaveProperty('assignment');
  });

  it('returns 200 with clientCreated: false for a successful link-existing request', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.convertLead.mockResolvedValue({
      lead: { ...CONVERTED_LEAD, clientId: CLIENT_ID },
      client: { id: CLIENT_ID, fullName: 'Maria' },
      clientCreated: false,
    });

    const response = await POST(
      postRequest({ expectedStatus: 'QUALIFIED', clientId: CLIENT_ID }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.clientCreated).toBe(false);
    expect(json.client).toEqual({ id: CLIENT_ID, fullName: 'Maria' });
    expect(json.lead).not.toHaveProperty('assignment');
  });

  it('passes the exact authenticated actor, Lead id, and parsed input to the service', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.convertLead.mockResolvedValue({
      lead: CONVERTED_LEAD,
      client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
      clientCreated: true,
    });

    await POST(postRequest({ expectedStatus: 'QUALIFIED', clientId: CLIENT_ID }), context());

    expect(serviceMocks.convertLead).toHaveBeenCalledTimes(1);
    expect(serviceMocks.convertLead).toHaveBeenCalledWith(TRAVEL_CONSULTANT, LEAD_ID, {
      expectedStatus: 'QUALIFIED',
      clientId: CLIENT_ID,
    });
  });

  it.each([
    ['ROLE_NOT_PERMITTED', 403],
    ['LEAD_NOT_FOUND', 404],
    ['LEAD_FORBIDDEN', 403],
    ['CONVERSION_NOT_ELIGIBLE', 409],
    ['CLIENT_MATCH_REQUIRES_LINK', 409],
    ['CLIENT_LINK_NOT_AVAILABLE', 409],
    ['LEAD_CONFLICT', 409],
  ] as const)(
    'maps LeadError %s to status %i with the standard error envelope',
    async (code, status) => {
      getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
      serviceMocks.convertLead.mockRejectedValue(new LeadError(code, 'message'));

      const response = await POST(postRequest({ expectedStatus: 'QUALIFIED' }), context());
      const json = await response.json();

      expect(response.status).toBe(status);
      expect(json).toEqual({ error: { code, message: 'message' } });
    },
  );

  it('returns a generic 500 envelope, never a raw error, when the service throws unexpectedly', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.convertLead.mockRejectedValue(new Error('boom: internal detail'));

    const response = await POST(postRequest({ expectedStatus: 'QUALIFIED' }), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
    expect(JSON.stringify(json)).not.toContain('boom: internal detail');
  });
});
