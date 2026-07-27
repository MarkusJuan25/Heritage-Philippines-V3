// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { listLeadsMock } = vi.hoisted(() => ({ listLeadsMock: vi.fn() }));
vi.mock('@/features/leads/service', () => ({ listLeads: listLeadsMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import type { LeadRecordWithAssignment } from '@/features/leads/repository';

import AdminLeadsPage from './page';

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

function lead(overrides: Partial<LeadRecordWithAssignment> = {}): LeadRecordWithAssignment {
  return {
    id: 'lead-1',
    status: 'NEW',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: null,
    normalizedEmail: 'juan@example.com',
    normalizedPhone: null,
    source: 'Contact page',
    notes: null,
    clientId: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    assignment: null,
    ...overrides,
  };
}

function searchParams(
  params: Record<string, string> = {},
): Promise<{ [key: string]: string | string[] | undefined }> {
  return Promise.resolve(params);
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('AdminLeadsPage', () => {
  it('redirects to /login when there is no session (Layer 3)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminLeadsPage({ searchParams: searchParams() })).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(listLeadsMock).not.toHaveBeenCalled();
  });

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'])(
    'renders a keyboard-accessible New Lead link to /admin/leads/new for role %s (D-023 §4)',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });
      listLeadsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

      const jsx = await AdminLeadsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByRole('link', { name: 'New Lead' })).toHaveAttribute(
        'href',
        '/admin/leads/new',
      );
    },
  );

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders an in-place permission-denied state for role %s, never calling listLeads',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminLeadsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(listLeadsMock).not.toHaveBeenCalled();
    },
  );

  it('renders the paginated list for an authorized ADMIN_MANAGER', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listLeadsMock.mockResolvedValue({
      items: [lead({ fullName: 'Juan Dela Cruz' })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminLeadsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.getAllByText('Juan Dela Cruz').length).toBeGreaterThan(0);
  });

  it('renders the empty state (no filters) distinctly from a filtered-empty state', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listLeadsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    const jsx = await AdminLeadsPage({ searchParams: searchParams() });
    render(jsx);

    expect(
      screen.getByText('No leads yet. Leads created by staff will appear here.'),
    ).toBeInTheDocument();
  });

  it('renders a filtered-empty state with a clear-filters link', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listLeadsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    const jsx = await AdminLeadsPage({ searchParams: searchParams({ search: 'nonexistent' }) });
    render(jsx);

    expect(screen.getByText('No leads match these filters.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute(
      'href',
      '/admin/leads',
    );
  });

  it('renders a validation-error state for invalid query params, without calling listLeads', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminLeadsPage({ searchParams: searchParams({ pageSize: '999' }) });
    render(jsx);

    expect(
      screen.getByText('The filter or page parameters in the URL are invalid.'),
    ).toBeInTheDocument();
    expect(listLeadsMock).not.toHaveBeenCalled();
  });

  it('parses and forwards status/source/search filters to listLeads', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    listLeadsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    await AdminLeadsPage({
      searchParams: searchParams({ status: 'QUALIFIED', source: 'Contact page', search: 'juan' }),
    });

    expect(listLeadsMock).toHaveBeenCalledWith(TRAVEL_CONSULTANT, {
      status: 'QUALIFIED',
      source: 'Contact page',
      search: 'juan',
      page: 1,
      pageSize: 20,
    });
  });

  it('renders the assigned consultant name from the additive assignment field (D-023 §5)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listLeadsMock.mockResolvedValue({
      items: [lead({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminLeadsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.getAllByText('Ana Reyes').length).toBeGreaterThan(0);
  });

  describe('Stage 3 correction — Finding 1 (native GET form blank values)', () => {
    it('accepts a native-form submission with blank status/source alongside a real search value', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

      await AdminLeadsPage({
        searchParams: searchParams({ search: 'juan', status: '', source: '' }),
      });

      expect(listLeadsMock).toHaveBeenCalledWith(ADMIN_MANAGER, {
        search: 'juan',
        page: 1,
        pageSize: 20,
      });
    });

    it('accepts an entirely blank native-form submission as an unfiltered request', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

      await AdminLeadsPage({
        searchParams: searchParams({ search: '', status: '', source: '' }),
      });

      expect(listLeadsMock).toHaveBeenCalledWith(ADMIN_MANAGER, { page: 1, pageSize: 20 });
    });

    it('still rejects a non-blank invalid status value — normalization never masks a real validation failure', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminLeadsPage({ searchParams: searchParams({ status: 'NOT_A_STATUS' }) });
      render(jsx);

      expect(
        screen.getByText('The filter or page parameters in the URL are invalid.'),
      ).toBeInTheDocument();
      expect(listLeadsMock).not.toHaveBeenCalled();
    });

    it('still rejects an out-of-range non-blank pageSize', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminLeadsPage({ searchParams: searchParams({ pageSize: '999' }) });
      render(jsx);

      expect(
        screen.getByText('The filter or page parameters in the URL are invalid.'),
      ).toBeInTheDocument();
      expect(listLeadsMock).not.toHaveBeenCalled();
    });
  });

  describe('Stage 3 correction — Finding 2 (out-of-range pagination)', () => {
    it('redirects to the last valid page when the requested page exceeds it, preserving filters and pageSize', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      // ceil(42 / 20) = 3 — page 5 was requested but does not exist.
      listLeadsMock.mockResolvedValue({ items: [], page: 5, pageSize: 20, total: 42 });

      await expect(
        AdminLeadsPage({
          searchParams: searchParams({ page: '5', status: 'QUALIFIED', search: 'juan' }),
        }),
      ).rejects.toThrow(/^REDIRECT:/);

      expect(redirectMock).toHaveBeenCalledWith(
        '/admin/leads?status=QUALIFIED&search=juan&page=3&pageSize=20',
      );
    });

    it('does not redirect when total is 0, even for a requested page other than 1', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockResolvedValue({ items: [], page: 5, pageSize: 20, total: 0 });

      const jsx = await AdminLeadsPage({ searchParams: searchParams({ page: '5' }) });
      render(jsx);

      expect(redirectMock).not.toHaveBeenCalled();
      expect(
        screen.getByText('No leads yet. Leads created by staff will appear here.'),
      ).toBeInTheDocument();
    });

    it('does not redirect when the requested page is already within range', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listLeadsMock.mockResolvedValue({
        items: [lead()],
        page: 2,
        pageSize: 20,
        total: 21,
      });

      const jsx = await AdminLeadsPage({ searchParams: searchParams({ page: '2' }) });
      render(jsx);

      expect(redirectMock).not.toHaveBeenCalled();
    });
  });
});
