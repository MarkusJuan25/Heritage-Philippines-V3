// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getOwnClientForUserMock } = vi.hoisted(() => ({ getOwnClientForUserMock: vi.fn() }));
vi.mock('@/features/clients/service', () => ({ getOwnClientForUser: getOwnClientForUserMock }));

const { getClientBookingListPageMock } = vi.hoisted(() => ({
  getClientBookingListPageMock: vi.fn(),
}));
vi.mock('@/features/bookings/service', () => ({
  getClientBookingListPage: getClientBookingListPageMock,
}));

const { bookingListPropsSpy } = vi.hoisted(() => ({ bookingListPropsSpy: vi.fn() }));
vi.mock('./_components/BookingList', () => ({
  BookingList: (props: unknown) => {
    bookingListPropsSpy(props);
    return null;
  },
}));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import { ClientError } from '@/features/clients/errors';
import { BookingError } from '@/features/bookings/errors';

import ClientBookingsPage from './page';

const CLIENT_USER = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client One',
  role: 'CLIENT' as const,
};

const OWNED = {
  clientId: 'client-1',
  fullName: 'Client One',
  email: 'client@example.test',
  phone: null,
};

function searchParams(query: Record<string, string> = {}) {
  return Promise.resolve(query);
}

describe('ClientBookingsPage', () => {
  it('redirects to /login when there is no session', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(ClientBookingsPage({ searchParams: searchParams() })).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(getOwnClientForUserMock).not.toHaveBeenCalled();
  });

  it('renders nothing (the layout owns the panel) when Contract A resolves null', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(null);

    const jsx = await ClientBookingsPage({ searchParams: searchParams() });

    expect(jsx).toBeNull();
    expect(getClientBookingListPageMock).not.toHaveBeenCalled();
  });

  it('renders nothing for a ROLE_NOT_PERMITTED ClientError from Contract A', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockRejectedValue(new ClientError('ROLE_NOT_PERMITTED', 'no'));

    const jsx = await ClientBookingsPage({ searchParams: searchParams() });

    expect(jsx).toBeNull();
  });

  it('renders nothing for a ROLE_NOT_PERMITTED BookingError from the read service', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingListPageMock.mockRejectedValue(new BookingError('ROLE_NOT_PERMITTED', 'no'));

    const jsx = await ClientBookingsPage({ searchParams: searchParams() });

    expect(jsx).toBeNull();
  });

  it('rethrows any other error to the segment error boundary', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingListPageMock.mockRejectedValue(new Error('boom'));

    await expect(ClientBookingsPage({ searchParams: searchParams() })).rejects.toThrow('boom');
  });

  it('redirects to /client/bookings (no query) when the service reports a redirect', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingListPageMock.mockResolvedValue({ kind: 'redirect' });

    await expect(
      ClientBookingsPage({ searchParams: searchParams({ page: '99' }) }),
    ).rejects.toThrow('REDIRECT:/client/bookings');
  });

  it('parses the page query and passes the resolved page to the service', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingListPageMock.mockResolvedValue({
      kind: 'page',
      items: [],
      page: 2,
      hasNext: false,
    });

    await ClientBookingsPage({ searchParams: searchParams({ page: '2' }) });

    expect(getClientBookingListPageMock).toHaveBeenCalledWith(CLIENT_USER, 'client-1', 2);
  });

  it('normalizes an invalid page query to 1 before calling the service, without echoing the rejected value', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingListPageMock.mockResolvedValue({
      kind: 'page',
      items: [],
      page: 1,
      hasNext: false,
    });

    await ClientBookingsPage({ searchParams: searchParams({ page: 'not-a-number' }) });

    expect(getClientBookingListPageMock).toHaveBeenCalledWith(CLIENT_USER, 'client-1', 1);
  });

  it('renders the "Bookings" heading and forwards items/page/hasNext to BookingList', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    const items = [
      {
        bookingReference: 'HPB-AAAA',
        statusLabel: 'Confirmed',
        travelStartDate: null,
        travelEndDate: null,
        destination: null,
        tourPackageName: null,
      },
    ];
    getClientBookingListPageMock.mockResolvedValue({ kind: 'page', items, page: 1, hasNext: true });

    const jsx = await ClientBookingsPage({ searchParams: searchParams() });
    const { getByRole } = render(jsx!);

    expect(getByRole('heading', { level: 1, name: 'Bookings' })).toBeInTheDocument();
    expect(bookingListPropsSpy).toHaveBeenCalledWith({ items, page: 1, hasNext: true });
  });
});
