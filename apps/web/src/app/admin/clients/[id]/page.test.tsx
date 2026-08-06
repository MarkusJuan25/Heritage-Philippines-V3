// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getClientByIdMock } = vi.hoisted(() => ({ getClientByIdMock: vi.fn() }));
vi.mock('@/features/clients/service', () => ({ getClientById: getClientByIdMock }));

const { redirectMock, routerPushMock, routerRefreshMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  routerPushMock: vi.fn(),
  routerRefreshMock: vi.fn(),
}));
// EditClientForm (rendered by this page) calls useRouter().refresh() on its
// own client-side mutations, and CreateProposalPanel (Stage 7C, rendered
// for TRAVEL_CONSULTANT only) additionally calls useRouter().push() on a
// successful submission — this page itself calls neither, but the whole
// `next/navigation` module is replaced here, so every export any rendered
// child component needs must be provided (mirrors
// admin/leads/[id]/page.test.tsx's identical discipline).
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: routerPushMock, refresh: routerRefreshMock }),
}));

// The real ClientError class — not mocked — so this page's own
// `error instanceof ClientError` checks (CLIENT_NOT_FOUND / CLIENT_FORBIDDEN)
// exercise real logic rather than an unrelated mock class.
import { ClientError } from '@/features/clients/errors';
import type { ClientDetailRecord } from '@/features/clients/repository';

import AdminClientDetailPage from './page';

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

