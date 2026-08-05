import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  publishProposalVersion: vi.fn(),
}));
vi.mock('@/features/proposals/service', () => serviceMocks);

import { ProposalError } from '@/features/proposals/errors';

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

const VERSION_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER_VERSION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function postRequest(body: unknown): Request {
  return new Request(`http://localhost/api/proposals/versions/${VERSION_ID}/publish`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function context(id = VERSION_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/proposals/versions/[id]/publish', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest({ expectedCurrentVersionId: null }), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.publishProposalVersion).not.toHaveBeenCalled();
  });

  it('rejects ADMIN_MANAGER at the route gate — author-only publishing, never reaching the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({ expectedCurrentVersionId: null }), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.publishProposalVersion).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s), never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await POST(postRequest({ expectedCurrentVersionId: null }), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.publishProposalVersion).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID version id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      postRequest({ expectedCurrentVersionId: null }),
      context('not-a-uuid'),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.publishProposalVersion).not.toHaveBeenCalled();
  });

  it('returns 400 when expectedCurrentVersionId is omitted — the key is required, never merely optional', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(postRequest({}), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.publishProposalVersion).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-UUID, non-null expectedCurrentVersionId', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(postRequest({ expectedCurrentVersionId: 'not-a-uuid' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.publishProposalVersion).not.toHaveBeenCalled();
  });

  it('returns 400 for any unrecognized property in the body (strict schema)', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      postRequest({ expectedCurrentVersionId: null, force: true }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.publishProposalVersion).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      new Request(`http://localhost/api/proposals/versions/${VERSION_ID}/publish`, {
        method: 'POST',
        body: 'not json',
      }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.publishProposalVersion).not.toHaveBeenCalled();
  });

  it('returns 200 with the exact { version } shape, calling the service with a UUID expectedCurrentVersionId preserved exactly', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    const version = {
      id: VERSION_ID,
      clientVisibleAt: '2026-08-04T00:00:00.000Z',
      supersededAt: null,
    };
    serviceMocks.publishProposalVersion.mockResolvedValue(version);

    const response = await POST(
      postRequest({ expectedCurrentVersionId: OTHER_VERSION_ID }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ version });
    expect(serviceMocks.publishProposalVersion).toHaveBeenCalledWith(
      TRAVEL_CONSULTANT,
      VERSION_ID,
      {
        expectedCurrentVersionId: OTHER_VERSION_ID,
      },
    );
    expect(serviceMocks.publishProposalVersion).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit null expectedCurrentVersionId through to the service call exactly', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.publishProposalVersion.mockResolvedValue({ id: VERSION_ID });

    await POST(postRequest({ expectedCurrentVersionId: null }), context());

    expect(serviceMocks.publishProposalVersion).toHaveBeenCalledWith(
      TRAVEL_CONSULTANT,
      VERSION_ID,
      {
        expectedCurrentVersionId: null,
      },
    );
  });

  it("translates a ProposalError into the standard envelope, preserving D-027 §5's exact refresh message on PROPOSAL_CONFLICT", async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.publishProposalVersion.mockRejectedValue(
      new ProposalError(
        'PROPOSAL_CONFLICT',
        'The current version has changed since you last loaded this proposal. Refresh and try again.',
      ),
    );

    const response = await POST(postRequest({ expectedCurrentVersionId: null }), context());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error.message).toBe(
      'The current version has changed since you last loaded this proposal. Refresh and try again.',
    );
  });

  it('returns 409 PROPOSAL_VERSION_SUPERSEDED', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.publishProposalVersion.mockRejectedValue(
      new ProposalError(
        'PROPOSAL_VERSION_SUPERSEDED',
        'This proposal version has already been superseded by a later revision.',
      ),
    );

    const response = await POST(postRequest({ expectedCurrentVersionId: null }), context());

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('PROPOSAL_VERSION_SUPERSEDED');
  });

  it('returns 403 PROPOSAL_VERSION_FORBIDDEN for a nonexistent or inaccessible target — never 404', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.publishProposalVersion.mockRejectedValue(
      new ProposalError(
        'PROPOSAL_VERSION_FORBIDDEN',
        'Proposal version not found or not accessible.',
      ),
    );

    const response = await POST(postRequest({ expectedCurrentVersionId: null }), context());

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('PROPOSAL_VERSION_FORBIDDEN');
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.publishProposalVersion.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(postRequest({ expectedCurrentVersionId: null }), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
