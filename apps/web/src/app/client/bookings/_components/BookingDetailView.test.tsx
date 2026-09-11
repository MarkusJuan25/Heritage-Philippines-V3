// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import type { ClientBookingDetail } from '@/features/bookings/service';

import { BookingDetailView } from './BookingDetailView';

function detail(overrides: Partial<ClientBookingDetail> = {}): ClientBookingDetail {
  return {
    bookingReference: 'HPB-0123456789ABCDEF0123',
    statusLabel: 'Confirmed',
    tourPackageName: 'Island Hopping',
    destination: 'Cebu',
    travelStartDate: new Date('2026-10-01T00:00:00.000Z'),
    travelEndDate: new Date('2026-10-05T00:00:00.000Z'),
    travelerCount: 2,
    includedServices: 'Hotel, breakfast',
    excludedServices: 'Airfare',
    specialRequests: 'Ground floor room',
    clientVisibleNotes: 'Welcome pack included',
    ...overrides,
  };
}

describe('BookingDetailView', () => {
  it('renders the booking reference heading and status label', () => {
    render(<BookingDetailView detail={detail()} />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Booking HPB-0123456789ABCDEF0123' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
  });

  it('renders destination, tour/package, travel dates, and traveler count', () => {
    render(<BookingDetailView detail={detail()} />);

    expect(screen.getByText('Cebu')).toBeInTheDocument();
    expect(screen.getByText('Island Hopping')).toBeInTheDocument();
    expect(screen.getByText('10/1/2026')).toBeInTheDocument();
    expect(screen.getByText('10/5/2026')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows an em dash for every null structural field', () => {
    render(
      <BookingDetailView
        detail={detail({
          destination: null,
          tourPackageName: null,
          travelStartDate: null,
          travelEndDate: null,
          travelerCount: null,
        })}
      />,
    );

    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('renders each free-text section only when present, as plain text', () => {
    render(<BookingDetailView detail={detail()} />);

    expect(screen.getByRole('heading', { name: 'Included services' })).toBeInTheDocument();
    expect(screen.getByText('Hotel, breakfast')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Excluded services' })).toBeInTheDocument();
    expect(screen.getByText('Airfare')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Special requests' })).toBeInTheDocument();
    expect(screen.getByText('Ground floor room')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Notes from your travel consultant' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Welcome pack included')).toBeInTheDocument();
  });

  it('omits a free-text section entirely when its field is null', () => {
    render(
      <BookingDetailView
        detail={detail({
          includedServices: null,
          excludedServices: null,
          specialRequests: null,
          clientVisibleNotes: null,
        })}
      />,
    );

    expect(screen.queryByRole('heading', { name: 'Included services' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Excluded services' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Special requests' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Notes from your travel consultant' }),
    ).not.toBeInTheDocument();
  });

  it('renders a markup-looking free-text value as literal text, never interpreted', () => {
    render(<BookingDetailView detail={detail({ specialRequests: '<script>alert(1)</script>' })} />);

    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script[src], script:not([type])')).toBeNull();
  });

  it('provides an accessible link back to /client/bookings', () => {
    render(<BookingDetailView detail={detail()} />);

    expect(screen.getByRole('link', { name: 'Back to Bookings' })).toHaveAttribute(
      'href',
      '/client/bookings',
    );
  });

  it('never renders a database identifier, clientId, proposalVersionId, or internalNotes text', () => {
    const { container } = render(<BookingDetailView detail={detail()} />);

    for (const forbidden of ['internalNotes', 'proposalVersionId', 'clientId']) {
      expect(container.textContent).not.toContain(forbidden);
    }
  });
});
