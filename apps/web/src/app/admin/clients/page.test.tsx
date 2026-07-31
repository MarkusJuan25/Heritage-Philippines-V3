// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { listClientsMock } = vi.hoisted(() => ({ listClientsMock: vi.fn() }));
vi.mock('@/features/clients/service', () => ({ listClients: listClientsMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import type { ClientListItem } from '@/features/clients/repository';

import AdminClientsPage from './page';

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

function client(overrides: Partial<ClientListItem> = {}): ClientListItem {
  return {
    id: 'client-1',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
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
  // `vi.resetAllMocks()` in `afterEach` below strips every mock's
  // implementation, including `redirectMock`'s throwing behavior set at
  // creation time — without restoring it here, only the very first test in
  // this file to exercise a redirect would ever see it actually throw
  // (mirrors admin/leads/page.test.tsx's identical discipline).
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('AdminClientsPage', () => {
  it('redirects to /login when there is no session (Layer 3)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminClientsPage({ searchParams: searchParams() })).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(listClientsMock).not.toHaveBeenCalled();
  });

  it('renders the paginated list for an authorized ADMIN_MANAGER', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({
      items: [client({ fullName: 'Juan Dela Cruz' })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminClientsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.getAllByText('Juan Dela Cruz').length).toBeGreaterThan(0);
  });

  it('renders the list for an authorized TRAVEL_CONSULTANT through the same scoped service call', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    listClientsMock.mockResolvedValue({
      items: [client({ fullName: 'Maria Santos' })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminClientsPage({ searchParams: searchParams() });
    render(jsx);

    expect(listClientsMock).toHaveBeenCalledWith(TRAVEL_CONSULTANT, { page: 1, pageSize: 20 });
    expect(screen.getAllByText('Maria Santos').length).toBeGreaterThan(0);
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders an in-place permission-denied state for role %s, never calling listClients',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminClientsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(listClientsMock).not.toHaveBeenCalled();
    },
  );

  it('renders the empty state (no filters) distinctly from a filtered-empty state', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    const jsx = await AdminClientsPage({ searchParams: searchParams() });
    render(jsx);

    expect(
      screen.getByText('No clients yet. Clients created through lead conversion will appear here.'),
    ).toBeInTheDocument();
  });

  it('renders a filtered-empty state with a clear-filters link', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    const jsx = await AdminClientsPage({ searchParams: searchParams({ search: 'nonexistent' }) });
    render(jsx);

    expect(screen.getByText('No clients match this search.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute(
      'href',
      '/admin/clients',
    );
  });

  it('renders a validation-error state for invalid query params, without calling listClients', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminClientsPage({ searchParams: searchParams({ pageSize: '999' }) });
    render(jsx);

    expect(
      screen.getByText('The filter or page parameters in the URL are invalid.'),
    ).toBeInTheDocument();
    expect(listClientsMock).not.toHaveBeenCalled();
  });

  it('parses and forwards search/page/pageSize to listClients exactly', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({ items: [], page: 2, pageSize: 10, total: 0 });

    await AdminClientsPage({
      searchParams: searchParams({ search: 'juan', page: '2', pageSize: '10' }),
    });

    expect(listClientsMock).toHaveBeenCalledWith(ADMIN_MANAGER, {
      search: 'juan',
      page: 2,
      pageSize: 10,
    });
  });

  it('accepts a native-form submission with a blank search as an unfiltered request', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    await AdminClientsPage({ searchParams: searchParams({ search: '' }) });

    expect(listClientsMock).toHaveBeenCalledWith(ADMIN_MANAGER, { page: 1, pageSize: 20 });
  });

  it('redirects to the last valid page when the requested page exceeds it, preserving search and pageSize', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    // ceil(42 / 20) = 3 — page 5 was requested but does not exist.
    listClientsMock.mockResolvedValue({ items: [], page: 5, pageSize: 20, total: 42 });

    await expect(
      AdminClientsPage({ searchParams: searchParams({ page: '5', search: 'juan' }) }),
    ).rejects.toThrow(/^REDIRECT:/);

    expect(redirectMock).toHaveBeenCalledWith('/admin/clients?search=juan&page=3&pageSize=20');
  });

  it('does not redirect when total is 0, even for a requested page other than 1', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({ items: [], page: 5, pageSize: 20, total: 0 });

    const jsx = await AdminClientsPage({ searchParams: searchParams({ page: '5' }) });
    render(jsx);

    expect(redirectMock).not.toHaveBeenCalled();
    expect(
      screen.getByText('No clients yet. Clients created through lead conversion will appear here.'),
    ).toBeInTheDocument();
  });

  it('does not redirect when the requested page is already within range', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({ items: [client()], page: 2, pageSize: 20, total: 21 });

    const jsx = await AdminClientsPage({ searchParams: searchParams({ page: '2' }) });
    render(jsx);

    expect(redirectMock).not.toHaveBeenCalled();
  });

  describe('Previous/Next pagination links (implemented directly on this page)', () => {
    it('disables Previous (no link) on the first page, and links Next preserving the search query', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listClientsMock.mockResolvedValue({ items: [client()], page: 1, pageSize: 20, total: 45 });

      const jsx = await AdminClientsPage({ searchParams: searchParams({ search: 'juan' }) });
      render(jsx);

      expect(screen.getByText('Previous')).not.toHaveAttribute('href');
      const next = screen.getByRole('link', { name: 'Next' });
      expect(next).toHaveAttribute('href', '/admin/clients?search=juan&page=2&pageSize=20');
      expect(screen.getByText('Page 1 of 3 (45 total)')).toBeInTheDocument();
    });

    it('links both Previous and Next on a middle page', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listClientsMock.mockResolvedValue({ items: [client()], page: 2, pageSize: 20, total: 45 });

      const jsx = await AdminClientsPage({ searchParams: searchParams({ page: '2' }) });
      render(jsx);

      expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
        'href',
        '/admin/clients?page=1&pageSize=20',
      );
      expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
        'href',
        '/admin/clients?page=3&pageSize=20',
      );
    });

    it('disables Next (no link) on the last page', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listClientsMock.mockResolvedValue({ items: [client()], page: 3, pageSize: 20, total: 45 });

      const jsx = await AdminClientsPage({ searchParams: searchParams({ page: '3' }) });
      render(jsx);

      expect(screen.getByRole('link', { name: 'Previous' })).toBeInTheDocument();
      expect(screen.getByText('Next')).not.toHaveAttribute('href');
    });

    it('has an accessible navigation landmark', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listClientsMock.mockResolvedValue({ items: [client()], page: 1, pageSize: 20, total: 1 });

      const jsx = await AdminClientsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    });
  });

  it('never renders a Client status filter/badge or a manual Client-creation link (D-025 §1/§3)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({ items: [client()], page: 1, pageSize: 20, total: 1 });

    const jsx = await AdminClientsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /new client/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /create client/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create client/i })).not.toBeInTheDocument();
  });

  it('links each client name to /admin/clients/[id]', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listClientsMock.mockResolvedValue({
      items: [client({ id: 'client-99', fullName: 'Pedro Reyes' })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminClientsPage({ searchParams: searchParams() });
    render(jsx);

    const links = screen.getAllByRole('link', { name: 'Pedro Reyes' });
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/admin/clients/client-99');
    }
  });
});
