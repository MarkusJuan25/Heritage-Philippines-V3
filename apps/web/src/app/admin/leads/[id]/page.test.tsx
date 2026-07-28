// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getLeadByIdMock, getLeadStatusHistoryMock } = vi.hoisted(() => ({
  getLeadByIdMock: vi.fn(),
  getLeadStatusHistoryMock: vi.fn(),
}));
vi.mock('@/features/leads/service', () => ({
  getLeadById: getLeadByIdMock,
  getLeadStatusHistory: getLeadStatusHistoryMock,
}));

const { redirectMock, routerRefreshMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  routerRefreshMock: vi.fn(),
}));
// EditLeadForm/StatusTransitionPanel (both rendered by this page) call
// useRouter().refresh() on their own client-side mutations — this page
// itself never calls it, but the whole `next/navigation` module is
// replaced here, so both exports must be provided.
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ refresh: routerRefreshMock }),
}));

// The real LeadError class — not mocked — so this page's own
// `error instanceof LeadError` checks (LEAD_NOT_FOUND / LEAD_FORBIDDEN)
// exercise real logic rather than an unrelated mock class.
import { LeadError } from '@/features/leads/errors';
import type { LeadRecordWithAssignment } from '@/features/leads/repository';

import AdminLeadDetailPage from './page';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};

