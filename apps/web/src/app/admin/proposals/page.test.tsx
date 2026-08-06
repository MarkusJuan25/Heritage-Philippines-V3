// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { listProposalsMock } = vi.hoisted(() => ({ listProposalsMock: vi.fn() }));
vi.mock('@/features/proposals/service', () => ({ listProposals: listProposalsMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import type { ProposalListItem } from '@/features/proposals/repository';

import AdminProposalsPage from './page';

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

function proposal(overrides: Partial<ProposalListItem> = {}): ProposalListItem {
  return {
    id: 'proposal-1',
    client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
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
  // (mirrors admin/clients/page.test.tsx's identical discipline).
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('AdminProposalsPage', () => {
  it('redirects to /login when there is no session (Layer 3)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminProposalsPage({ searchParams: searchParams() })).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(listProposalsMock).not.toHaveBeenCalled();
  });

  it('renders the paginated list for an authorized ADMIN_MANAGER', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({
      items: [proposal({ client: { id: 'client-1', fullName: 'Juan Dela Cruz' } })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminProposalsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.getAllByText('Juan Dela Cruz').length).toBeGreaterThan(0);
  });

  it('renders the list for an authorized TRAVEL_CONSULTANT through the same scoped service call', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    listProposalsMock.mockResolvedValue({
      items: [proposal({ client: { id: 'client-2', fullName: 'Maria Santos' } })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminProposalsPage({ searchParams: searchParams() });
    render(jsx);

    expect(listProposalsMock).toHaveBeenCalledWith(TRAVEL_CONSULTANT, { page: 1, pageSize: 20 });
    expect(screen.getAllByText('Maria Santos').length).toBeGreaterThan(0);
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders an in-place permission-denied state for role %s, never calling listProposals',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminProposalsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(listProposalsMock).not.toHaveBeenCalled();
    },
  );

  it('parses and forwards the exact actor and pagination query to listProposals', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({ items: [], page: 2, pageSize: 10, total: 0 });

    await AdminProposalsPage({ searchParams: searchParams({ page: '2', pageSize: '10' }) });

    expect(listProposalsMock).toHaveBeenCalledWith(ADMIN_MANAGER, { page: 2, pageSize: 10 });
  });

  it('applies default pagination values when no query params are supplied', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    await AdminProposalsPage({ searchParams: searchParams() });

    expect(listProposalsMock).toHaveBeenCalledWith(ADMIN_MANAGER, { page: 1, pageSize: 20 });
  });

  it('renders a validation-error state for an invalid pageSize, without calling listProposals', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminProposalsPage({ searchParams: searchParams({ pageSize: '999' }) });
    render(jsx);

    expect(screen.getByText('The page parameters in the URL are invalid.')).toBeInTheDocument();
    expect(listProposalsMock).not.toHaveBeenCalled();
  });

  it('renders a validation-error state for an invalid page, without calling listProposals', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminProposalsPage({ searchParams: searchParams({ page: '0' }) });
    render(jsx);

    expect(screen.getByText('The page parameters in the URL are invalid.')).toBeInTheDocument();
    expect(listProposalsMock).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized query key under the strict schema, without calling listProposals', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminProposalsPage({ searchParams: searchParams({ status: 'DRAFT' }) });
    render(jsx);

    expect(screen.getByText('The page parameters in the URL are invalid.')).toBeInTheDocument();
    expect(listProposalsMock).not.toHaveBeenCalled();
  });

  it('renders the empty state when there are no proposals', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    const jsx = await AdminProposalsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.getByText('No proposals yet.')).toBeInTheDocument();
  });

  it('does not redirect when total is 0, even for a requested page other than 1', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({ items: [], page: 5, pageSize: 20, total: 0 });

    const jsx = await AdminProposalsPage({ searchParams: searchParams({ page: '5' }) });
    render(jsx);

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByText('No proposals yet.')).toBeInTheDocument();
  });

  it('redirects to the last valid page when the requested page exceeds it, preserving pageSize', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    // ceil(42 / 20) = 3 — page 5 was requested but does not exist.
    listProposalsMock.mockResolvedValue({ items: [], page: 5, pageSize: 20, total: 42 });

    await expect(AdminProposalsPage({ searchParams: searchParams({ page: '5' }) })).rejects.toThrow(
      /^REDIRECT:/,
    );

    expect(redirectMock).toHaveBeenCalledWith('/admin/proposals?page=3&pageSize=20');
  });

  it('does not redirect when the requested page is already within range', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({
      items: [proposal()],
      page: 2,
      pageSize: 20,
      total: 21,
    });

    const jsx = await AdminProposalsPage({ searchParams: searchParams({ page: '2' }) });
    render(jsx);

    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('renders items in exactly the order returned by the service, never re-sorting them', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({
      items: [
        proposal({ id: 'p1', client: { id: 'c1', fullName: 'Zeta Traveler' } }),
        proposal({ id: 'p2', client: { id: 'c2', fullName: 'Alpha Traveler' } }),
      ],
      page: 1,
      pageSize: 20,
      total: 2,
    });

    const jsx = await AdminProposalsPage({ searchParams: searchParams() });
    const { container } = render(jsx);

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows[0]?.textContent).toContain('Zeta Traveler');
    expect(rows[1]?.textContent).toContain('Alpha Traveler');
  });

  it('propagates an unexpected error from listProposals rather than swallowing it', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockRejectedValue(new Error('unexpected failure'));

    await expect(AdminProposalsPage({ searchParams: searchParams() })).rejects.toThrow(
      'unexpected failure',
    );
  });

  describe('Previous/Next pagination links (shared Pagination component)', () => {
    it('disables Previous (no link) on the first page, and links Next preserving pageSize', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listProposalsMock.mockResolvedValue({
        items: [proposal()],
        page: 1,
        pageSize: 20,
        total: 45,
      });

      const jsx = await AdminProposalsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Previous')).not.toHaveAttribute('href');
      const next = screen.getByRole('link', { name: 'Next' });
      expect(next).toHaveAttribute('href', '/admin/proposals?page=2&pageSize=20');
      expect(screen.getByText('Page 1 of 3 (45 total)')).toBeInTheDocument();
    });

    it('links both Previous and Next on a middle page', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listProposalsMock.mockResolvedValue({
        items: [proposal()],
        page: 2,
        pageSize: 20,
        total: 45,
      });

      const jsx = await AdminProposalsPage({ searchParams: searchParams({ page: '2' }) });
      render(jsx);

      expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
        'href',
        '/admin/proposals?page=1&pageSize=20',
      );
      expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
        'href',
        '/admin/proposals?page=3&pageSize=20',
      );
    });

    it('disables Next (no link) on the last page', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listProposalsMock.mockResolvedValue({
        items: [proposal()],
        page: 3,
        pageSize: 20,
        total: 45,
      });

      const jsx = await AdminProposalsPage({ searchParams: searchParams({ page: '3' }) });
      render(jsx);

      expect(screen.getByRole('link', { name: 'Previous' })).toBeInTheDocument();
      expect(screen.getByText('Next')).not.toHaveAttribute('href');
    });

    it('has an accessible navigation landmark', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listProposalsMock.mockResolvedValue({
        items: [proposal()],
        page: 1,
        pageSize: 20,
        total: 1,
      });

      const jsx = await AdminProposalsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    });
  });

  it('never renders a "Create Proposal" action on this page (D-027 §8)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({ items: [proposal()], page: 1, pageSize: 20, total: 1 });

    const jsx = await AdminProposalsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.queryByRole('link', { name: /create proposal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create proposal/i })).not.toBeInTheDocument();
  });

  it('links each row/card to the Client and to the Proposal detail page', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listProposalsMock.mockResolvedValue({
      items: [
        proposal({ id: 'proposal-99', client: { id: 'client-99', fullName: 'Pedro Reyes' } }),
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminProposalsPage({ searchParams: searchParams() });
    render(jsx);

    const clientLinks = screen.getAllByRole('link', { name: 'Pedro Reyes' });
    for (const link of clientLinks) {
      expect(link).toHaveAttribute('href', '/admin/clients/client-99');
    }
    const proposalLinks = screen.getAllByRole('link', { name: 'View proposal' });
    for (const link of proposalLinks) {
      expect(link).toHaveAttribute('href', '/admin/proposals/proposal-99');
    }
  });
});
