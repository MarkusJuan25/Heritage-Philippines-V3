import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  getClientById: vi.fn(),
  updateClient: vi.fn(),
}));
vi.mock('@/features/clients/service', () => serviceMocks);

import { ClientError } from '@/features/clients/errors';

import * as route from './route';
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

const PROHIBITED_ROLES = [
  'SYSTEM_ADMINISTRATOR',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
];

const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const VALID_EXPECTED_UPDATED_AT = '2026-07-30T12:34:56.789Z';

function getRequest(): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}`, { method: 'GET' });
}

function patchRequest(body: unknown): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function malformedPatchRequest(): Request {
  return new Request(`http://localhost/api/clients/${CLIENT_ID}`, {
    method: 'PATCH',
    body: 'not json',
  });
}

function context(id = CLIENT_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/clients/[id]', () => {
  it('allows ADMIN_MANAGER', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getClientById.mockResolvedValue({ id: CLIENT_ID });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(200);
  });

  it('allows TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.getClientById.mockResolvedValue({ id: CLIENT_ID });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(200);
  });

  it.each(PROHIBITED_ROLES)('rejects role %s before the service is ever called', async (role) => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.getClientById).not.toHaveBeenCalled();
  });

  it('returns 401 with no session', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(401);
  });

  it('rejects an invalid UUID before calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest(), context('not-a-uuid'));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.getClientById).not.toHaveBeenCalled();
  });

  it('passes the authenticated user and the validated id to getClientById', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getClientById.mockResolvedValue({ id: CLIENT_ID });

    await GET(getRequest(), context());

    expect(serviceMocks.getClientById).toHaveBeenCalledWith(ADMIN_MANAGER, CLIENT_ID);
  });

  it('returns exactly { client }', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const client = { id: CLIENT_ID, fullName: 'Juan Dela Cruz' };
    serviceMocks.getClientById.mockResolvedValue(client);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ client });
    expect(Object.keys(json)).toEqual(['client']);
  });

  it('returns 404 CLIENT_NOT_FOUND for ADMIN_MANAGER on a genuinely missing Client', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getClientById.mockRejectedValue(
      new ClientError('CLIENT_NOT_FOUND', 'Client not found.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error.code).toBe('CLIENT_NOT_FOUND');
  });

  it('returns the identical 403 CLIENT_FORBIDDEN for a TRAVEL_CONSULTANT whether the Client is missing or inaccessible', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.getClientById.mockRejectedValue(
      new ClientError('CLIENT_FORBIDDEN', 'You do not have access to this client.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error.code).toBe('CLIENT_FORBIDDEN');
  });

  it('returns the sanitized generic INTERNAL_ERROR envelope for an unexpected error, without leaking the thrown message', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getClientById.mockRejectedValue(
      new Error('unexpected db failure: password=hunter2'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('hunter2');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});

describe('PATCH /api/clients/[id]', () => {
  it('allows ADMIN_MANAGER', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateClient.mockResolvedValue({ client: { id: CLIENT_ID } });

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );

    expect(response.status).toBe(200);
  });

  it('allows TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.updateClient.mockResolvedValue({ client: { id: CLIENT_ID } });

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );

    expect(response.status).toBe(200);
  });

  it.each(PROHIBITED_ROLES)('rejects role %s before the service is ever called', async (role) => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(serviceMocks.updateClient).not.toHaveBeenCalled();
  });

  it('rejects an invalid UUID before parsing the body or calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context('not-a-uuid'),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.updateClient).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PATCH(malformedPatchRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.updateClient).not.toHaveBeenCalled();
  });

  it('rejects an unknown property', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PATCH(
      patchRequest({ nickname: 'nope', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.updateClient).not.toHaveBeenCalled();
  });

  it('rejects a body missing expectedUpdatedAt', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PATCH(patchRequest({ fullName: 'New Name' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.updateClient).not.toHaveBeenCalled();
  });

  it('rejects a body containing only expectedUpdatedAt (no editable field)', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await PATCH(
      patchRequest({ expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.updateClient).not.toHaveBeenCalled();
  });

  it('passes the schema-transformed input to updateClient (trimmed fullName, not the raw submitted value)', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateClient.mockResolvedValue({ client: { id: CLIENT_ID } });

    await PATCH(
      patchRequest({
        fullName: '  Juan Dela Cruz  ',
        expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      }),
      context(),
    );

    expect(serviceMocks.updateClient).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      CLIENT_ID,
      expect.objectContaining({ fullName: 'Juan Dela Cruz' }),
    );
  });

  it('returns exactly { client } when the patch did not touch email/phone', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const client = { id: CLIENT_ID, fullName: 'New Name' };
    serviceMocks.updateClient.mockResolvedValue({ client });

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ client });
    expect(Object.keys(json)).toEqual(['client']);
  });

  it('returns { client, duplicateMatches, restrictedMatchDetected } together when the patch touched email', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const client = { id: CLIENT_ID, email: 'new@example.com' };
    serviceMocks.updateClient.mockResolvedValue({
      client,
      duplicateMatches: [
        { type: 'CLIENT', id: 'client-2', fullName: 'Maria', matchedOn: ['EMAIL'] },
      ],
      restrictedMatchDetected: false,
    });

    const response = await PATCH(
      patchRequest({ email: 'new@example.com', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );
    const json = await response.json();

    expect(json).toEqual({
      client,
      duplicateMatches: [
        { type: 'CLIENT', id: 'client-2', fullName: 'Maria', matchedOn: ['EMAIL'] },
      ],
      restrictedMatchDetected: false,
    });
    expect(Object.keys(json).sort()).toEqual([
      'client',
      'duplicateMatches',
      'restrictedMatchDetected',
    ]);
  });

  it('keeps duplicateMatches present (as an empty array) alongside restrictedMatchDetected when contact was supplied but no match exists', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const client = { id: CLIENT_ID, phone: '639171234567' };
    serviceMocks.updateClient.mockResolvedValue({
      client,
      duplicateMatches: [],
      restrictedMatchDetected: false,
    });

    const response = await PATCH(
      patchRequest({ phone: '0917 123 4567', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );
    const json = await response.json();

    expect(json.duplicateMatches).toEqual([]);
    expect(json.restrictedMatchDetected).toBe(false);
    expect(Object.hasOwn(json, 'duplicateMatches')).toBe(true);
    expect(Object.hasOwn(json, 'restrictedMatchDetected')).toBe(true);
  });

  it('never returns normalizedEmail or normalizedPhone', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const client = { id: CLIENT_ID, email: 'new@example.com', phone: null };
    serviceMocks.updateClient.mockResolvedValue({ client });

    const response = await PATCH(
      patchRequest({ email: 'new@example.com', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );
    const json = await response.json();

    expect(json.client).not.toHaveProperty('normalizedEmail');
    expect(json.client).not.toHaveProperty('normalizedPhone');
  });

  it('returns 404 CLIENT_NOT_FOUND', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateClient.mockRejectedValue(
      new ClientError('CLIENT_NOT_FOUND', 'Client not found.'),
    );

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error.code).toBe('CLIENT_NOT_FOUND');
  });

  it('returns 403 CLIENT_FORBIDDEN', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.updateClient.mockRejectedValue(
      new ClientError('CLIENT_FORBIDDEN', 'You do not have access to this client.'),
    );

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error.code).toBe('CLIENT_FORBIDDEN');
  });

  it('returns 409 CLIENT_CONFLICT', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateClient.mockRejectedValue(
      new ClientError(
        'CLIENT_CONFLICT',
        'This client has changed since it was last loaded. Refresh and try again.',
      ),
    );

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error.code).toBe('CLIENT_CONFLICT');
  });

  it('returns the sanitized generic INTERNAL_ERROR envelope for an unexpected error, without leaking the thrown message', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateClient.mockRejectedValue(
      new Error('unexpected db failure: password=hunter2'),
    );

    const response = await PATCH(
      patchRequest({ fullName: 'New Name', expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('hunter2');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });

  it('does not export a PUT or DELETE Client-resource handler', () => {
    expect((route as Record<string, unknown>).PUT).toBeUndefined();
    expect((route as Record<string, unknown>).DELETE).toBeUndefined();
  });
});
