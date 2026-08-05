import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  getProposalById: vi.fn(),
}));
vi.mock('@/features/proposals/service', () => serviceMocks);

import { ProposalError } from '@/features/proposals/errors';

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

const PROPOSAL_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function getRequest(): Request {
  return new Request(`http://localhost/api/proposals/${PROPOSAL_ID}`, { method: 'GET' });
}

function context(id = PROPOSAL_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function detailRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL_ID,
    client: { id: 'client-1', fullName: 'Jordan Cruz' },
    createdAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
    versions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/proposals/[id]', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.getProposalById).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s), never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await GET(getRequest(), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.getProposalById).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await GET(getRequest(), context('not-a-uuid'));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.getProposalById).not.toHaveBeenCalled();
  });

  it('returns 200 with the { proposal, versions } shape for ADMIN_MANAGER, awaiting and parsing the dynamic id param', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const record = detailRecord({
      versions: [
        {
          id: 'v-1',
          proposalId: PROPOSAL_ID,
          versionNumber: 1,
          content: null,
          clientVisibleAt: null,
          supersededAt: null,
          createdByUserId: 'tc-1',
          createdAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
          updatedAt: new Date('2026-08-01T00:00:00.000Z').toISOString(),
          acceptance: null,
        },
      ],
    });
    serviceMocks.getProposalById.mockResolvedValue(record);

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    const { versions, ...expectedProposal } = record;
    expect(json).toEqual({ proposal: expectedProposal, versions });
    expect(serviceMocks.getProposalById).toHaveBeenCalledWith(ADMIN_MANAGER, PROPOSAL_ID);
    expect(serviceMocks.getProposalById).toHaveBeenCalledTimes(1);
  });

  it('returns 200 for TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.getProposalById.mockResolvedValue(detailRecord());

    const response = await GET(getRequest(), context());

    expect(response.status).toBe(200);
    expect(serviceMocks.getProposalById).toHaveBeenCalledWith(TRAVEL_CONSULTANT, PROPOSAL_ID);
  });

  it('preserves a legacy null content unchanged inside the versions array', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getProposalById.mockResolvedValue(
      detailRecord({
        versions: [{ id: 'v-1', content: null, versionNumber: 1 }],
      }),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(json.versions[0].content).toBeNull();
  });

  it('returns 404 PROPOSAL_NOT_FOUND for ADMIN_MANAGER when the Proposal genuinely does not exist', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getProposalById.mockRejectedValue(
      new ProposalError('PROPOSAL_NOT_FOUND', 'Proposal not found.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json.error.code).toBe('PROPOSAL_NOT_FOUND');
  });

  it('returns 403 PROPOSAL_FORBIDDEN for TRAVEL_CONSULTANT — never 404, preserving the anti-enumeration split', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.getProposalById.mockRejectedValue(
      new ProposalError('PROPOSAL_FORBIDDEN', 'Proposal not found or not accessible.'),
    );

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error.code).toBe('PROPOSAL_FORBIDDEN');
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.getProposalById.mockRejectedValue(new Error('unexpected db failure'));

    const response = await GET(getRequest(), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
