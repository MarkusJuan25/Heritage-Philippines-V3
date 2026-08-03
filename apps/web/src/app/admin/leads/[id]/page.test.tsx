// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getLeadByIdMock, getLeadStatusHistoryMock, getConversionOptionsMock } = vi.hoisted(() => ({
  getLeadByIdMock: vi.fn(),
  getLeadStatusHistoryMock: vi.fn(),
  getConversionOptionsMock: vi.fn(),
}));
vi.mock('@/features/leads/service', () => ({
  getLeadById: getLeadByIdMock,
  getLeadStatusHistory: getLeadStatusHistoryMock,
  getConversionOptions: getConversionOptionsMock,
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
  getLeadStatusHistoryMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
  getConversionOptionsMock.mockResolvedValue({
    accessibleMatches: [],
    restrictedMatchDetected: false,
  });
  // Stage 3 correction: `vi.resetAllMocks()` in `afterEach` below strips
  // every mock's implementation, including `redirectMock`'s throwing
  // behavior set at creation time — without restoring it here, only the
  // very first test in this file to exercise a redirect would ever see it
  // actually throw; every later one would silently fall through instead.
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  // LeadAssignmentPanel (rendered by this page, D-026 §10) fetches the
  // eligible Travel Consultant list on mount for an ADMIN_MANAGER actor —
  // stubbed globally here, mirroring admin/clients/[id]/page.test.tsx's
  // identical precedent, so every existing test unrelated to that panel's
  // own behavior still renders deterministically, with a safe empty
  // default a test can override. No other component rendered by this page
  // (EditLeadForm, StatusTransitionPanel, ConvertToClientPanel) issues a
  // `fetch` merely by rendering — only on a user-driven submit none of
  // these tests perform — so this default cannot mask an unrelated
  // request.
  fetchMock = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, { items: [], page: 1, pageSize: 100, total: 0 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  describe('Stage F — ConvertToClientPanel wiring (D-024 §10)', () => {
    it('calls getConversionOptions with the exact actor and Lead id for a QUALIFIED lead', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ status: 'QUALIFIED' }));

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(getConversionOptionsMock).toHaveBeenCalledWith(ADMIN_MANAGER, LEAD_ID);
      expect(getConversionOptionsMock).toHaveBeenCalledTimes(1);
    });

    it('wires the accessible conversion-option candidates into the panel', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ status: 'QUALIFIED' }));
      getConversionOptionsMock.mockResolvedValue({
        accessibleMatches: [{ id: 'client-1', fullName: 'Maria Santos', matchedOn: ['EMAIL'] }],
        restrictedMatchDetected: false,
      });

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(screen.getByLabelText('Maria Santos — matched on Email')).toBeInTheDocument();
      expect(screen.queryByLabelText('Create a new Client')).not.toBeInTheDocument();
    });

    it('wires a restricted-only result into the panel without exposing any candidate metadata', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ status: 'QUALIFIED' }));
      getConversionOptionsMock.mockResolvedValue({
        accessibleMatches: [],
        restrictedMatchDetected: true,
      });

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText(/request Admin\/Manager assistance/)).toBeInTheDocument();
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    });

    it('never renders the panel or calls getConversionOptions for a non-QUALIFIED status (NEW)', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ status: 'NEW' }));

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(getConversionOptionsMock).not.toHaveBeenCalled();
      expect(screen.queryByText('Convert to Client')).not.toBeInTheDocument();
    });

    it('never renders the panel or calls getConversionOptions for a CONVERTED_TO_CLIENT lead', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ status: 'CONVERTED_TO_CLIENT' }));

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(getConversionOptionsMock).not.toHaveBeenCalled();
      expect(screen.queryByText('Convert to Client')).not.toBeInTheDocument();
    });
  });

  describe('Stage 2/3 — LeadAssignmentPanel wiring (D-026 §2/§3/§10)', () => {
    it('renders the interactive assignment panel for ADMIN_MANAGER, requesting the first eligible-consultant page', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ assignment: null }));
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          items: [{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      );

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Assigned Consultant:')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Assign to' })).toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
      // The static "Assigned Consultant" definition-list term is gone —
      // only LeadAssignmentPanel's own "Assigned Consultant:" summary line
      // remains.
      const dtLabels = Array.from(document.querySelectorAll('dt')).map((dt) => dt.textContent);
      expect(dtLabels).not.toContain('Assigned Consultant');
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/assignments/travel-consultants?page=1&pageSize=100',
      );
    });

    it('renders only a read-only assignment summary for TRAVEL_CONSULTANT, with no mutation controls and no eligible-list fetch', async () => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role: 'TRAVEL_CONSULTANT' });
      getLeadByIdMock.mockResolvedValue(
        lead({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } }),
      );

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Assigned Consultant:')).toBeInTheDocument();
      expect(screen.getByText('Ana Reyes')).toBeInTheDocument();
      // StatusTransitionPanel's own status-change `<select>` legitimately
      // renders for TRAVEL_CONSULTANT too (status transitions are not
      // Admin-only) — scoped here to the assignment panel's own control by
      // accessible name, never a blanket "no combobox anywhere" check.
      expect(screen.queryByRole('combobox', { name: 'Assign to' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reassign' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'End assignment' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Reason for reassignment')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Reason for ending assignment')).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes the exact current assignment returned by getLeadById into LeadAssignmentPanel', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(
        lead({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } }),
      );

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      // An End Assignment control only renders when a current assignment
      // exists, proving `currentAssignment` reached the panel unmodified —
      // and the confirmed name is the exact one `getLeadById` returned.
      expect(screen.getByText('Ana Reyes')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'End assignment' })).toBeInTheDocument(),
      );
    });

    it('threads the resolved route Lead ID into the assignment mutation request', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(lead({ assignment: null }));
      fetchMock.mockImplementation((url: string) => {
        if (url.startsWith('/api/assignments/travel-consultants')) {
          return Promise.resolve(
            jsonResponse(200, {
              items: [{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }],
              page: 1,
              pageSize: 100,
              total: 1,
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            assignment: {
              id: 'assignment-1',
              assignedStaffId: 'tc-1',
              assignedByUserId: 'admin-1',
              leadId: LEAD_ID,
              clientId: null,
              bookingId: null,
              createdAt: '2026-07-23T00:00:00.000Z',
              updatedAt: '2026-07-23T00:00:00.000Z',
              endedAt: null,
            },
          }),
        );
      });
      const user = userEvent.setup();

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      await waitFor(() => expect(screen.getByLabelText('Assign to')).toBeInTheDocument());
      await user.selectOptions(screen.getByLabelText('Assign to'), 'tc-1');
      await user.click(screen.getByRole('button', { name: 'Assign' }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/leads/${LEAD_ID}/assignment`,
          expect.objectContaining({ method: 'PUT' }),
        ),
      );
    });

    it('keeps ADMIN_MANAGER assignment controls interactive for a CONVERTED_TO_CLIENT Lead (D-026 §3)', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getLeadByIdMock.mockResolvedValue(
        lead({
          status: 'CONVERTED_TO_CLIENT',
          assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' },
        }),
      );

      const jsx = await AdminLeadDetailPage({ params: params(), searchParams: searchParams() });
      render(jsx);

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'End assignment' })).toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: 'End assignment' })).not.toBeDisabled();
    });
  });
});
