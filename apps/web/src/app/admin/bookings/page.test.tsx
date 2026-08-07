// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { listBookingsMock } = vi.hoisted(() => ({ listBookingsMock: vi.fn() }));
vi.mock('@/features/bookings/service', () => ({ listBookings: listBookingsMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import type { BookingRecord } from '@/features/bookings/repository';

import AdminBookingsPage from './page';

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

function booking(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'booking-1',
    bookingReference: 'HPB-AAAAAAAAAAAAAAAAAAAA',
    clientId: 'client-1',
    proposalVersionId: 'version-1',
    status: 'DRAFT',
    tourPackageName: null,
    destination: null,
    travelStartDate: null,
    travelEndDate: null,
    travelerCount: null,
    includedServices: null,
    excludedServices: null,
    specialRequests: null,
    internalNotes: null,
    clientVisibleNotes: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
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
  // (mirrors admin/proposals/page.test.tsx's identical discipline).
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('AdminBookingsPage', () => {
  it('redirects to /login when there is no session', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminBookingsPage({ searchParams: searchParams() })).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(listBookingsMock).not.toHaveBeenCalled();
  });

  it('renders the paginated list for an authorized ADMIN_MANAGER', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockResolvedValue({
      items: [booking({ bookingReference: 'HPB-ADMIN0000000000AA' })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminBookingsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.getAllByText('HPB-ADMIN0000000000AA').length).toBeGreaterThan(0);
  });

  it('renders the list for an authorized TRAVEL_CONSULTANT through the same scoped service call', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    listBookingsMock.mockResolvedValue({
      items: [booking({ bookingReference: 'HPB-TC00000000000000AA' })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminBookingsPage({ searchParams: searchParams() });
    render(jsx);

    expect(listBookingsMock).toHaveBeenCalledWith(TRAVEL_CONSULTANT, { page: 1, pageSize: 20 });
    expect(screen.getAllByText('HPB-TC00000000000000AA').length).toBeGreaterThan(0);
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders an in-place permission-denied state for role %s, never calling listBookings',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminBookingsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(listBookingsMock).not.toHaveBeenCalled();
    },
  );

  it('applies default pagination values when no query params are supplied', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    await AdminBookingsPage({ searchParams: searchParams() });

    expect(listBookingsMock).toHaveBeenCalledWith(ADMIN_MANAGER, { page: 1, pageSize: 20 });
  });

  it('parses and forwards the exact actor and coerced pagination query to listBookings', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockResolvedValue({ items: [], page: 2, pageSize: 10, total: 0 });

    await AdminBookingsPage({ searchParams: searchParams({ page: '2', pageSize: '10' }) });

    expect(listBookingsMock).toHaveBeenCalledWith(ADMIN_MANAGER, { page: 2, pageSize: 10 });
  });

  it('renders a validation-error state for an invalid page, with role="alert" and a corrective link, without calling listBookings', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminBookingsPage({ searchParams: searchParams({ page: '0' }) });
    render(jsx);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The page parameters in the URL are invalid.');
    expect(screen.getByRole('link', { name: 'Clear and start over' })).toHaveAttribute(
      'href',
      '/admin/bookings',
    );
    expect(listBookingsMock).not.toHaveBeenCalled();
  });

  it('renders a validation-error state for an invalid pageSize, without calling listBookings', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminBookingsPage({ searchParams: searchParams({ pageSize: '999' }) });
    render(jsx);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The page parameters in the URL are invalid.',
    );
    expect(listBookingsMock).not.toHaveBeenCalled();
  });

  it('renders the empty state when total === 0', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

    const jsx = await AdminBookingsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.getByText('No bookings yet.')).toBeInTheDocument();
  });

  it('does not render the empty state for total > 0 with an unexpectedly empty items array on an otherwise-valid page, and still renders the Booking table and pagination', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 5 });

    const jsx = await AdminBookingsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.queryByText('No bookings yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
  });

  it('renders BookingTable for a non-empty result', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockResolvedValue({
      items: [booking({ id: 'booking-42', bookingReference: 'HPB-TABLE000000000042' })],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    const jsx = await AdminBookingsPage({ searchParams: searchParams() });
    render(jsx);

    expect(screen.getAllByRole('link', { name: 'HPB-TABLE000000000042' })[0]).toHaveAttribute(
      'href',
      '/admin/bookings/booking-42',
    );
  });

  it('does not redirect when total is 0, even for a requested page other than 1', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockResolvedValue({ items: [], page: 5, pageSize: 20, total: 0 });

    const jsx = await AdminBookingsPage({ searchParams: searchParams({ page: '5' }) });
    render(jsx);

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByText('No bookings yet.')).toBeInTheDocument();
  });

  it('redirects to the last valid page when the requested page exceeds it, preserving pageSize', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    // ceil(42 / 20) = 3 — page 5 was requested but does not exist.
    listBookingsMock.mockResolvedValue({ items: [], page: 5, pageSize: 20, total: 42 });

    await expect(AdminBookingsPage({ searchParams: searchParams({ page: '5' }) })).rejects.toThrow(
      /^REDIRECT:/,
    );

    expect(redirectMock).toHaveBeenCalledWith('/admin/bookings?page=3&pageSize=20');
  });

  it('does not redirect when the requested page is already within range', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockResolvedValue({
      items: [booking()],
      page: 2,
      pageSize: 20,
      total: 21,
    });

    const jsx = await AdminBookingsPage({ searchParams: searchParams({ page: '2' }) });
    render(jsx);

    expect(redirectMock).not.toHaveBeenCalled();
  });

  describe('Previous/Next pagination links (shared Pagination component)', () => {
    it('renders pagination from the returned page/pageSize/total values, and preserves pageSize on the Next link', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listBookingsMock.mockResolvedValue({
        items: [booking()],
        page: 1,
        pageSize: 20,
        total: 45,
      });

      const jsx = await AdminBookingsPage({ searchParams: searchParams() });
      render(jsx);

      expect(screen.getByText('Previous')).not.toHaveAttribute('href');
      const next = screen.getByRole('link', { name: 'Next' });
      expect(next).toHaveAttribute('href', '/admin/bookings?page=2&pageSize=20');
      expect(screen.getByText('Page 1 of 3 (45 total)')).toBeInTheDocument();
    });

    it('preserves a non-default pageSize on both Previous and Next links', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      listBookingsMock.mockResolvedValue({
        items: [booking()],
        page: 2,
        pageSize: 10,
        total: 45,
      });

      const jsx = await AdminBookingsPage({
        searchParams: searchParams({ page: '2', pageSize: '10' }),
      });
      render(jsx);

      expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
        'href',
        '/admin/bookings?page=1&pageSize=10',
      );
      expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
        'href',
        '/admin/bookings?page=3&pageSize=10',
      );
    });
  });

  it('propagates an unexpected error from listBookings rather than rendering a false state', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    listBookingsMock.mockRejectedValue(new Error('unexpected failure'));

    await expect(AdminBookingsPage({ searchParams: searchParams() })).rejects.toThrow(
      'unexpected failure',
    );
  });
});
