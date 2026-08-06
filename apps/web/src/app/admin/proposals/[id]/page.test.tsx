// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getProposalByIdMock } = vi.hoisted(() => ({ getProposalByIdMock: vi.fn() }));
vi.mock('@/features/proposals/service', () => ({ getProposalById: getProposalByIdMock }));

const { redirectMock, routerPushMock, routerRefreshMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  routerPushMock: vi.fn(),
  routerRefreshMock: vi.fn(),
}));
// CreateProposalRevisionPanel (Stage 7D, rendered for TRAVEL_CONSULTANT
// only) calls useRouter().refresh() on a successful submission — this page
// itself calls neither, but the whole `next/navigation` module is replaced
// here, so every export any rendered child component needs must be
// provided (mirrors admin/clients/[id]/page.test.tsx's identical
// discipline).
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
}));

// The real ProposalError class — not mocked — so this page's own
// `error instanceof ProposalError` checks (PROPOSAL_NOT_FOUND /
// PROPOSAL_FORBIDDEN) exercise real logic rather than an unrelated mock
// class (mirrors admin/clients/[id]/page.test.tsx's identical discipline).
import { ProposalError } from '@/features/proposals/errors';
import type { ProposalDetailRecord } from '@/features/proposals/repository';

import AdminProposalDetailPage from './page';

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

function proposalDetail(overrides: Partial<ProposalDetailRecord> = {}): ProposalDetailRecord {
  return {
    id: PROPOSAL_ID,
    client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    versions: [
      {
        id: 'version-1',
        proposalId: PROPOSAL_ID,
        versionNumber: 1,
        content: 'Sample proposal content.',
        clientVisibleAt: null,
        supersededAt: null,
        createdByUserId: 'tc-1',
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        acceptance: null,
      },
    ],
    ...overrides,
  };
}

