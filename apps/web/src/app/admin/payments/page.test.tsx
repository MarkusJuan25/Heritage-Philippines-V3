// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { listPaymentBookingsForActorMock } = vi.hoisted(() => ({
  listPaymentBookingsForActorMock: vi.fn(),
}));
vi.mock('@/features/payments/service', () => ({
  listPaymentBookingsForActor: listPaymentBookingsForActorMock,
}));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import AdminPaymentsPage from './page';

const FINANCE = {
  id: 'finance-1',
  email: 'finance@example.test',
  name: 'Finance',
  role: 'FINANCE_ACCOUNTING',
};

function header(index: number) {
  return {
    id: `00000000-0000-4000-8000-00000000000${index}`,
    bookingReference: `HPB-REF${index}`,
    status: 'CONFIRMED' as const,
    client: { fullName: `Client ${index}` },
  };
}

function searchParams(value: Record<string, string> = {}) {
  return Promise.resolve(value);
}

beforeEach(() => {
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  listPaymentBookingsForActorMock.mockResolvedValue({ items: [], total: 0 });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('AdminPaymentsPage', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    await expect(AdminPaymentsPage({ searchParams: searchParams() })).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(listPaymentBookingsForActorMock).not.toHaveBeenCalled();
  });

  it.each(['VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'renders access denied for %s without reading any Booking',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...FINANCE, role });
      render(await AdminPaymentsPage({ searchParams: searchParams() }));

      expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
      expect(listPaymentBookingsForActorMock).not.toHaveBeenCalled();
    },
  );

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT', 'FINANCE_ACCOUNTING'])(
    'lists through the actor-scoped service for %s with the default page',
    async (role) => {
      const actor = { ...FINANCE, role };
      getCurrentUserMock.mockResolvedValue(actor);
      listPaymentBookingsForActorMock.mockResolvedValue({ items: [header(1)], total: 1 });

      render(await AdminPaymentsPage({ searchParams: searchParams() }));

      expect(listPaymentBookingsForActorMock).toHaveBeenCalledWith(actor, {
        page: 1,
        pageSize: 20,
      });
      expect(screen.getByRole('link', { name: 'HPB-REF1' })).toHaveAttribute(
        'href',
        `/admin/payments/${header(1).id}`,
      );
      expect(screen.getByText('Client 1')).toBeInTheDocument();
    },
  );

  it('shows the empty state when nothing is visible and no filter is applied', async () => {
    getCurrentUserMock.mockResolvedValue(FINANCE);
    render(await AdminPaymentsPage({ searchParams: searchParams() }));

    expect(
      screen.getByText(/No bookings are available to you in payments yet/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('shows a distinct empty state for filters that match nothing, with a way to clear them', async () => {
    getCurrentUserMock.mockResolvedValue(FINANCE);
    render(
      await AdminPaymentsPage({
        searchParams: searchParams({ search: 'HPB-X', planState: 'approved' }),
      }),
    );

    expect(listPaymentBookingsForActorMock).toHaveBeenCalledWith(FINANCE, {
      search: 'HPB-X',
      planState: 'approved',
      page: 1,
      pageSize: 20,
    });
    expect(screen.getByText('No bookings match these filters.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear' })).toHaveAttribute('href', '/admin/payments');
  });

  it('ignores blank filter fields submitted by the form', async () => {
    getCurrentUserMock.mockResolvedValue(FINANCE);
    render(await AdminPaymentsPage({ searchParams: searchParams({ search: '', planState: '' }) }));

    expect(listPaymentBookingsForActorMock).toHaveBeenCalledWith(FINANCE, {
      page: 1,
      pageSize: 20,
    });
  });

  it.each<Record<string, string>>([
    { planState: 'deleted' },
    { page: '0' },
    { status: 'CONFIRMED' },
  ])('renders the error state for invalid URL parameters %o without reading', async (params) => {
    getCurrentUserMock.mockResolvedValue(FINANCE);
    render(await AdminPaymentsPage({ searchParams: searchParams(params) }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The page parameters in the URL are invalid.',
    );
    expect(listPaymentBookingsForActorMock).not.toHaveBeenCalled();
  });

  it('keeps the filters in the pagination links', async () => {
    getCurrentUserMock.mockResolvedValue(FINANCE);
    listPaymentBookingsForActorMock.mockResolvedValue({ items: [header(1)], total: 3 });

    render(
      await AdminPaymentsPage({
        searchParams: searchParams({
          search: 'HPB',
          planState: 'proposed',
          pageSize: '1',
          page: '2',
        }),
      }),
    );

    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/admin/payments?search=HPB&planState=proposed&page=3&pageSize=1',
    );
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/admin/payments?search=HPB&planState=proposed&page=1&pageSize=1',
    );
  });

  it('redirects a page beyond the last one to the last page', async () => {
    getCurrentUserMock.mockResolvedValue(FINANCE);
    listPaymentBookingsForActorMock.mockResolvedValue({ items: [], total: 2 });

    await expect(
      AdminPaymentsPage({ searchParams: searchParams({ page: '9', pageSize: '1' }) }),
    ).rejects.toThrow('REDIRECT:/admin/payments?page=2&pageSize=1');
  });
});
