// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { BookingRecord } from '@/features/bookings/repository';

import { BookingTable } from './BookingTable';

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

describe('BookingTable', () => {
  it('renders both a mobile-card list and a desktop table structure', () => {
    const { container } = render(<BookingTable items={[booking()]} />);

    expect(container.querySelector('ul')).not.toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
  });

  // Both responsive layouts (the mobile card list and the desktop table)
  // render simultaneously in jsdom, since CSS media queries never apply
  // there — CSS alone toggles which one is actually visible in a browser.
  // Every assertion below that counts occurrences therefore expects exactly
  // two (one per layout), which is how these tests prove *both* layouts
  // carry the required information, not merely one of them.
  it('represents every supplied Booking in both layouts', () => {
    render(
      <BookingTable
        items={[
          booking({ id: 'booking-1', bookingReference: 'HPB-ONE0000000000000A' }),
          booking({ id: 'booking-2', bookingReference: 'HPB-TWO0000000000000B' }),
        ]}
      />,
    );

    expect(screen.getAllByRole('link', { name: 'HPB-ONE0000000000000A' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'HPB-TWO0000000000000B' })).toHaveLength(2);
  });

  it('links the booking reference to /admin/bookings/{booking.id} in both layouts', () => {
    render(
      <BookingTable
        items={[booking({ id: 'booking-99', bookingReference: 'HPB-DETAIL0000000099' })]}
      />,
    );

    const links = screen.getAllByRole('link', { name: 'HPB-DETAIL0000000099' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/admin/bookings/booking-99');
    }
  });

  it('renders items in exactly the order supplied, without reordering or filtering', () => {
    const items = [
      booking({ id: 'b1', bookingReference: 'HPB-ZETA00000000000001' }),
      booking({ id: 'b2', bookingReference: 'HPB-ALPHA0000000000002' }),
    ];
    const { container } = render(<BookingTable items={items} />);

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('HPB-ZETA00000000000001');
    expect(rows[1]?.textContent).toContain('HPB-ALPHA0000000000002');

    const cards = Array.from(container.querySelectorAll('ul li'));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('HPB-ZETA00000000000001');
    expect(cards[1]?.textContent).toContain('HPB-ALPHA0000000000002');
  });

  it('renders a human-readable status label derived from the supplied enum value, in both layouts', () => {
    render(<BookingTable items={[booking({ status: 'IN_PREPARATION' })]} />);

    expect(screen.getAllByText('In Preparation')).toHaveLength(2);
    expect(screen.queryByText('IN_PREPARATION')).not.toBeInTheDocument();
  });

  it('renders every BookingStatus value as its own distinct human-readable label', () => {
    const statuses: BookingRecord['status'][] = [
      'DRAFT',
      'PENDING_CONFIRMATION',
      'CONFIRMED',
      'IN_PREPARATION',
      'DOCUMENTS_REQUIRED',
      'VISA_PROCESSING',
      'READY_FOR_TRAVEL',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ];
    const expectedLabels = [
      'Draft',
      'Pending Confirmation',
      'Confirmed',
      'In Preparation',
      'Documents Required',
      'Visa Processing',
      'Ready for Travel',
      'In Progress',
      'Completed',
      'Cancelled',
    ];

    statuses.forEach((status, index) => {
      const { unmount } = render(<BookingTable items={[booking({ id: `s-${status}`, status })]} />);
      expect(screen.getAllByText(expectedLabels[index] as string).length).toBeGreaterThan(0);
      unmount();
    });
  });

  it('gives a real travelStartDate a correct <time dateTime> value, consistent en-PH formatting in both layouts', () => {
    const travelStartDate = new Date('2026-09-15T00:00:00Z');
    render(<BookingTable items={[booking({ travelStartDate })]} />);

    const expectedLabel = travelStartDate.toLocaleDateString('en-PH');
    const timeElements = screen.getAllByText(expectedLabel);
    expect(timeElements).toHaveLength(2);
    for (const el of timeElements) {
      expect(el.tagName).toBe('TIME');
      expect(el).toHaveAttribute('dateTime', '2026-09-15');
    }
  });

  it('gives a real travelEndDate a correct <time dateTime> value, consistent en-PH formatting in both layouts', () => {
    const travelEndDate = new Date('2026-09-22T00:00:00Z');
    render(<BookingTable items={[booking({ travelEndDate })]} />);

    const expectedLabel = travelEndDate.toLocaleDateString('en-PH');
    const timeElements = screen.getAllByText(expectedLabel);
    expect(timeElements).toHaveLength(2);
    for (const el of timeElements) {
      expect(el.tagName).toBe('TIME');
      expect(el).toHaveAttribute('dateTime', '2026-09-22');
    }
  });

  it('gives the createdAt metadata a correct <time dateTime> value, consistent en-PH formatting in both layouts', () => {
    const createdAt = new Date('2026-08-01T00:00:00Z');
    render(<BookingTable items={[booking({ createdAt })]} />);

    const expectedLabel = createdAt.toLocaleDateString('en-PH');
    const timeElements = screen.getAllByText(expectedLabel);
    // createdAt shares its formatted label with the (placeholder-only)
    // travel dates only when they differ in text, so this counts createdAt's
    // own two <time> renders (one per layout) specifically via dateTime.
    const createdAtTimes = timeElements.filter(
      (el) => el.getAttribute('dateTime') === createdAt.toISOString(),
    );
    expect(createdAtTimes).toHaveLength(2);
  });

  it('shows the explicit "Not set" placeholder for null destination, travelStartDate, and travelEndDate in both layouts, never a fabricated value', () => {
    render(
      <BookingTable
        items={[booking({ destination: null, travelStartDate: null, travelEndDate: null })]}
      />,
    );

    // Destination, travel start, and travel end are each null -> three
    // placeholder occurrences per layout, six total.
    expect(screen.getAllByText('Not set')).toHaveLength(6);
  });

  it('exposes visible mobile-card labels for every value via a dl/dt/dd structure', () => {
    const { container } = render(<BookingTable items={[booking()]} />);

    const cardDl = container.querySelector('ul dl');
    expect(cardDl).not.toBeNull();
    const dtTexts = Array.from(cardDl?.querySelectorAll('dt') ?? []).map((el) => el.textContent);
    expect(dtTexts).toEqual([
      'Booking reference',
      'Status',
      'Destination',
      'Travel start',
      'Travel end',
      'Created',
    ]);
  });

  it('exposes an accessible desktop table caption and column headers', () => {
    render(<BookingTable items={[booking()]} />);

    expect(screen.getByRole('columnheader', { name: 'Booking reference' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Destination' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Travel start' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Travel end' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument();
    expect(screen.getByText('Bookings').tagName).toBe('CAPTION');
  });

  it('never renders deferred or sensitive fields', () => {
    render(
      <BookingTable
        items={[
          booking({
            internalNotes: 'INTERNAL_NOTE_MARKER',
            clientVisibleNotes: 'CLIENT_VISIBLE_NOTE_MARKER',
            specialRequests: 'SPECIAL_REQUEST_MARKER',
            includedServices: 'INCLUDED_SERVICES_MARKER',
            excludedServices: 'EXCLUDED_SERVICES_MARKER',
            travelerCount: 4,
            proposalVersionId: 'PROPOSAL_VERSION_ID_MARKER',
            tourPackageName: 'TOUR_PACKAGE_MARKER',
          }),
        ]}
      />,
    );

    expect(screen.queryByText('INTERNAL_NOTE_MARKER')).not.toBeInTheDocument();
    expect(screen.queryByText('CLIENT_VISIBLE_NOTE_MARKER')).not.toBeInTheDocument();
    expect(screen.queryByText('SPECIAL_REQUEST_MARKER')).not.toBeInTheDocument();
    expect(screen.queryByText('INCLUDED_SERVICES_MARKER')).not.toBeInTheDocument();
    expect(screen.queryByText('EXCLUDED_SERVICES_MARKER')).not.toBeInTheDocument();
    expect(screen.queryByText('4')).not.toBeInTheDocument();
    expect(screen.queryByText('PROPOSAL_VERSION_ID_MARKER')).not.toBeInTheDocument();
    expect(screen.queryByText('TOUR_PACKAGE_MARKER')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /total ?amount/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /currency/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /assign/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /history/i })).not.toBeInTheDocument();
  });
});
