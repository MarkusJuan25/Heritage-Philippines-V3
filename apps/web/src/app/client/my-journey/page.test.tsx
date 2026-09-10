// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock, getCurrentSessionMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn(),
  getCurrentSessionMock: vi.fn(),
}));
vi.mock('@/lib/auth/guards', () => ({
  getCurrentUser: getCurrentUserMock,
  getCurrentSession: getCurrentSessionMock,
}));

const { getOwnClientForUserMock } = vi.hoisted(() => ({ getOwnClientForUserMock: vi.fn() }));
vi.mock('@/features/clients/service', () => ({ getOwnClientForUser: getOwnClientForUserMock }));

const { getClientProposalReviewPageMock, submitClientProposalResponseMock } = vi.hoisted(() => ({
  getClientProposalReviewPageMock: vi.fn(),
  submitClientProposalResponseMock: vi.fn(),
}));
const CONTROLLED_CODES = [
  'VALIDATION_ERROR',
  'PROPOSAL_RESPONSE_ALREADY_RECORDED',
  'PROPOSAL_VERSION_NOT_CURRENT',
  'PROPOSAL_VERSION_SUPERSEDED',
  'PROPOSAL_CONFLICT',
];
vi.mock('@/features/proposals/service', () => ({
  getClientProposalReviewPage: getClientProposalReviewPageMock,
  submitClientProposalResponse: submitClientProposalResponseMock,
  clientProposalResponseCodeFor: (error: { code: string }) =>
    CONTROLLED_CODES.includes(error.code) ? error.code : 'FORBIDDEN',
  clientProposalResponseSchema: {
    safeParse: (value: Record<string, unknown>) => {
      const keys = Object.keys(value).sort();
      const ok =
        keys.length === 2 &&
        keys[0] === 'acknowledgement' &&
        keys[1] === 'responseType' &&
        value.acknowledgement === 'on' &&
        ['ACCEPT', 'DECLINE', 'REQUEST_CHANGES'].includes(value.responseType as string);
      return ok
        ? { success: true, data: { responseType: value.responseType, acknowledgement: 'on' } }
        : { success: false, error: new Error('invalid') };
    },
  },
}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));

const { reviewListPropsSpy } = vi.hoisted(() => ({ reviewListPropsSpy: vi.fn() }));
vi.mock('./_components/ProposalReviewList', () => ({
  ProposalReviewList: (props: unknown) => {
    reviewListPropsSpy(props);
    return null;
  },
}));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import { ClientError } from '@/features/clients/errors';
import { ProposalError } from '@/features/proposals/errors';
import type { ClientProposalResponseAction } from '@/features/proposals/service';

import ClientMyJourneyPage from './page';

const SESSION = { user: { id: 'user-client-1', role: 'CLIENT' }, sessionId: 'session-xyz' };

function lastReviewListProps() {
  return reviewListPropsSpy.mock.calls.at(-1)![0] as {
    render: { cards: unknown[]; isEmpty: boolean };
    responseActions: ClientProposalResponseAction[];
  };
}

function responseFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('responseType', 'ACCEPT');
  fd.set('acknowledgement', 'on');
  for (const [k, v] of Object.entries(overrides)) {
    fd.set(k, v);
  }
  return fd;
}

// Mirrors what Next.js injects into a Server Action's submitted FormData for
// progressive enhancement: an action id, a bound-args ref, and the encoded
// bound-args entries. The blob deliberately mentions a fake proposalVersionId
// to prove the closure binding never consults submitted data.
function frameworkFormData(overrides: Record<string, string> = {}) {
  const fd = responseFormData(overrides);
  fd.set('$ACTION_ID_1c8f9a2b7d4e5f60', '1');
  fd.set('$ACTION_REF_1', '');
  fd.set('$ACTION_1:0', '{"id":"1c8f9a2b7d4e5f60","bound":"$@1"}');
  fd.set('$ACTION_1:1', '[{"proposalVersionId":"pv-HACKER"}]');
  return fd;
}

const CLIENT_USER = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client One',
  role: 'CLIENT' as const,
};

const OWNED = {
  clientId: 'client-1',
  fullName: 'Client One',
  email: 'client@example.test',
  phone: null,
};

