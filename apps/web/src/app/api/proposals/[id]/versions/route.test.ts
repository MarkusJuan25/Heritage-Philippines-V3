import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  createProposalRevision: vi.fn(),
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

const PROPOSAL_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function postRequest(body: unknown): Request {
  return new Request(`http://localhost/api/proposals/${PROPOSAL_ID}/versions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function context(id = PROPOSAL_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/proposals/[id]/versions', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest({ content: 'Revised.' }), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it('rejects ADMIN_MANAGER at the route gate — author-only revision creation, never reaching the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({ content: 'Revised.' }), context());

    expect(response.status).toBe(403);
    expect(serviceMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s), never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await POST(postRequest({ content: 'Revised.' }), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.createProposalRevision).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID Proposal id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(postRequest({ content: 'Revised.' }), context('not-a-uuid'));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it('validates the id param before parsing the body — an invalid id short-circuits before any body parsing error could occur', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      new Request(`http://localhost/api/proposals/x/versions`, {
        method: 'POST',
        body: 'not json',
      }),
      context('not-a-uuid'),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for missing content', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(postRequest({}), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it('returns 400 for blank content', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(postRequest({ content: '   ' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it('returns 400 for a caller-supplied clientId — the target Proposal is fixed by the route param', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      postRequest({ content: 'Revised.', clientId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });

    const response = await POST(
      new Request(`http://localhost/api/proposals/${PROPOSAL_ID}/versions`, {
        method: 'POST',
        body: 'not json',
      }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it('returns 201 with the exact { version } shape for TRAVEL_CONSULTANT, calling the service with the exact Proposal id/content', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    const version = { id: 'v-2', proposalId: PROPOSAL_ID, versionNumber: 2 };
    serviceMocks.createProposalRevision.mockResolvedValue(version);

    const response = await POST(postRequest({ content: 'Revised itinerary.' }), context());
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json).toEqual({ version });
    expect(serviceMocks.createProposalRevision).toHaveBeenCalledWith(
      TRAVEL_CONSULTANT,
      PROPOSAL_ID,
      { content: 'Revised itinerary.' },
    );
    expect(serviceMocks.createProposalRevision).toHaveBeenCalledTimes(1);
  });

  it('translates a ProposalError into the standard envelope, preserving PROPOSAL_CONFLICT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.createProposalRevision.mockRejectedValue(
      new ProposalError(
        'PROPOSAL_CONFLICT',
        'This proposal could not be completed because of a conflicting update. Please try again.',
      ),
    );

    const response = await POST(postRequest({ content: 'Revised.' }), context());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error.code).toBe('PROPOSAL_CONFLICT');
  });

  it('returns 403 PROPOSAL_FORBIDDEN for a Proposal the actor cannot access', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.createProposalRevision.mockRejectedValue(
      new ProposalError('PROPOSAL_FORBIDDEN', 'Proposal not found or not accessible.'),
    );

    const response = await POST(postRequest({ content: 'Revised.' }), context());

    expect(response.status).toBe(403);
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.createProposalRevision.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(postRequest({ content: 'Revised.' }), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