function params(id = PROPOSAL_ID): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // `vi.resetAllMocks()` in `afterEach` below strips every mock's
  // implementation, including `redirectMock`'s throwing behavior set at
  // creation time — without restoring it here, only the very first test in
  // this file to exercise a redirect would ever see it actually throw
  // (mirrors admin/clients/[id]/page.test.tsx's identical discipline).
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  routerPushMock.mockClear();
  routerRefreshMock.mockClear();
  // CreateProposalRevisionPanel (Stage 7D) fetches only on an explicit
  // submit — stubbed globally here so every existing test unrelated to
  // that panel's own behavior still renders deterministically, with a safe
  // default a test can override.
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { version: { id: 'v-2' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('AdminProposalDetailPage', () => {
  it('redirects to /login when there is no session (Layer 3)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminProposalDetailPage({ params: params() })).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(getProposalByIdMock).not.toHaveBeenCalled();
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders an in-place permission-denied state for role %s, never calling getProposalById',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(getProposalByIdMock).not.toHaveBeenCalled();
    },
  );

  it('renders the detail for an authorized ADMIN_MANAGER', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(proposalDetail());

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Proposal' })).toBeInTheDocument();
  });

  it('renders the detail for an authorized TRAVEL_CONSULTANT, calling getProposalById with the exact actor and id', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    getProposalByIdMock.mockResolvedValue(proposalDetail());

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Proposal' })).toBeInTheDocument();
    expect(getProposalByIdMock).toHaveBeenCalledWith(TRAVEL_CONSULTANT, PROPOSAL_ID);
    expect(getProposalByIdMock).toHaveBeenCalledTimes(1);
  });

  it('renders correct proposal/client metadata: Client linked to /admin/clients/[id], plus Created/Last updated timestamps', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(
      proposalDetail({
        client: { id: 'client-77', fullName: 'Maria Santos' },
        createdAt: new Date('2026-07-20T00:00:00Z'),
        updatedAt: new Date('2026-07-25T00:00:00Z'),
      }),
    );

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    const clientLink = screen.getByRole('link', { name: 'Maria Santos' });
    expect(clientLink).toHaveAttribute('href', '/admin/clients/client-77');
    expect(
      screen.getByText(new Date('2026-07-20T00:00:00Z').toLocaleString('en-PH')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new Date('2026-07-25T00:00:00Z').toLocaleString('en-PH')),
    ).toBeInTheDocument();
  });

  it('renders the version history in exactly the order the service returns it', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(
      proposalDetail({
        versions: [
          {
            id: 'v2',
            proposalId: PROPOSAL_ID,
            versionNumber: 2,
            content: 'Revision content.',
            clientVisibleAt: null,
            supersededAt: null,
            createdByUserId: 'tc-1',
            createdAt: new Date('2026-08-02T00:00:00Z'),
            updatedAt: new Date('2026-08-02T00:00:00Z'),
            acceptance: null,
          },
          {
            id: 'v1',
            proposalId: PROPOSAL_ID,
            versionNumber: 1,
            content: 'Original content.',
            clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
            supersededAt: null,
            createdByUserId: 'tc-1',
            createdAt: new Date('2026-08-01T00:00:00Z'),
            updatedAt: new Date('2026-08-01T00:00:00Z'),
            acceptance: null,
          },
        ],
      }),
    );

    const { container } = await AdminProposalDetailPage({ params: params() }).then((jsx) => {
      return render(jsx);
    });

    const headings = Array.from(container.querySelectorAll('ol > li > h3')).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual(['Version 2', 'Version 1']);
  });

  it('identifies the latest version and the published version, which may differ', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(
      proposalDetail({
        versions: [
          {
            id: 'v2',
            proposalId: PROPOSAL_ID,
            versionNumber: 2,
            content: 'Draft revision, not yet published.',
            clientVisibleAt: null,
            supersededAt: null,
            createdByUserId: 'tc-1',
            createdAt: new Date('2026-08-02T00:00:00Z'),
            updatedAt: new Date('2026-08-02T00:00:00Z'),
            acceptance: null,
          },
          {
            id: 'v1',
            proposalId: PROPOSAL_ID,
            versionNumber: 1,
            content: 'Published version.',
            clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
            supersededAt: null,
            createdByUserId: 'tc-1',
            createdAt: new Date('2026-08-01T00:00:00Z'),
            updatedAt: new Date('2026-08-01T00:00:00Z'),
            acceptance: null,
          },
        ],
      }),
    );

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    const latestRow = screen.getByText('Latest version').closest('div');
    expect(latestRow?.textContent).toContain('Version 2');
    const publishedRow = screen.getByText('Published version').closest('div');
    expect(publishedRow?.textContent).toContain('Version 1');
  });

  it('renders "No published version yet." when the Proposal has no current client-visible version', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(
      proposalDetail({
        versions: [
          {
            id: 'v1',
            proposalId: PROPOSAL_ID,
            versionNumber: 1,
            content: 'Draft content.',
            clientVisibleAt: null,
            supersededAt: null,
            createdByUserId: 'tc-1',
            createdAt: new Date('2026-08-01T00:00:00Z'),
            updatedAt: new Date('2026-08-01T00:00:00Z'),
            acceptance: null,
          },
        ],
      }),
    );

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('No published version yet.')).toBeInTheDocument();
  });

  it('renders version content as literal plain text, never interpreting markup', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    const markupLikeContent = '<img src=x onerror=alert(1)> still plain text';
    getProposalByIdMock.mockResolvedValue(
      proposalDetail({
        versions: [
          {
            id: 'v1',
            proposalId: PROPOSAL_ID,
            versionNumber: 1,
            content: markupLikeContent,
            clientVisibleAt: null,
            supersededAt: null,
            createdByUserId: 'tc-1',
            createdAt: new Date('2026-08-01T00:00:00Z'),
            updatedAt: new Date('2026-08-01T00:00:00Z'),
            acceptance: null,
          },
        ],
      }),
    );

    const jsx = await AdminProposalDetailPage({ params: params() });
    const { container } = render(jsx);

    expect(screen.getByText(markupLikeContent)).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders "Content unavailable" for a legacy null-content version', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(
      proposalDetail({
        versions: [
          {
            id: 'v1',
            proposalId: PROPOSAL_ID,
            versionNumber: 1,
            content: null,
            clientVisibleAt: null,
            supersededAt: null,
            createdByUserId: 'tc-1',
            createdAt: new Date('2026-08-01T00:00:00Z'),
            updatedAt: new Date('2026-08-01T00:00:00Z'),
            acceptance: null,
          },
        ],
      }),
    );

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Content unavailable')).toBeInTheDocument();
  });

  it('provides a back-navigation link to /admin/proposals', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(proposalDetail());

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('link', { name: '← Back to Proposals' })).toHaveAttribute(
      'href',
      '/admin/proposals',
    );
  });

  it('renders a not-found state for a malformed id, without calling getProposalById', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminProposalDetailPage({ params: params('not-a-uuid') });
    render(jsx);

    expect(screen.getByText('Proposal not found')).toBeInTheDocument();
    expect(getProposalByIdMock).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '← Back to Proposals' })).toHaveAttribute(
      'href',
      '/admin/proposals',
    );
  });

  it('renders a not-found state for PROPOSAL_NOT_FOUND (ADMIN_MANAGER, genuinely missing)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockRejectedValue(
      new ProposalError('PROPOSAL_NOT_FOUND', 'Proposal not found.'),
    );

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Proposal not found')).toBeInTheDocument();
  });

  it('renders the identical not-found state for PROPOSAL_FORBIDDEN, leaking no Proposal-specific content', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    getProposalByIdMock.mockRejectedValue(
      new ProposalError('PROPOSAL_FORBIDDEN', 'Proposal not found or not accessible.'),
    );

    const jsx = await AdminProposalDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Proposal not found')).toBeInTheDocument();
    // Never leaks any Client identity, version content, or lifecycle/
    // response state that a genuinely inaccessible Proposal might carry.
    expect(screen.queryByText('Juan Dela Cruz')).not.toBeInTheDocument();
    expect(screen.queryByText('Sample proposal content.')).not.toBeInTheDocument();
    expect(screen.queryByText('Draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Published')).not.toBeInTheDocument();
    expect(screen.queryByText('No response')).not.toBeInTheDocument();
  });

  it('rethrows an unexpected error rather than rendering a not-found state', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockRejectedValue(new Error('unexpected db failure'));

    await expect(AdminProposalDetailPage({ params: params() })).rejects.toThrow(
      'unexpected db failure',
    );
  });

  it('renders no Proposal-authoring or publish control for ADMIN_MANAGER; this draft-only fixture also has no eligible current published version, so no response form appears here either', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(proposalDetail());

    const jsx = await AdminProposalDetailPage({ params: params() });
    const { container } = render(jsx);

    expect(container.querySelector('form')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create revision/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
  });

  it('exposes stable semantic structure usable on narrow screens: definition lists and an ordered version-history list', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getProposalByIdMock.mockResolvedValue(proposalDetail());

    const jsx = await AdminProposalDetailPage({ params: params() });
    const { container } = render(jsx);

    expect(container.querySelectorAll('dl').length).toBeGreaterThan(0);
    expect(container.querySelector('ol')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Version history' })).toBeInTheDocument();
  });

  describe('CreateProposalRevisionPanel wiring (D-027 §8, Stage 7D)', () => {
    it('renders the Create Revision panel for an authorized TRAVEL_CONSULTANT, wired to the resolved Proposal id', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockResolvedValue(proposalDetail());

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByRole('heading', { name: 'Create Revision' })).toBeInTheDocument();
      const textarea = screen.getByLabelText('Revision content');
      fireEvent.change(textarea, { target: { value: 'Day 2: additional stop.' } });
      await userEvent.setup().click(screen.getByRole('button', { name: 'Create Revision' }));

      // Proves the exact resolved Proposal id (this page's own already-
      // validated `proposalId`, never a user-entered value) is what the
      // panel actually submits to — not merely that the panel is present.
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/proposals/${PROPOSAL_ID}/versions`,
          expect.anything(),
        ),
      );
    });

    it('does not render the Create Revision panel for ADMIN_MANAGER', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getProposalByIdMock.mockResolvedValue(proposalDetail());

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('heading', { name: 'Create Revision' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Revision content')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create Revision' })).not.toBeInTheDocument();
    });

    it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
      'does not render the Create Revision panel for excluded role %s',
      async (role) => {
        getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

        const jsx = await AdminProposalDetailPage({ params: params() });
        render(jsx);

        expect(screen.queryByRole('heading', { name: 'Create Revision' })).not.toBeInTheDocument();
      },
    );

    it('does not render the panel for a malformed Proposal id (not-found state)', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);

      const jsx = await AdminProposalDetailPage({ params: params('not-a-uuid') });
      render(jsx);

      expect(screen.queryByRole('heading', { name: 'Create Revision' })).not.toBeInTheDocument();
      expect(getProposalByIdMock).not.toHaveBeenCalled();
    });

    it('does not render the panel when the Proposal is not found or forbidden', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockRejectedValue(
        new ProposalError('PROPOSAL_FORBIDDEN', 'Proposal not found or not accessible.'),
      );

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('heading', { name: 'Create Revision' })).not.toBeInTheDocument();
    });

    it('does not render the panel and rethrows on an unexpected getProposalById failure', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockRejectedValue(new Error('unexpected failure'));

      await expect(AdminProposalDetailPage({ params: params() })).rejects.toThrow(
        'unexpected failure',
      );
    });

    it('preserves existing Proposal detail and version history alongside the revision panel', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockResolvedValue(proposalDetail());

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByRole('heading', { name: 'Proposal' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Version history' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Version 1' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Create Revision' })).toBeInTheDocument();
    });

    it('renders no standalone Accept/Decline/Request-Changes buttons for TRAVEL_CONSULTANT (response recording uses a single select-based panel, never separate named buttons)', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockResolvedValue(proposalDetail());

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('button', { name: /^accept$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^decline$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
    });
  });

  describe('Publish action wiring (D-027 §5, Stage 7E)', () => {
    it('renders an eligible publish action for an authorized TRAVEL_CONSULTANT, wired to the exact target-version URL', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockResolvedValue(proposalDetail());
      fetchMock.mockResolvedValue(jsonResponse(200, { version: { id: 'version-1' } }));

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      const publishButton = screen.getByRole('button', { name: 'Publish Version 1' });
      expect(publishButton).toBeInTheDocument();
      await userEvent.setup().click(publishButton);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/proposals/versions/version-1/publish',
          expect.anything(),
        ),
      );
    });

    it('retains the Create Revision panel alongside the publish action for TRAVEL_CONSULTANT', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockResolvedValue(proposalDetail());

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByRole('button', { name: 'Publish Version 1' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Create Revision' })).toBeInTheDocument();
    });

    it('renders no publish action for ADMIN_MANAGER, even for an eligible draft', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getProposalByIdMock.mockResolvedValue(proposalDetail());

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    });

    it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
      'renders no publish action for excluded role %s',
      async (role) => {
        getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

        const jsx = await AdminProposalDetailPage({ params: params() });
        render(jsx);

        expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
      },
    );

    it('renders no publish action for a malformed Proposal id (not-found state)', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);

      const jsx = await AdminProposalDetailPage({ params: params('not-a-uuid') });
      render(jsx);

      expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
      expect(getProposalByIdMock).not.toHaveBeenCalled();
    });

    it('renders no publish action when the Proposal is not found or forbidden', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockRejectedValue(
        new ProposalError('PROPOSAL_FORBIDDEN', 'Proposal not found or not accessible.'),
      );

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    });

    it('renders no publish action and rethrows on an unexpected getProposalById failure', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockRejectedValue(new Error('unexpected failure'));

      await expect(AdminProposalDetailPage({ params: params() })).rejects.toThrow(
        'unexpected failure',
      );
    });
  });

  describe('RecordProposalResponsePanel wiring (D-027 §7/§9.1, Stage 7F)', () => {
    function publishedProposalDetail(
      overrides: Partial<ProposalDetailRecord> = {},
    ): ProposalDetailRecord {
      return proposalDetail({
        versions: [
          {
            id: 'version-1',
            proposalId: PROPOSAL_ID,
            versionNumber: 1,
            content: 'Sample proposal content.',
            clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
            supersededAt: null,
            createdByUserId: 'tc-1',
            createdAt: new Date('2026-08-01T00:00:00Z'),
            updatedAt: new Date('2026-08-01T00:00:00Z'),
            acceptance: null,
          },
        ],
        ...overrides,
      });
    }

    it('renders the response-recording panel for ADMIN_MANAGER on the current unresponded version, wired to the exact target-version URL', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getProposalByIdMock.mockResolvedValue(publishedProposalDetail());
      fetchMock.mockResolvedValue(
        jsonResponse(200, { acceptance: { id: 'acc-1', proposalVersionId: 'version-1' } }),
      );

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      const button = screen.getByRole('button', { name: 'Record Response for Version 1' });
      expect(button).toBeInTheDocument();

      await userEvent.setup().selectOptions(screen.getByLabelText('Response'), 'ACCEPT');
      fireEvent.change(screen.getByLabelText('Client responded at'), {
        target: { value: '2026-08-04T10:00' },
      });
      fireEvent.change(screen.getByLabelText('Response method'), { target: { value: 'Phone' } });
      fireEvent.change(screen.getByLabelText('Evidence reference'), {
        target: { value: 'Call log #1' },
      });
      await userEvent.setup().click(button);

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/proposals/versions/version-1/response',
          expect.anything(),
        ),
      );
    });

    it('renders the response-recording panel for an authorized TRAVEL_CONSULTANT on the current unresponded version', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockResolvedValue(publishedProposalDetail());

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(
        screen.getByRole('button', { name: 'Record Response for Version 1' }),
      ).toBeInTheDocument();
    });

    it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
      'renders no response-recording panel for excluded role %s (existing denial behavior preserved)',
      async (role) => {
        getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });
        getProposalByIdMock.mockResolvedValue(publishedProposalDetail());

        const jsx = await AdminProposalDetailPage({ params: params() });
        render(jsx);

        expect(screen.getByText('Access denied')).toBeInTheDocument();
        expect(
          screen.queryByRole('heading', { name: 'Record Client Response' }),
        ).not.toBeInTheDocument();
        expect(getProposalByIdMock).not.toHaveBeenCalled();
      },
    );

    it('renders no response-recording panel for a malformed Proposal id (not-found state)', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminProposalDetailPage({ params: params('not-a-uuid') });
      render(jsx);

      expect(
        screen.queryByRole('heading', { name: 'Record Client Response' }),
      ).not.toBeInTheDocument();
      expect(getProposalByIdMock).not.toHaveBeenCalled();
    });

    it('renders no response-recording panel when the Proposal is not found or forbidden', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getProposalByIdMock.mockRejectedValue(
        new ProposalError('PROPOSAL_NOT_FOUND', 'Proposal not found.'),
      );

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(
        screen.queryByRole('heading', { name: 'Record Client Response' }),
      ).not.toBeInTheDocument();
    });

    it('renders no response-recording panel and rethrows on an unexpected getProposalById failure', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getProposalByIdMock.mockRejectedValue(new Error('unexpected failure'));

      await expect(AdminProposalDetailPage({ params: params() })).rejects.toThrow(
        'unexpected failure',
      );
    });

    it('renders no response-recording panel for a draft-only Proposal (no eligible current version)', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getProposalByIdMock.mockResolvedValue(proposalDetail());

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(
        screen.queryByRole('heading', { name: 'Record Client Response' }),
      ).not.toBeInTheDocument();
    });

    it('preserves Travel-Consultant-only revision creation and publishing alongside the shared response-recording capability', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getProposalByIdMock.mockResolvedValue(
        publishedProposalDetail({
          versions: [
            {
              id: 'v2',
              proposalId: PROPOSAL_ID,
              versionNumber: 2,
              content: 'Draft revision.',
              clientVisibleAt: null,
              supersededAt: null,
              createdByUserId: 'tc-1',
              createdAt: new Date('2026-08-02T00:00:00Z'),
              updatedAt: new Date('2026-08-02T00:00:00Z'),
              acceptance: null,
            },
            {
              id: 'version-1',
              proposalId: PROPOSAL_ID,
              versionNumber: 1,
              content: 'Sample proposal content.',
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              createdByUserId: 'tc-1',
              createdAt: new Date('2026-08-01T00:00:00Z'),
              updatedAt: new Date('2026-08-01T00:00:00Z'),
              acceptance: null,
            },
          ],
        }),
      );

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByRole('heading', { name: 'Create Revision' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Publish Version 2' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Record Response for Version 1' }),
      ).toBeInTheDocument();
    });

    it('ADMIN_MANAGER sees the response panel but no revision-creation or publish control, even with an eligible draft present', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getProposalByIdMock.mockResolvedValue(
        publishedProposalDetail({
          versions: [
            {
              id: 'v2',
              proposalId: PROPOSAL_ID,
              versionNumber: 2,
              content: 'Draft revision.',
              clientVisibleAt: null,
              supersededAt: null,
              createdByUserId: 'tc-1',
              createdAt: new Date('2026-08-02T00:00:00Z'),
              updatedAt: new Date('2026-08-02T00:00:00Z'),
              acceptance: null,
            },
            {
              id: 'version-1',
              proposalId: PROPOSAL_ID,
              versionNumber: 1,
              content: 'Sample proposal content.',
              clientVisibleAt: new Date('2026-08-01T00:00:00Z'),
              supersededAt: null,
              createdByUserId: 'tc-1',
              createdAt: new Date('2026-08-01T00:00:00Z'),
              updatedAt: new Date('2026-08-01T00:00:00Z'),
              acceptance: null,
            },
          ],
        }),
      );

      const jsx = await AdminProposalDetailPage({ params: params() });
      render(jsx);

      expect(
        screen.getByRole('button', { name: 'Record Response for Version 1' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Create Revision' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    });
  });
});