const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function clientDetail(overrides: Partial<ClientDetailRecord> = {}): ClientDetailRecord {
  return {
    id: CLIENT_ID,
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: '+639171234567',
    address: '123 Rizal St, Manila',
    nationality: 'Filipino',
    dateOfBirth: '1990-05-14',
    emergencyContact: 'Maria Dela Cruz — +639179876543',
    notes: 'Prefers email contact',
    createdAt: new Date('2026-07-20T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    assignment: null,
    originatingLeads: [],
    ...overrides,
  };
}

function params(id = CLIENT_ID): Promise<{ id: string }> {
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
  // (mirrors admin/leads/[id]/page.test.tsx's identical discipline).
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  // ClientAssignmentPanel (rendered by this page) fetches the eligible
  // Travel Consultant list on mount for an ADMIN_MANAGER actor — stubbed
  // globally here so every existing test unrelated to that panel's own
  // behavior still renders deterministically, with a safe empty default a
  // test can override.
  fetchMock = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, { items: [], page: 1, pageSize: 100, total: 0 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('AdminClientDetailPage', () => {
  it('redirects to /login when there is no session (Layer 3)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminClientDetailPage({ params: params() })).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(getClientByIdMock).not.toHaveBeenCalled();
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders an in-place permission-denied state for role %s, never calling getClientById',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(getClientByIdMock).not.toHaveBeenCalled();
    },
  );

  it('renders the detail for an authorized ADMIN_MANAGER', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockResolvedValue(clientDetail());

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Juan Dela Cruz' })).toBeInTheDocument();
  });

  it('renders the detail and the same EditClientForm for an authorized TRAVEL_CONSULTANT', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    getClientByIdMock.mockResolvedValue(clientDetail());

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Juan Dela Cruz' })).toBeInTheDocument();
    // Both allowed roles reach the identical editing form — no role branch
    // decides which fields are editable (D-025 §10).
    expect(screen.getByLabelText('Full name')).toHaveValue('Juan Dela Cruz');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(getClientByIdMock).toHaveBeenCalledWith(TRAVEL_CONSULTANT, CLIENT_ID);
  });

  it('renders a not-found state for a malformed id, without calling getClientById', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminClientDetailPage({ params: params('not-a-uuid') });
    render(jsx);

    expect(screen.getByText('Client not found')).toBeInTheDocument();
    expect(getClientByIdMock).not.toHaveBeenCalled();
  });

  it('calls getClientById with the exact actor and Client id', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockResolvedValue(clientDetail());

    await AdminClientDetailPage({ params: params() });

    expect(getClientByIdMock).toHaveBeenCalledWith(ADMIN_MANAGER, CLIENT_ID);
    expect(getClientByIdMock).toHaveBeenCalledTimes(1);
  });

  it('renders a not-found state for CLIENT_NOT_FOUND (ADMIN_MANAGER, genuinely missing)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockRejectedValue(new ClientError('CLIENT_NOT_FOUND', 'Client not found.'));

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Client not found')).toBeInTheDocument();
  });

  it('renders the identical not-found state for CLIENT_FORBIDDEN (never distinguishable from missing)', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    getClientByIdMock.mockRejectedValue(
      new ClientError('CLIENT_FORBIDDEN', 'You do not have access to this client.'),
    );

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Client not found')).toBeInTheDocument();
  });

  it('rethrows an unexpected error rather than rendering a not-found state', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockRejectedValue(new Error('unexpected failure'));

    await expect(AdminClientDetailPage({ params: params() })).rejects.toThrow('unexpected failure');
  });

  it('renders the complete authoritative detail, wiring every editable field into EditClientForm', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockResolvedValue(
      clientDetail({
        assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' },
      }),
    );

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'Juan Dela Cruz' })).toBeInTheDocument();
    // The seven editable fields are rendered (and edited) by EditClientForm
    // — its own test suite covers their initial values (including
    // nullable fields and dateOfBirth) exhaustively; this is a lighter
    // wiring check that the page passes the authoritative read through.
    expect(screen.getByLabelText('Email')).toHaveValue('juan@example.com');
    expect(screen.getByLabelText('Phone')).toHaveValue('+639171234567');
    expect(screen.getByLabelText('Address')).toHaveValue('123 Rizal St, Manila');
    expect(screen.getByLabelText('Nationality')).toHaveValue('Filipino');
    expect(screen.getByLabelText('Date of birth')).toHaveValue('1990-05-14');
    expect(screen.getByLabelText('Emergency contact')).toHaveValue(
      'Maria Dela Cruz — +639179876543',
    );
    expect(screen.getByLabelText('Notes')).toHaveValue('Prefers email contact');
    expect(screen.getByText('Ana Reyes')).toBeInTheDocument();
  });

  it('renders Unassigned when there is no active assignment', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockResolvedValue(clientDetail({ assignment: null }));

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Unassigned')).toBeInTheDocument();
  });

  it('renders the assigned consultant name when assignment is populated', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockResolvedValue(
      clientDetail({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } }),
    );

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Ana Reyes')).toBeInTheDocument();
  });

  it('renders the empty state when there are no originating leads', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockResolvedValue(clientDetail({ originatingLeads: [] }));

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('No originating leads.')).toBeInTheDocument();
  });

  it('renders each originating lead with only id/fullName/status/source/createdAt, linked to /admin/leads/[id]', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getClientByIdMock.mockResolvedValue(
      clientDetail({
        originatingLeads: [
          {
            id: 'lead-1',
            fullName: 'Pedro Reyes',
            status: 'QUALIFIED',
            source: 'Contact page',
            createdAt: new Date('2026-07-18T00:00:00Z'),
          },
        ],
      }),
    );

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    const link = screen.getByRole('link', { name: 'Pedro Reyes' });
    expect(link).toHaveAttribute('href', '/admin/leads/lead-1');
    expect(screen.getByText(/QUALIFIED/)).toBeInTheDocument();
    expect(screen.getByText(/Contact page/)).toBeInTheDocument();
  });

  it('trusts the service-provided originating-lead order and visibility without re-sorting', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    const leads = [
      {
        id: 'lead-2',
        fullName: 'Second Lead',
        status: 'NEW' as const,
        source: 'Referral',
        createdAt: new Date('2026-07-19T00:00:00Z'),
      },
      {
        id: 'lead-1',
        fullName: 'First Lead',
        status: 'QUALIFIED' as const,
        source: 'Contact page',
        createdAt: new Date('2026-07-18T00:00:00Z'),
      },
    ];
    getClientByIdMock.mockResolvedValue(clientDetail({ originatingLeads: leads }));

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/admin/leads/'));
    expect(links.map((link) => link.textContent)).toEqual(['Second Lead', 'First Lead']);
  });

  it('never renders normalizedEmail or normalizedPhone, even if present on the resolved record', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    // Deliberately bypasses the typed `clientDetail` helper: `getClientById`
    // is mocked, so nothing at runtime prevents a malformed implementation
    // from resolving extra fields — this proves the page itself never reads
    // or renders them even if they were present.
    getClientByIdMock.mockResolvedValue({
      ...clientDetail(),
      normalizedEmail: 'normalized-marker@example.com',
      normalizedPhone: '+639170000000',
    });

    const jsx = await AdminClientDetailPage({ params: params() });
    render(jsx);

    expect(screen.queryByText('normalized-marker@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('+639170000000')).not.toBeInTheDocument();
  });

  describe('Stage F4 — ClientAssignmentPanel wiring (D-025 §2/§10)', () => {
    it('renders the interactive assignment panel for ADMIN_MANAGER, with the eligible list loaded', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getClientByIdMock.mockResolvedValue(clientDetail({ assignment: null }));
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          items: [{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      );

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByText('Assigned Consultant:')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: 'Assign to' })).toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/assignments/travel-consultants?page=1&pageSize=100',
      );
    });

    it('renders only a read-only assignment summary for TRAVEL_CONSULTANT, with no mutation controls and no eligible-list fetch', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getClientByIdMock.mockResolvedValue(
        clientDetail({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } }),
      );

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByText('Assigned Consultant:')).toBeInTheDocument();
      expect(screen.getByText('Ana Reyes')).toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /end assignment/i })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes the authoritative current assignment and the actor role into ClientAssignmentPanel', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getClientByIdMock.mockResolvedValue(
        clientDetail({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } }),
      );

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      // ADMIN_MANAGER's own role reaches the interactive branch (an End
      // Assignment control only renders when a current assignment exists,
      // proving `currentAssignment` reached the panel), and the confirmed
      // name is the exact one `getClientById` returned.
      expect(screen.getByText('Ana Reyes')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'End assignment' })).toBeInTheDocument(),
      );
    });
  });

  describe('CreateProposalPanel wiring (D-027 §8, Stage 7C)', () => {
    it('renders the Create Proposal / ROS panel for an authorized TRAVEL_CONSULTANT, wired to the resolved Client id', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getClientByIdMock.mockResolvedValue(clientDetail());
      fetchMock.mockResolvedValue(
        jsonResponse(201, { proposal: { id: 'proposal-1', clientId: CLIENT_ID }, version: {} }),
      );

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByRole('heading', { name: 'Proposal / ROS' })).toBeInTheDocument();
      const textarea = screen.getByLabelText('Proposal content');
      fireEvent.change(textarea, { target: { value: 'Day 1: Arrival.' } });
      await userEvent.setup().click(screen.getByRole('button', { name: 'Create Proposal / ROS' }));

      // Proves the exact resolved Client id (this page's own already-
      // validated `clientId`, never a user-entered value) is what the panel
      // actually submits — not merely that the panel is present.
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/proposals', expect.anything()),
      );
      const call = fetchMock.mock.calls.find(([url]) => url === '/api/proposals');
      const [, init] = call as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.clientId).toBe(CLIENT_ID);
    });

    it('does not render any Create Proposal form or button for ADMIN_MANAGER', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getClientByIdMock.mockResolvedValue(clientDetail());

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('heading', { name: 'Proposal / ROS' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Proposal content')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Create Proposal / ROS' }),
      ).not.toBeInTheDocument();
    });

    it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
      'does not render the Create Proposal panel for excluded role %s',
      async (role) => {
        getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

        const jsx = await AdminClientDetailPage({ params: params() });
        render(jsx);

        expect(screen.queryByRole('heading', { name: 'Proposal / ROS' })).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Proposal content')).not.toBeInTheDocument();
      },
    );

    it('does not render the panel for a malformed Client id (not-found state)', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);

      const jsx = await AdminClientDetailPage({ params: params('not-a-uuid') });
      render(jsx);

      expect(screen.queryByRole('heading', { name: 'Proposal / ROS' })).not.toBeInTheDocument();
      expect(getClientByIdMock).not.toHaveBeenCalled();
    });

    it('does not render the panel when the Client is not found or forbidden', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getClientByIdMock.mockRejectedValue(
        new ClientError('CLIENT_FORBIDDEN', 'You do not have access to this client.'),
      );

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('heading', { name: 'Proposal / ROS' })).not.toBeInTheDocument();
    });

    it('does not render the panel and rethrows on an unexpected getClientById failure', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getClientByIdMock.mockRejectedValue(new Error('unexpected failure'));

      await expect(AdminClientDetailPage({ params: params() })).rejects.toThrow(
        'unexpected failure',
      );
    });

    it('renders no revision-creation, publish, Accept, Decline, or Request Changes control anywhere on the page', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getClientByIdMock.mockResolvedValue(clientDetail());

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /revision/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^accept$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^decline$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /request changes/i })).not.toBeInTheDocument();
    });

    it('never links to /admin/proposals/new and never renders a Client search/picker input', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getClientByIdMock.mockResolvedValue(clientDetail());

      const jsx = await AdminClientDetailPage({ params: params() });
      render(jsx);

      const links = screen.getAllByRole('link');
      expect(links.every((link) => link.getAttribute('href') !== '/admin/proposals/new')).toBe(
        true,
      );
      expect(screen.queryByRole('link', { name: /new proposal/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
  });
});