function pageResult(overrides: Record<string, unknown> = {}) {
  const render = {
    page: 1,
    hasPrevious: false,
    hasNext: false,
    isEmpty: false,
    cards: [
      {
        versionNumber: 1,
        publishedAt: '2026-09-01T08:00:00.000Z',
        content: { available: true as const, text: 'Itinerary v1' },
        response: null,
        statusLabel: 'Awaiting your response',
      },
    ] as Array<Record<string, unknown>>,
    ...overrides,
  };
  // Stage 3 guarantees serverModel.cards is index-aligned with render.cards.
  const serverModel = {
    cards: render.cards.map((_, i) => ({
      proposalVersionId: `pv-${i + 1}`,
      proposalId: `p-${i + 1}`,
    })),
  };
  return { kind: 'page' as const, render, serverModel };
}

async function callPage(search: Record<string, string | string[] | undefined> = {}) {
  return ClientMyJourneyPage({ searchParams: Promise.resolve(search) });
}

describe('ClientMyJourneyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getCurrentSessionMock.mockResolvedValue(SESSION);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientProposalReviewPageMock.mockResolvedValue(pageResult());
    submitClientProposalResponseMock.mockResolvedValue({ responseType: 'ACCEPT' });
  });

  it('redirects to /login when there is no session (before any read)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(callPage()).rejects.toThrow('REDIRECT:/login');
    expect(getOwnClientForUserMock).not.toHaveBeenCalled();
    expect(getClientProposalReviewPageMock).not.toHaveBeenCalled();
  });

  it('resolves the owned clientId from Contract A alone and passes it (never a query value) to the read', async () => {
    getClientProposalReviewPageMock.mockResolvedValue(pageResult());

    await callPage({ page: '2', clientId: 'attacker-supplied' });

    expect(getOwnClientForUserMock).toHaveBeenCalledWith(CLIENT_USER);
    expect(getClientProposalReviewPageMock).toHaveBeenCalledWith(CLIENT_USER, 'client-1', 2);
  });

  it('parses the page query with the strict parser: invalid / array / zero / absent all become page 1', async () => {
    for (const raw of [undefined, 'abc', '0', '-1', '01', ['2', '5'], ' 3 ']) {
      getClientProposalReviewPageMock.mockClear();
      await callPage(raw === undefined ? {} : { page: raw });
      expect(getClientProposalReviewPageMock).toHaveBeenCalledWith(CLIENT_USER, 'client-1', 1);
    }
  });

  it('returns null (layout owns the panel) when Contract A resolves null — no ClientProfile', async () => {
    getOwnClientForUserMock.mockResolvedValue(null);

    expect(await callPage()).toBeNull();
    expect(getClientProposalReviewPageMock).not.toHaveBeenCalled();
  });

  it('returns null for a ROLE_NOT_PERMITTED raised by Contract A (ClientError) — non-CLIENT concurrent execution', async () => {
    getOwnClientForUserMock.mockRejectedValue(new ClientError('ROLE_NOT_PERMITTED', 'no'));

    expect(await callPage()).toBeNull();
  });

  it('returns null for a ROLE_NOT_PERMITTED raised by the proposals read service (ProposalError)', async () => {
    getClientProposalReviewPageMock.mockRejectedValue(
      new ProposalError('ROLE_NOT_PERMITTED', 'no'),
    );

    expect(await callPage()).toBeNull();
  });

  it('rethrows a ProposalError with any other code (e.g. CLIENT_FORBIDDEN) to the segment error boundary', async () => {
    getClientProposalReviewPageMock.mockRejectedValue(
      new ProposalError('CLIENT_FORBIDDEN', 'denied'),
    );

    await expect(callPage()).rejects.toBeInstanceOf(ProposalError);
  });

  it('rethrows a non-ROLE_NOT_PERMITTED ClientError and any unexpected error', async () => {
    getOwnClientForUserMock.mockRejectedValue(new ClientError('CLIENT_NOT_FOUND', 'x'));
    await expect(callPage()).rejects.toBeInstanceOf(ClientError);

    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientProposalReviewPageMock.mockRejectedValue(new Error('db exploded'));
    await expect(callPage()).rejects.toThrow('db exploded');
  });

  it('issues the in-app redirect to /client/my-journey when the service reports kind: "redirect" (and does not swallow it)', async () => {
    getClientProposalReviewPageMock.mockResolvedValue({ kind: 'redirect' });

    await expect(callPage({ page: '9' })).rejects.toThrow('REDIRECT:/client/my-journey');
    expect(redirectMock).toHaveBeenCalledWith('/client/my-journey');
  });

  it('renders the page-1 heading, threads the render DTO + an index-aligned action per card to the list, and adds no <main>', async () => {
    getClientProposalReviewPageMock.mockResolvedValue(pageResult());

    const jsx = await callPage();
    const { container } = render(jsx!);

    expect(screen.getByRole('heading', { level: 1, name: 'My Journey' })).toBeInTheDocument();
    expect(container.querySelector('main')).toBeNull();

    const props = lastReviewListProps();
    expect(props.render.cards).toHaveLength(1);
    expect(props.responseActions).toHaveLength(1);
    expect(typeof props.responseActions[0]).toBe('function');
  });

  it('passes the empty render DTO through to the list (no cards, isEmpty)', async () => {
    getClientProposalReviewPageMock.mockResolvedValue(pageResult({ isEmpty: true, cards: [] }));

    render((await callPage())!);

    const props = lastReviewListProps();
    expect(props.render.isEmpty).toBe(true);
    expect(props.render.cards).toHaveLength(0);
    expect(props.responseActions).toHaveLength(0);
  });
});

