// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getOwnClientForUserMock } = vi.hoisted(() => ({ getOwnClientForUserMock: vi.fn() }));
vi.mock('@/features/clients/service', () => ({ getOwnClientForUser: getOwnClientForUserMock }));

const { getClientBookingDetailMock } = vi.hoisted(() => ({
  getClientBookingDetailMock: vi.fn(),
}));
vi.mock('@/features/bookings/service', () => ({
  getClientBookingDetail: getClientBookingDetailMock,
}));

const { bookingDetailViewPropsSpy } = vi.hoisted(() => ({ bookingDetailViewPropsSpy: vi.fn() }));
vi.mock('../_components/BookingDetailView', () => ({
  BookingDetailView: (props: unknown) => {
    bookingDetailViewPropsSpy(props);
    return null;
  },
}));

const { redirectMock, notFoundMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  notFound: notFoundMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import { ClientError } from '@/features/clients/errors';
import { BookingError } from '@/features/bookings/errors';

import ClientBookingDetailPage from './page';

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

const REFERENCE = `HPB-${'A'.repeat(20)}`;

function params(bookingReference: string) {
  return Promise.resolve({ bookingReference });
}

describe('ClientBookingDetailPage', () => {
  beforeEach(() => {
    getCurrentUserMock.mockClear();
    getOwnClientForUserMock.mockClear();
    getClientBookingDetailMock.mockClear();
    bookingDetailViewPropsSpy.mockClear();
    redirectMock.mockClear();
    notFoundMock.mockClear();
  });

  it('redirects to /login when there is no session', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(ClientBookingDetailPage({ params: params(REFERENCE) })).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(getOwnClientForUserMock).not.toHaveBeenCalled();
  });

  it('renders nothing (the layout owns the panel) when Contract A resolves null', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(null);

    const jsx = await ClientBookingDetailPage({ params: params(REFERENCE) });

    expect(jsx).toBeNull();
    expect(getClientBookingDetailMock).not.toHaveBeenCalled();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('renders nothing for a ROLE_NOT_PERMITTED ClientError from Contract A, never calling notFound()', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockRejectedValue(new ClientError('ROLE_NOT_PERMITTED', 'no'));

    const jsx = await ClientBookingDetailPage({ params: params(REFERENCE) });

    expect(jsx).toBeNull();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('renders nothing for a ROLE_NOT_PERMITTED BookingError from the read service, never calling notFound()', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingDetailMock.mockRejectedValue(new BookingError('ROLE_NOT_PERMITTED', 'no'));

    const jsx = await ClientBookingDetailPage({ params: params(REFERENCE) });

    expect(jsx).toBeNull();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('rethrows any other error to the segment error boundary, never calling notFound()', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingDetailMock.mockRejectedValue(new Error('boom'));

    await expect(ClientBookingDetailPage({ params: params(REFERENCE) })).rejects.toThrow('boom');
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("calls the service with the route segment's bookingReference and the owned clientId", async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingDetailMock.mockResolvedValue(null);

    await expect(ClientBookingDetailPage({ params: params(REFERENCE) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );

    expect(getClientBookingDetailMock).toHaveBeenCalledWith(CLIENT_USER, 'client-1', REFERENCE);
  });

  it('calls notFound() — outside the try/catch — for every controlled null result, and renders no panel', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    getClientBookingDetailMock.mockResolvedValue(null);

    await expect(ClientBookingDetailPage({ params: params(REFERENCE) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(bookingDetailViewPropsSpy).not.toHaveBeenCalled();
  });

  it('renders BookingDetailView with the exact detail DTO when the booking is found', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);
    const detail = {
      bookingReference: REFERENCE,
      statusLabel: 'Confirmed',
      tourPackageName: 'Island Hopping',
      destination: 'Cebu',
      travelStartDate: null,
      travelEndDate: null,
      travelerCount: 2,
      includedServices: null,
      excludedServices: null,
      specialRequests: null,
      clientVisibleNotes: null,
    };
    getClientBookingDetailMock.mockResolvedValue(detail);

    const jsx = await ClientBookingDetailPage({ params: params(REFERENCE) });
    render(jsx!);

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(bookingDetailViewPropsSpy).toHaveBeenCalledWith({ detail });
  });
});