const LEAD_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function lead(overrides: Partial<LeadRecordWithAssignment> = {}): LeadRecordWithAssignment {
  return {
    id: LEAD_ID,
    status: 'QUALIFIED',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: null,
    normalizedEmail: 'juan@example.com',
    normalizedPhone: null,
    source: 'Contact page',
    notes: 'Called back once',
    clientId: null,
    createdAt: new Date('2026-07-20T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    assignment: null,
    ...overrides,
  };
}

function params(id = LEAD_ID): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

function searchParams(
  values: Record<string, string> = {},
): Promise<{ [key: string]: string | string[] | undefined }> {
  return Promise.resolve(values);
}

beforeEach(() => {
  vi.clearAllMocks();
  getLeadStatusHistoryMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
  // Stage 3 correction: `vi.resetAllMocks()` in `afterEach` below strips
  // every mock's implementation, including `redirectMock`'s throwing
  // behavior set at creation time — without restoring it here, only the
  // very first test in this file to exercise a redirect would ever see it
  // actually throw; every later one would silently fall through instead.
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('AdminLeadDetailPage', () => {
  it('redirects to /login when there is no session (Layer 3)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(
      AdminLeadDetailPage({ params: params(), searchParams: searchParams() }),
    ).rejects.toThrow('REDIRECT:/login');
    expect(getLeadByIdMock).not.toHaveBeenCalled();
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders an in-place permission-denied state for role %s, never calling getLeadById',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(getLeadByIdMock).not.toHaveBeenCalled();
    },
  );

  it('renders a not-found state for a malformed id, without calling getLeadById', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminLeadDetailPage({
      params: params('not-a-uuid'),
      searchParams: searchParams(),
    });
    render(jsx);

    expect(screen.getByText('Lead not found')).toBeInTheDocument();
    expect(getLeadByIdMock).not.toHaveBeenCalled();
  });

  it('renders a not-found state for LEAD_NOT_FOUND (ADMIN_MANAGER, genuinely missing)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getLeadByIdMock.mockRejectedValue(new LeadError('LEAD_NOT_FOUND', 'Lead not found.'));

    const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
    render(jsx);

    expect(screen.getByText('Lead not found')).toBeInTheDocument();
  });

  it('renders the identical not-found state for LEAD_FORBIDDEN (never distinguishable from missing)', async () => {
    getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role: 'TRAVEL_CONSULTANT' });
    getLeadByIdMock.mockRejectedValue(
      new LeadError('LEAD_FORBIDDEN', 'Lead not found or not accessible.'),
    );

    const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
    render(jsx);

    expect(screen.getByText('Lead not found')).toBeInTheDocument();
  });

  it('rethrows an unexpected error rather than rendering a not-found state', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getLeadByIdMock.mockRejectedValue(new Error('unexpected failure'));

    await expect(
      AdminLeadDetailPage({ params: params(), searchParams: searchParams() }),
    ).rejects.toThrow('unexpected failure');
  });

  it('renders Lead fields, status, and Unassigned when there is no active assignment', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getLeadByIdMock.mockResolvedValue(lead({ assignment: null }));

    const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Juan Dela Cruz' })).toBeInTheDocument();
    // "Qualified" now legitimately appears twice (the status badge and
    // StatusTransitionPanel's "Current status:" line) — matches this same
    // file's own established getAllByText pattern for exactly this case.
    expect(screen.getAllByText('Qualified').length).toBeGreaterThan(0);
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('renders the assigned consultant name when assignment is populated (D-023 §5)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getLeadByIdMock.mockResolvedValue(
      lead({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } }),
    );

    const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
    render(jsx);

    expect(screen.getByText('Ana Reyes')).toBeInTheDocument();
  });

  it('renders the paginated status history', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getLeadByIdMock.mockResolvedValue(lead());
    getLeadStatusHistoryMock.mockResolvedValue({
      items: [
        {
          id: 'history-1',
          previousStatus: 'NEW',
          newStatus: 'QUALIFIED',
          changedByUserId: 'admin-1',
          changedByName: 'Admin Manager',
          createdAt: new Date('2026-07-22T00:00:00Z'),
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
    render(jsx);

    expect(screen.getByText(/New/)).toBeInTheDocument();
    expect(screen.getAllByText(/Qualified/).length).toBeGreaterThan(0);
    expect(getLeadStatusHistoryMock).toHaveBeenCalledWith(ADMIN_MANAGER, LEAD_ID, {
      page: 1,
      pageSize: 20,
    });
  });

  it('falls back to default pagination when the history query params are invalid', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getLeadByIdMock.mockResolvedValue(lead());

    await AdminLeadDetailPage({
      params: params(),
      searchParams: searchParams({ pageSize: '999' }),
    });

    expect(getLeadStatusHistoryMock).toHaveBeenCalledWith(ADMIN_MANAGER, LEAD_ID, {
      page: 1,
      pageSize: 20,
    });
  });

  describe('Stage 3 correction — Finding 2 (out-of-range status-history pagination)', () => {
    it('redirects to the last valid history page when the requested page exceeds it, preserving pageSize', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead());
      // ceil(15 / 10) = 2 — page 4 was requested but does not exist.
      getLeadStatusHistoryMock.mockResolvedValue({ items: [], page: 4, pageSize: 10, total: 15 });

      await expect(
        AdminLeadDetailPage({
          params: params(),
          searchParams: searchParams({ page: '4', pageSize: '10' }),
        }),
      ).rejects.toThrow(/^REDIRECT:/);

      expect(redirectMock).toHaveBeenCalledWith(`/admin/leads/${LEAD_ID}?page=2&pageSize=10`);
    });

    it('does not redirect when the history total is 0, even for a requested page other than 1', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead());
      getLeadStatusHistoryMock.mockResolvedValue({ items: [], page: 4, pageSize: 20, total: 0 });

      const jsx = await AdminLeadDetailPage({
        params: params(),
        searchParams: searchParams({ page: '4' }),
      });
      render(jsx);

      expect(redirectMock).not.toHaveBeenCalled();
      expect(screen.getByText('No status history yet.')).toBeInTheDocument();
    });

    it('does not redirect when the requested history page is already within range', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead());
      getLeadStatusHistoryMock.mockResolvedValue({
        items: [
          {
            id: 'history-1',
            previousStatus: 'NEW',
            newStatus: 'QUALIFIED',
            changedByUserId: 'admin-1',
            changedByName: 'Admin Manager',
            createdAt: new Date('2026-07-22T00:00:00Z'),
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(redirectMock).not.toHaveBeenCalled();
    });
  });

  describe('Stage 2 — EditLeadForm/StatusTransitionPanel wiring', () => {
    it('passes the confirmed Lead fields to EditLeadForm, prepopulating it exactly', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(
        lead({
          fullName: 'Juan Dela Cruz',
          source: 'Contact page',
          email: 'juan@example.com',
          phone: null,
          notes: 'Called back once',
        }),
      );

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
      expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
      expect(screen.getByLabelText('Email')).toHaveValue('juan@example.com');
      expect(screen.getByLabelText('Phone')).toHaveValue('');
      expect(screen.getByLabelText('Notes')).toHaveValue('Called back once');
    });

    it('passes the confirmed status and the real transition-matrix options to StatusTransitionPanel for QUALIFIED', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ status: 'QUALIFIED' }));

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      const select = screen.getByLabelText('Change status to');
      const optionLabels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
      // Computed by the real, unmocked features/leads/transitions.ts matrix
      // (D-022 §6) for QUALIFIED — never the current status, never
      // Converted to Client (D-023 §4).
      expect(optionLabels).toEqual([
        'Select a status…',
        'Not Proceeding',
        'Duplicate',
        'Spam',
        'Archived',
      ]);
      expect(screen.queryByRole('option', { name: 'Qualified' })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Converted to Client' })).not.toBeInTheDocument();
    });

    it('locks editing and offers no status transitions for a CONVERTED_TO_CLIENT lead', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ status: 'CONVERTED_TO_CLIENT' }));

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(
        screen.getByText('This lead has been converted to a client and can no longer be edited.'),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
      // Locked, but Source, Email, and Notes remain visible as read-only
      // values (this lead's Phone is null, rendered as an em dash).
      expect(screen.getByText('Contact page')).toBeInTheDocument();
      expect(screen.getByText('juan@example.com')).toBeInTheDocument();
      expect(screen.getByText('Called back once')).toBeInTheDocument();
      expect(
        screen.getByText('No status changes are available for this lead.'),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Change status to')).not.toBeInTheDocument();
    });
  });
});