describe('ClientMyJourneyPage — per-card response Server Action (D-047 §6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getCurrentSessionMock.mockResolvedValue(SESSION);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientProposalReviewPageMock.mockResolvedValue(pageResult());
    submitClientProposalResponseMock.mockResolvedValue({ responseType: 'ACCEPT' });
  });

  async function getAction() {
    render((await callPage())!);
    return lastReviewListProps().responseActions[0]!;
  }

  it('fails closed with FORBIDDEN and touches no service when there is no verified session', async () => {
    getCurrentSessionMock.mockResolvedValue(null);
    const action = await getAction();

    expect(await action({ status: 'idle' }, responseFormData())).toEqual({
      status: 'error',
      code: 'FORBIDDEN',
    });
    expect(submitClientProposalResponseMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid or over-strict payload as VALIDATION_ERROR without calling the service', async () => {
    const action = await getAction();

    // missing acknowledgement
    const missingAck = new FormData();
    missingAck.set('responseType', 'ACCEPT');
    expect(await action({ status: 'idle' }, missingAck)).toEqual({
      status: 'error',
      code: 'VALIDATION_ERROR',
    });

    // a forged extra field (e.g. a supplied proposalVersionId) is rejected by .strict()
    expect(
      await action({ status: 'idle' }, responseFormData({ proposalVersionId: 'pv-HACKER' })),
    ).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });

    expect(submitClientProposalResponseMock).not.toHaveBeenCalled();
  });

  it('binds the closure-captured ProposalVersion.id — never a form value — and revalidates on success', async () => {
    const action = await getAction();

    const result = await action({ status: 'idle' }, responseFormData());

    expect(submitClientProposalResponseMock).toHaveBeenCalledWith({
      actor: SESSION.user,
      sessionId: SESSION.sessionId,
      proposalVersionId: 'pv-1', // from serverModel.cards[0], not the FormData
      responseType: 'ACCEPT',
      acknowledged: true,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith('/client/my-journey');
    expect(result).toEqual({ status: 'success', responseType: 'ACCEPT' });
    // The result is identifier-free.
    const json = JSON.stringify(result);
    expect(json).not.toContain('pv-1');
    expect(json).not.toContain('p-1');
    expect(json).not.toContain('session-xyz');
    expect(json).not.toContain('client-1');
  });

  it('maps a ProposalError to its controlled code (forbidden family -> FORBIDDEN) and does not revalidate', async () => {
    const action = await getAction();

    submitClientProposalResponseMock.mockRejectedValueOnce(
      new ProposalError('CLIENT_FORBIDDEN', 'no'),
    );
    expect(await action({ status: 'idle' }, responseFormData())).toEqual({
      status: 'error',
      code: 'FORBIDDEN',
    });

    submitClientProposalResponseMock.mockRejectedValueOnce(
      new ProposalError('PROPOSAL_RESPONSE_ALREADY_RECORDED', 'x'),
    );
    expect(await action({ status: 'idle' }, responseFormData())).toEqual({
      status: 'error',
      code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED',
    });

    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('rethrows a non-ProposalError so it reaches the segment error boundary', async () => {
    const action = await getAction();
    submitClientProposalResponseMock.mockRejectedValue(new Error('db exploded'));

    await expect(action({ status: 'idle' }, responseFormData())).rejects.toThrow('db exploded');
  });

  it('creates one distinct action per serverModel card, index-aligned with render.cards', async () => {
    getClientProposalReviewPageMock.mockResolvedValue({
      kind: 'page' as const,
      render: {
        page: 1,
        hasPrevious: false,
        hasNext: false,
        isEmpty: false,
        cards: [
          {
            versionNumber: 2,
            publishedAt: 'x',
            content: { available: true, text: 'a' },
            response: null,
            statusLabel: 'Awaiting your response',
          },
          {
            versionNumber: 1,
            publishedAt: 'x',
            content: { available: true, text: 'b' },
            response: null,
            statusLabel: 'Awaiting your response',
          },
        ],
      },
      serverModel: {
        cards: [
          { proposalVersionId: 'pv-2', proposalId: 'p-2' },
          { proposalVersionId: 'pv-1', proposalId: 'p-1' },
        ],
      },
    });

    render((await callPage())!);
    const actions = lastReviewListProps().responseActions;
    expect(actions).toHaveLength(2);
    expect(actions[0]).not.toBe(actions[1]);

    await actions[1]!({ status: 'idle' }, responseFormData());
    expect(submitClientProposalResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ proposalVersionId: 'pv-1' }),
    );
  });

  // D-047 Stage 6 blocker A — Next.js injects `$ACTION_*` fields into a real
  // Server Action's FormData; the action strips ONLY those before the strict
  // parse, so a genuine submission is no longer rejected as VALIDATION_ERROR,
  // while every non-framework unexpected field is still rejected.
  it('strips Next\'s injected "$ACTION_" framework fields and still reaches the service on a valid submit', async () => {
    const action = await getAction();

    const result = await action({ status: 'idle' }, frameworkFormData());

    expect(submitClientProposalResponseMock).toHaveBeenCalledWith({
      actor: SESSION.user,
      sessionId: SESSION.sessionId,
      proposalVersionId: 'pv-1', // closure-bound; the "$ACTION_1:1" blob's pv-HACKER is ignored
      responseType: 'ACCEPT',
      acknowledged: true,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith('/client/my-journey');
    expect(result).toEqual({ status: 'success', responseType: 'ACCEPT' });
  });

  it('still rejects an ordinary forged field as VALIDATION_ERROR even alongside valid "$ACTION_" fields', async () => {
    const action = await getAction();

    for (const forged of [
      'proposalVersionId',
      'proposalId',
      'clientId',
      'respondedAt',
      'somethingArbitrary',
    ]) {
      submitClientProposalResponseMock.mockClear();
      revalidatePathMock.mockClear();

      const result = await action({ status: 'idle' }, frameworkFormData({ [forged]: 'x' }));

      expect(result).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });
      expect(submitClientProposalResponseMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    }
  });

  it('does not treat a "$ACTION"-prefixed key WITHOUT the underscore as framework metadata', async () => {
    const action = await getAction();

    for (const key of ['$ACTION', '$ACTIONID', '$ACTION-1', '$ACTIONREF_1']) {
      submitClientProposalResponseMock.mockClear();

      const fd = responseFormData();
      fd.set(key, 'x');
      const result = await action({ status: 'idle' }, fd);

      expect(result).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });
      expect(submitClientProposalResponseMock).not.toHaveBeenCalled();
    }
  });

  it('binds the closure-captured ProposalVersion.id, never a submitted "$ACTION_"-fielded value', async () => {
    getClientProposalReviewPageMock.mockResolvedValue({
      kind: 'page' as const,
      render: {
        page: 1,
        hasPrevious: false,
        hasNext: false,
        isEmpty: false,
        cards: [
          {
            versionNumber: 3,
            publishedAt: 'x',
            content: { available: true, text: 'c' },
            response: null,
            statusLabel: 'Awaiting your response',
          },
        ],
      },
      serverModel: { cards: [{ proposalVersionId: 'pv-CLOSURE-ONLY', proposalId: 'p-9' }] },
    });
    render((await callPage())!);
    const action = lastReviewListProps().responseActions[0]!;

    await action({ status: 'idle' }, frameworkFormData());

    expect(submitClientProposalResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({ proposalVersionId: 'pv-CLOSURE-ONLY' }),
    );
  });

  it('still rejects missing / invalid required fields when "$ACTION_" fields are present', async () => {
    const action = await getAction();

    const missingAck = frameworkFormData();
    missingAck.delete('acknowledgement');
    expect(await action({ status: 'idle' }, missingAck)).toEqual({
      status: 'error',
      code: 'VALIDATION_ERROR',
    });

    expect(
      await action({ status: 'idle' }, frameworkFormData({ acknowledgement: 'true' })),
    ).toEqual({ status: 'error', code: 'VALIDATION_ERROR' });

    expect(await action({ status: 'idle' }, frameworkFormData({ responseType: 'MAYBE' }))).toEqual({
      status: 'error',
      code: 'VALIDATION_ERROR',
    });

    expect(submitClientProposalResponseMock).not.toHaveBeenCalled();
  });
});
