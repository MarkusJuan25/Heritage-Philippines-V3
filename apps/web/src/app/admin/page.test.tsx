// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

const { listLeadsMock, listClientsMock, listProposalsMock, listBookingsMock } = vi.hoisted(() => ({
  listLeadsMock: vi.fn(),
  listClientsMock: vi.fn(),
  listProposalsMock: vi.fn(),
  listBookingsMock: vi.fn(),
}));
vi.mock('@/features/leads/service', () => ({ listLeads: listLeadsMock }));
vi.mock('@/features/clients/service', () => ({ listClients: listClientsMock }));
vi.mock('@/features/proposals/service', () => ({ listProposals: listProposalsMock }));
vi.mock('@/features/bookings/service', () => ({ listBookings: listBookingsMock }));

// The real LeadStatus enum — not mocked — so the page's own
// `status: LeadStatus.NEW` argument, and this file's own assertions
// against it, exercise the real generated value rather than an unrelated
// string literal that happens to coincide.
import { LeadStatus } from '@/generated/prisma/client';

import AdminDashboardPage from './page';

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

const LEAD_ITEM = {
  id: 'lead-1',
  fullName: 'Juan Dela Cruz',
  status: 'NEW',
  createdAt: new Date('2026-08-01T00:00:00Z'),
};
const CLIENT_ITEM = {
  id: 'client-1',
  fullName: 'Maria Santos',
  createdAt: new Date('2026-08-02T00:00:00Z'),
};
const PROPOSAL_ITEM = {
  id: 'proposal-1',
  createdAt: new Date('2026-08-03T00:00:00Z'),
  client: { id: 'client-1', fullName: 'Maria Santos' },
};
const BOOKING_ITEM = {
  id: 'booking-1',
  bookingReference: 'HPB-AAAAAAAAAAAAAAAAAAAA',
  status: 'CONFIRMED',
  createdAt: new Date('2026-08-04T00:00:00Z'),
};

function emptyResult(pageSize: number) {
  return { items: [], page: 1, pageSize, total: 0 };
}

/** Finds the exact metric `<dt>` by its label, walks up to the `<dl>` it
 * belongs to, and returns that same `<dl>`'s own `<dd>` — never a broader
 * dashboard-wide ancestor. Every metric label (e.g. "New inquiries") is
 * used only inside its own `<dl>`, so `getByText(label, { selector: 'dt'
 * })` is already unambiguous; scoping to the paired `<dd>` additionally
 * guarantees the numeric assertion can never accidentally match text
 * elsewhere on the page (e.g. a rendered date). */
function getMetricValue(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  expect(term.tagName).toBe('DT');

  const metric = term.closest('dl');
  expect(metric).not.toBeNull();

  const value = metric?.querySelector('dd');
  expect(value).not.toBeNull();

  return value as HTMLElement;
}

/** Sets a safe, non-empty default for every mock — explicit per-test valid
 * defaults so one test's service behavior can never leak into another. */
