import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  recordProposalResponse: vi.fn(),
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

const VALID_BODY = {
  responseType: 'ACCEPT' as const,
  respondedAt: '2026-08-04T10:00:00.000Z',
  responseMethod: 'phone',
  evidenceReference: 'Call log #4821',
};

function postRequest(body: unknown): Request {
  return new Request(`http://localhost/api/proposals/versions/${VERSION_ID}/response`, {
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

describe('POST /api/proposals/versions/[id]/response', () => {
  it('returns 401 when there is no authenticated session', async () => {
    getSessionMock.mockResolvedValue(null);

    const response = await POST(postRequest(VALID_BODY), context());

    expect(response.status).toBe(401);
    expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
  });

  it.each(['CLIENT', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'returns 403 for a rejected role (%s), never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role } });

      const response = await POST(postRequest(VALID_BODY), context());

      expect(response.status).toBe(403);
      expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for a non-UUID version id, without calling the service', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest(VALID_BODY), context('not-a-uuid'));
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid responseType', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(postRequest({ ...VALID_BODY, responseType: 'MAYBE' }), context());

    expect(response.status).toBe(400);
    expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
  });

  it('returns 400 for a timezone-less respondedAt', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({ ...VALID_BODY, respondedAt: '2026-08-04T18:00:00' }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing responseMethod', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({
        responseType: VALID_BODY.responseType,
        respondedAt: VALID_BODY.respondedAt,
        evidenceReference: VALID_BODY.evidenceReference,
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
  });

  it('returns 400 for a missing evidenceReference', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({
        responseType: VALID_BODY.responseType,
        respondedAt: VALID_BODY.respondedAt,
        responseMethod: VALID_BODY.responseMethod,
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
  });

  it('returns 400 for any unrecognized property in the body (strict schema)', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      postRequest({ ...VALID_BODY, recordedByStaffUserId: 'admin-1' }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });

    const response = await POST(
      new Request(`http://localhost/api/proposals/versions/${VERSION_ID}/response`, {
        method: 'POST',
        body: 'not json',
      }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(serviceMocks.recordProposalResponse).not.toHaveBeenCalled();
  });

  it('returns 200 (per D-027 §6) with the exact { acceptance } shape for ADMIN_MANAGER, calling the service with exact responseType/respondedAt/responseMethod/evidenceReference', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const acceptance = {
      id: 'acceptance-1',
      proposalVersionId: VERSION_ID,
      responseType: 'ACCEPT',
    };
    serviceMocks.recordProposalResponse.mockResolvedValue(acceptance);

    const response = await POST(postRequest(VALID_BODY), context());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ acceptance });
    expect(serviceMocks.recordProposalResponse).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      VERSION_ID,
      VALID_BODY,
    );
    expect(serviceMocks.recordProposalResponse).toHaveBeenCalledTimes(1);
  });

  it('returns 200 for TRAVEL_CONSULTANT', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.recordProposalResponse.mockResolvedValue({ id: 'acceptance-1' });

    const response = await POST(postRequest(VALID_BODY), context());

    expect(response.status).toBe(200);
    expect(serviceMocks.recordProposalResponse).toHaveBeenCalledWith(
      TRAVEL_CONSULTANT,
      VERSION_ID,
      VALID_BODY,
    );
  });

  it('accepts DECLINE and REQUEST_CHANGES as responseType, passed through exactly', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.recordProposalResponse.mockResolvedValue({ id: 'acceptance-1' });

    await POST(postRequest({ ...VALID_BODY, responseType: 'DECLINE' }), context());

    expect(serviceMocks.recordProposalResponse).toHaveBeenCalledWith(
      ADMIN_MANAGER,
      VERSION_ID,
      expect.objectContaining({ responseType: 'DECLINE' }),
    );
  });

  it('returns 409 PROPOSAL_RESPONSE_ALREADY_RECORDED, translated unchanged', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.recordProposalResponse.mockRejectedValue(
      new ProposalError(
        'PROPOSAL_RESPONSE_ALREADY_RECORDED',
        'A response has already been recorded for this proposal version.',
      ),
    );

    const response = await POST(postRequest(VALID_BODY), context());
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error.code).toBe('PROPOSAL_RESPONSE_ALREADY_RECORDED');
  });

  it('returns 409 PROPOSAL_VERSION_NOT_CURRENT', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.recordProposalResponse.mockRejectedValue(
      new ProposalError(
        'PROPOSAL_VERSION_NOT_CURRENT',
        'A response can only be recorded for the current client-visible version of this proposal.',
      ),
    );

    const response = await POST(postRequest(VALID_BODY), context());

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('PROPOSAL_VERSION_NOT_CURRENT');
  });

  it('returns 404 PROPOSAL_VERSION_NOT_FOUND for ADMIN_MANAGER when the version genuinely does not exist', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.recordProposalResponse.mockRejectedValue(
      new ProposalError('PROPOSAL_VERSION_NOT_FOUND', 'Proposal version not found.'),
    );

    const response = await POST(postRequest(VALID_BODY), context());

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('PROPOSAL_VERSION_NOT_FOUND');
  });

  it('returns 403 PROPOSAL_VERSION_FORBIDDEN for TRAVEL_CONSULTANT — never 404, preserving the anti-enumeration split', async () => {
    getSessionMock.mockResolvedValue({ user: TRAVEL_CONSULTANT });
    serviceMocks.recordProposalResponse.mockRejectedValue(
      new ProposalError(
        'PROPOSAL_VERSION_FORBIDDEN',
        'Proposal version not found or not accessible.',
      ),
    );

    const response = await POST(postRequest(VALID_BODY), context());

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('PROPOSAL_VERSION_FORBIDDEN');
  });

  it('returns 500 with the generic envelope for an unexpected error, never leaking internal details', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.recordProposalResponse.mockRejectedValue(new Error('unexpected db failure'));

    const response = await POST(postRequest(VALID_BODY), context());
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('unexpected db failure');
  });
});
