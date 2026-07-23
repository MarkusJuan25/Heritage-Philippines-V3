import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({ updateLeadStatus: vi.fn() }));
vi.mock('@/features/leads/service', () => serviceMocks);

import { LeadError } from '@/features/leads/errors';

import { PUT } from './route';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};

const LEAD_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function putRequest(body: unknown): Request {
  return new Request(`http://localhost/api/leads/${LEAD_ID}/status`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function context(id = LEAD_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PUT /api/leads/[id]/status', () => {
  it('returns 401 with no session', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await PUT(
      putRequest({ expectedStatus: 'NEW', newStatus: 'UNDER_REVIEW' }),
      context(),
    );
    expect(response.status).toBe(401);
  });

  it('returns 403 for CLIENT', async () => {
    getSessionMock.mockResolvedValue({ user: { ...ADMIN_MANAGER, role: 'CLIENT' } });
    const response = await PUT(
      putRequest({ expectedStatus: 'NEW', newStatus: 'UNDER_REVIEW' }),
      context(),
    );
    expect(response.status).toBe(403);
    expect(serviceMocks.updateLeadStatus).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid body', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const response = await PUT(putRequest({ newStatus: 'UNDER_REVIEW' }), context());
    expect(response.status).toBe(400);
    expect(serviceMocks.updateLeadStatus).not.toHaveBeenCalled();
  });

  it('returns 200 with the transitioned Lead', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    const lead = { id: LEAD_ID, status: 'UNDER_REVIEW' };
    serviceMocks.updateLeadStatus.mockResolvedValue(lead);

    const response = await PUT(
      putRequest({ expectedStatus: 'NEW', newStatus: 'UNDER_REVIEW' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ lead });
    expect(serviceMocks.updateLeadStatus).toHaveBeenCalledWith(ADMIN_MANAGER, LEAD_ID, {
      expectedStatus: 'NEW',
      newStatus: 'UNDER_REVIEW',
    });
  });

  it.each([
    ['REASON_REQUIRED', 409],
    ['INVALID_STATUS_TRANSITION', 409],
    ['CONVERSION_ENDPOINT_REQUIRED', 409],
    ['LEAD_CONFLICT', 409],
    ['LEAD_FORBIDDEN', 403],
    ['LEAD_NOT_FOUND', 404],
  ] as const)('maps LeadError %s to status %i', async (code, status) => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateLeadStatus.mockRejectedValue(new LeadError(code, 'message'));

    const response = await PUT(
      putRequest({ expectedStatus: 'NEW', newStatus: 'UNDER_REVIEW' }),
      context(),
    );
    const json = await response.json();

    expect(response.status).toBe(status);
    expect(json.error.code).toBe(code);
  });

  it('forwards the reason field when supplied', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_MANAGER });
    serviceMocks.updateLeadStatus.mockResolvedValue({ id: LEAD_ID, status: 'UNDER_REVIEW' });

    await PUT(
      putRequest({ expectedStatus: 'SPAM', newStatus: 'UNDER_REVIEW', reason: 'Misclassified' }),
      context(),
    );

    expect(serviceMocks.updateLeadStatus).toHaveBeenCalledWith(ADMIN_MANAGER, LEAD_ID, {
      expectedStatus: 'SPAM',
      newStatus: 'UNDER_REVIEW',
      reason: 'Misclassified',
    });
  });
});
