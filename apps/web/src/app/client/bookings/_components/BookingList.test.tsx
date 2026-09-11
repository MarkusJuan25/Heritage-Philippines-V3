// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import type { ClientBookingPreviewItem } from '@/features/bookings/service';

import { BookingList } from './BookingList';

function item(overrides: Partial<ClientBookingPreviewItem> = {}): ClientBookingPreviewItem {
  return {
    bookingReference: 'HPB-AAAA',
    statusLabel: 'Confirmed',
    travelStartDate: null,
    travelEndDate: null,
    destination: null,
    tourPackageName: null,
    ...overrides,
  };
}

describe('BookingList', () => {
  it('renders the global empty state (matching the Home / Overview copy) and nothing else when items is empty', () => {
    render(<BookingList items={[]} page={1} hasNext={false} />);

    expect(
      screen.getByText('No bookings yet. A booking is created after you accept a proposal.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Booking pages' })).not.toBeInTheDocument();
  });

  it('renders one list item per booking, in the order supplied', () => {
    render(
      <BookingList
        items={[item({ bookingReference: 'HPB-ONE' }), item({ bookingReference: 'HPB-TWO' })]}
        page={1}
        hasNext={false}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('link', { name: /HPB-ONE/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /HPB-TWO/ })).toBeInTheDocument();
    expect(
      screen.queryByText('No bookings yet. A booking is created after you accept a proposal.'),
    ).not.toBeInTheDocument();
  });

  it('derives hasPrevious from page > 1 and forwards it, along with hasNext, to pagination', () => {
    render(<BookingList items={[item()]} page={2} hasNext={true} />);

    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/client/bookings',
    );
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/client/bookings?page=3',
    );
  });

  it('omits pagination entirely on a single page of results', () => {
    render(<BookingList items={[item()]} page={1} hasNext={false} />);

    expect(screen.queryByRole('navigation', { name: 'Booking pages' })).not.toBeInTheDocument();
  });
});