function setDefaultMocks() {
  listLeadsMock.mockImplementation((_actor: unknown, query: { status?: string }) => {
    if (query.status === LeadStatus.NEW) {
      return Promise.resolve({ items: [], page: 1, pageSize: 1, total: 0 });
    }
    return Promise.resolve({ items: [LEAD_ITEM], page: 1, pageSize: 5, total: 1 });
  });
  listClientsMock.mockResolvedValue({ items: [CLIENT_ITEM], page: 1, pageSize: 5, total: 1 });
  listProposalsMock.mockResolvedValue({ items: [PROPOSAL_ITEM], page: 1, pageSize: 5, total: 1 });
  listBookingsMock.mockResolvedValue({ items: [BOOKING_ITEM], page: 1, pageSize: 5, total: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  // `vi.clearAllMocks()` clears call history only, per Vitest's documented
  // behavior — it never strips an implementation. `redirectMock`'s
  // throwing implementation was set once at `vi.hoisted(...)` and is never
  // reset here, matching the corrected Stage 2A mock-lifecycle discipline
  // (D-029 Stage 2A Correction Pass 1).
  setDefaultMocks();
});

describe('AdminDashboardPage', () => {
  describe('Authentication and authorization', () => {
    it('redirects to /login when there is no session, calling no service', async () => {
      getCurrentUserMock.mockResolvedValue(null);

      await expect(AdminDashboardPage()).rejects.toThrow('REDIRECT:/login');
      expect(redirectMock).toHaveBeenCalledWith('/login');
      expect(listLeadsMock).not.toHaveBeenCalled();
      expect(listClientsMock).not.toHaveBeenCalled();
      expect(listProposalsMock).not.toHaveBeenCalled();
      expect(listBookingsMock).not.toHaveBeenCalled();
    });

    it.each(['SYSTEM_ADMINISTRATOR', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'CLIENT'])(
      'renders "Access denied" for excluded role %s, calling no service',
      async (role) => {
        getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

        const jsx = await AdminDashboardPage();
        render(jsx);

        expect(screen.getByText('Access denied')).toBeInTheDocument();
        expect(listLeadsMock).not.toHaveBeenCalled();
        expect(listClientsMock).not.toHaveBeenCalled();
        expect(listProposalsMock).not.toHaveBeenCalled();
        expect(listBookingsMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('Exact data-access contract (D-029 §6/§8)', () => {
    it.each([
      ['ADMIN_MANAGER', ADMIN_MANAGER],
      ['TRAVEL_CONSULTANT', TRAVEL_CONSULTANT],
    ])(
      'issues exactly five service calls with the exact actor and query for %s',
      async (_label, actor) => {
        getCurrentUserMock.mockResolvedValue(actor);

        const jsx = await AdminDashboardPage();
        render(jsx);

        expect(listLeadsMock).toHaveBeenCalledTimes(2);
        expect(listLeadsMock).toHaveBeenNthCalledWith(1, actor, {
          status: LeadStatus.NEW,
          page: 1,
          pageSize: 1,
        });
        expect(listLeadsMock).toHaveBeenNthCalledWith(2, actor, { page: 1, pageSize: 5 });

        expect(listClientsMock).toHaveBeenCalledTimes(1);
        expect(listClientsMock).toHaveBeenCalledWith(actor, { page: 1, pageSize: 5 });

        expect(listProposalsMock).toHaveBeenCalledTimes(1);
        expect(listProposalsMock).toHaveBeenCalledWith(actor, { page: 1, pageSize: 5 });

        expect(listBookingsMock).toHaveBeenCalledTimes(1);
        expect(listBookingsMock).toHaveBeenCalledWith(actor, { page: 1, pageSize: 5 });

        const totalCalls =
          listLeadsMock.mock.calls.length +
          listClientsMock.mock.calls.length +
          listProposalsMock.mock.calls.length +
          listBookingsMock.mock.calls.length;
        expect(totalCalls).toBe(5);
      },
    );

    it('reuses the single Clients result for both its metric and its list — never a second Clients call', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listClientsMock.mockResolvedValue({
        items: [CLIENT_ITEM],
        page: 1,
        pageSize: 5,
        total: 7,
      });

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(listClientsMock).toHaveBeenCalledTimes(1);
      expect(getMetricValue('Total Clients')).toHaveTextContent(/^7$/);
      expect(screen.getByRole('link', { name: 'Maria Santos' })).toBeInTheDocument();
    });

    it('reuses the single Proposals result for both its metric and its list — never a second Proposals call', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listProposalsMock.mockResolvedValue({
        items: [PROPOSAL_ITEM],
        page: 1,
        pageSize: 5,
        total: 3,
      });

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(listProposalsMock).toHaveBeenCalledTimes(1);
      expect(getMetricValue('Total Proposals')).toHaveTextContent(/^3$/);
      expect(screen.getByRole('link', { name: 'Proposal for Maria Santos' })).toBeInTheDocument();
    });

    it('reuses the single Bookings result for both its metric and its list — never a second Bookings call', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listBookingsMock.mockResolvedValue({
        items: [BOOKING_ITEM],
        page: 1,
        pageSize: 5,
        total: 9,
      });

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(listBookingsMock).toHaveBeenCalledTimes(1);
      expect(getMetricValue('Total Bookings')).toHaveTextContent(/^9$/);
      expect(screen.getByRole('link', { name: 'HPB-AAAAAAAAAAAAAAAAAAAA' })).toBeInTheDocument();
    });
  });

  describe('Leads section', () => {
    it('renders the New-inquiries metric value, including zero', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockImplementation((_actor: unknown, query: { status?: string }) =>
        query.status === LeadStatus.NEW
          ? Promise.resolve({ items: [], page: 1, pageSize: 1, total: 0 })
          : Promise.resolve({ items: [], page: 1, pageSize: 5, total: 0 }),
      );

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('New inquiries')).toHaveTextContent(/^0$/);
    });

    it('a zero New-inquiries count never hides a non-empty Recent Leads list', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockImplementation((_actor: unknown, query: { status?: string }) =>
        query.status === LeadStatus.NEW
          ? Promise.resolve({ items: [], page: 1, pageSize: 1, total: 0 })
          : Promise.resolve({ items: [LEAD_ITEM], page: 1, pageSize: 5, total: 1 }),
      );

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('New inquiries')).toHaveTextContent(/^0$/);
      expect(screen.getByRole('link', { name: 'Juan Dela Cruz' })).toBeInTheDocument();
      expect(
        screen.queryByText('No leads yet. Leads created by staff will appear here.'),
      ).not.toBeInTheDocument();
    });

    it("renders the Leads empty state when the Recent Leads call's own items.length is 0, regardless of the New-inquiries count", async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockImplementation((_actor: unknown, query: { status?: string }) =>
        query.status === LeadStatus.NEW
          ? Promise.resolve({ items: [], page: 1, pageSize: 1, total: 4 })
          : Promise.resolve(emptyResult(5)),
      );

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('New inquiries')).toHaveTextContent(/^4$/);
      expect(
        screen.getByText('No leads yet. Leads created by staff will appear here.'),
      ).toBeInTheDocument();
    });

    it('renders exactly fullName as link text, human-readable status, and createdAt, linking to the Lead detail page', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      render(jsx);

      const link = screen.getByRole('link', { name: 'Juan Dela Cruz' });
      expect(link).toHaveAttribute('href', '/admin/leads/lead-1');
      expect(screen.getByText('New')).toBeInTheDocument();
      const timeEl = screen.getByText(LEAD_ITEM.createdAt.toLocaleDateString('en-PH'));
      expect(timeEl.tagName).toBe('TIME');
      expect(timeEl).toHaveAttribute('dateTime', LEAD_ITEM.createdAt.toISOString());
    });

    it('renders "View all leads" linking to /admin/leads', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(screen.getByRole('link', { name: 'View all leads' })).toHaveAttribute(
        'href',
        '/admin/leads',
      );
    });
  });

  describe('Clients section', () => {
    it('renders the Total Clients metric value, including zero', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listClientsMock.mockResolvedValue(emptyResult(5));

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('Total Clients')).toHaveTextContent(/^0$/);
    });

    it('renders the exact empty state when Clients has no items, even with a nonzero total', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listClientsMock.mockResolvedValue({ items: [], page: 1, pageSize: 5, total: 12 });

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('Total Clients')).toHaveTextContent(/^12$/);
      expect(
        screen.getByText(
          'No clients yet. Clients created through lead conversion will appear here.',
        ),
      ).toBeInTheDocument();
    });

    it('renders exactly fullName as link text and createdAt, linking to the Client detail page', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      render(jsx);

      const link = screen.getByRole('link', { name: 'Maria Santos' });
      expect(link).toHaveAttribute('href', '/admin/clients/client-1');
      const timeEl = screen.getByText(CLIENT_ITEM.createdAt.toLocaleDateString('en-PH'));
      expect(timeEl.tagName).toBe('TIME');
      expect(timeEl).toHaveAttribute('dateTime', CLIENT_ITEM.createdAt.toISOString());
    });

    it('renders "View all clients" linking to /admin/clients', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(screen.getByRole('link', { name: 'View all clients' })).toHaveAttribute(
        'href',
        '/admin/clients',
      );
    });
  });

  describe('Proposals section', () => {
    it('renders the Total Proposals metric value, including zero', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listProposalsMock.mockResolvedValue(emptyResult(5));

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('Total Proposals')).toHaveTextContent(/^0$/);
    });

    it('renders the exact empty state when Proposals has no items, even with a nonzero total', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listProposalsMock.mockResolvedValue({ items: [], page: 1, pageSize: 5, total: 8 });

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('Total Proposals')).toHaveTextContent(/^8$/);
      expect(screen.getByText('No proposals yet.')).toBeInTheDocument();
    });

    it('renders exactly "Proposal for {client.fullName}" as link text and createdAt, linking to the Proposal detail page, exposing no version/content/acceptance data', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      render(jsx);

      const link = screen.getByRole('link', { name: 'Proposal for Maria Santos' });
      expect(link).toHaveAttribute('href', '/admin/proposals/proposal-1');
      const timeEl = screen.getByText(PROPOSAL_ITEM.createdAt.toLocaleDateString('en-PH'));
      expect(timeEl.tagName).toBe('TIME');
      expect(timeEl).toHaveAttribute('dateTime', PROPOSAL_ITEM.createdAt.toISOString());
    });

    it('renders "View all proposals" linking to /admin/proposals', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(screen.getByRole('link', { name: 'View all proposals' })).toHaveAttribute(
        'href',
        '/admin/proposals',
      );
    });
  });

  describe('Bookings section', () => {
    it('renders the Total Bookings metric value, including zero', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listBookingsMock.mockResolvedValue(emptyResult(5));

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('Total Bookings')).toHaveTextContent(/^0$/);
    });

    it('renders the exact empty state when Bookings has no items, even with a nonzero total', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listBookingsMock.mockResolvedValue({ items: [], page: 1, pageSize: 5, total: 15 });

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(getMetricValue('Total Bookings')).toHaveTextContent(/^15$/);
      expect(screen.getByText('No bookings yet.')).toBeInTheDocument();
    });

    it('renders exactly bookingReference as link text, human-readable status, and createdAt, linking to the Booking detail page', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      render(jsx);

      const link = screen.getByRole('link', { name: 'HPB-AAAAAAAAAAAAAAAAAAAA' });
      expect(link).toHaveAttribute('href', '/admin/bookings/booking-1');
      expect(screen.getByText('Confirmed')).toBeInTheDocument();
      const timeEl = screen.getByText(BOOKING_ITEM.createdAt.toLocaleDateString('en-PH'));
      expect(timeEl.tagName).toBe('TIME');
      expect(timeEl).toHaveAttribute('dateTime', BOOKING_ITEM.createdAt.toISOString());
    });

    it('renders "View all bookings" linking to /admin/bookings', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      render(jsx);

      expect(screen.getByRole('link', { name: 'View all bookings' })).toHaveAttribute(
        'href',
        '/admin/bookings',
      );
    });
  });

  describe('Failure propagation (D-029 §9)', () => {
    it('rejects the whole page when the New-inquiries call fails, never resolving to a partial dashboard', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockImplementation((_actor: unknown, query: { status?: string }) =>
        query.status === LeadStatus.NEW
          ? Promise.reject(new Error('unexpected New-inquiries failure'))
          : Promise.resolve({ items: [LEAD_ITEM], page: 1, pageSize: 5, total: 1 }),
      );

      await expect(AdminDashboardPage()).rejects.toThrow('unexpected New-inquiries failure');
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Dashboard overview' }),
      ).not.toBeInTheDocument();
    });

    it('rejects the whole page when the Recent Leads call fails', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockImplementation((_actor: unknown, query: { status?: string }) =>
        query.status === LeadStatus.NEW
          ? Promise.resolve({ items: [], page: 1, pageSize: 1, total: 0 })
          : Promise.reject(new Error('unexpected Recent Leads failure')),
      );

      await expect(AdminDashboardPage()).rejects.toThrow('unexpected Recent Leads failure');
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Dashboard overview' }),
      ).not.toBeInTheDocument();
    });

    it('rejects the whole page when the Clients call fails', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listClientsMock.mockRejectedValue(new Error('unexpected Clients failure'));

      await expect(AdminDashboardPage()).rejects.toThrow('unexpected Clients failure');
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Dashboard overview' }),
      ).not.toBeInTheDocument();
    });

    it('rejects the whole page when the Proposals call fails', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listProposalsMock.mockRejectedValue(new Error('unexpected Proposals failure'));

      await expect(AdminDashboardPage()).rejects.toThrow('unexpected Proposals failure');
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Dashboard overview' }),
      ).not.toBeInTheDocument();
    });

    it('rejects the whole page when the Bookings call fails', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listBookingsMock.mockRejectedValue(new Error('unexpected Bookings failure'));

      await expect(AdminDashboardPage()).rejects.toThrow('unexpected Bookings failure');
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Dashboard overview' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Semantic coverage', () => {
    it('provides the top-level heading, four section headings in order, four metric definition lists, recent-item lists, and semantic time elements', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminDashboardPage();
      const { container } = render(jsx);

      expect(
        screen.getByRole('heading', { level: 1, name: 'Dashboard overview' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Leads' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Clients' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Proposals' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Bookings' })).toBeInTheDocument();

      const sectionHeadings = screen.getAllByRole('heading', { level: 2 });
      expect(sectionHeadings.map((heading) => heading.textContent)).toEqual([
        'Leads',
        'Clients',
        'Proposals',
        'Bookings',
      ]);

      expect(container.querySelectorAll('section')).toHaveLength(4);
      expect(container.querySelectorAll('dl')).toHaveLength(4);
      expect(container.querySelectorAll('ul')).toHaveLength(4);
      expect(container.querySelectorAll('time').length).toBeGreaterThanOrEqual(4);
    });
  });
});
