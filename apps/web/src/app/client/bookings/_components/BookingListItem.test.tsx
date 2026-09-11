// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import type { ClientBookingPreviewItem } from '@/features/bookings/service';

import { BookingListItem } from './BookingListItem';

const ITEM: ClientBookingPreviewItem = {
  bookingReference: 'HPB-0123456789ABCDEF0123',
  statusLabel: 'Confirmed',
  travelStartDate: new Date('2026-10-01T00:00:00.000Z'),
  travelEndDate: new Date('2026-10-05T00:00:00.000Z'),
  destination: 'Cebu',
  tourPackageName: 'Island Hopping',
};

describe('BookingListItem', () => {
  it('links to the detail route addressed by bookingReference — never a database id', () => {
    render(<BookingListItem item={ITEM} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/client/bookings/HPB-0123456789ABCDEF0123');
  });

  it('renders bookingReference, statusLabel, tourPackageName, destination, and both dates', () => {
    render(<BookingListItem item={ITEM} />);

    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('HPB-0123456789ABCDEF0123');
    expect(link).toHaveTextContent('Confirmed');
    expect(link).toHaveTextContent('Island Hopping');
    expect(link).toHaveTextContent('Cebu');
    expect(screen.getByText('10/1/2026')).toBeInTheDocument();
    expect(screen.getByText('10/5/2026')).toBeInTheDocument();
  });

  it('omits tourPackageName, destination, and the date range entirely when null', () => {
    render(
      <BookingListItem
        item={{
          ...ITEM,
          tourPackageName: null,
          destination: null,
          travelStartDate: null,
          travelEndDate: null,
        }}
      />,
    );

    const link = screen.getByRole('link');
    expect(link).not.toHaveTextContent('Island Hopping');
    expect(link).not.toHaveTextContent('Cebu');
  });

  it('renders no internal identifier — only the allow-listed fields ever reach the DOM', () => {
    const { container } = render(<BookingListItem item={ITEM} />);

    // The DTO carries no id/clientId/proposalVersionId/internalNotes field
    // at all (D-040 §5 / D-049 §5); this asserts the rendered output
    // contains nothing beyond the six allow-listed values.
    expect(container.textContent).not.toContain('internalNotes');
    expect(container.textContent).not.toContain('proposalVersionId');
  });
});
