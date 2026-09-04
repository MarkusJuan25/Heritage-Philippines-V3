// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ClientOverviewBookingPreviewItem } from '@/features/client-portal/schemas';

import { BookingSummarySection } from './BookingSummarySection';

// D-040 §5. Header uses `sum(byStatus)` (carried as `bookings.total`); the
// empty state is keyed on `total === 0` and reproduced verbatim; the
// preview is rendered exactly as handed over — DRAFT already excluded
// server-side, at most 5 items, and only the allow-listed fields
// (`bookingReference`, mapped `statusLabel`, travel dates, `destination`,
// `tourPackageName`). Never a link, never money / notes / traveler count /
// database id.
const EMPTY_BY_STATUS = {
  PENDING_CONFIRMATION: 0,
  CONFIRMED: 0,
  IN_PREPARATION: 0,
  DOCUMENTS_REQUIRED: 0,
  VISA_PROCESSING: 0,
  READY_FOR_TRAVEL: 0,
  IN_PROGRESS: 0,
  COMPLETED: 0,
  CANCELLED: 0,
} as const;

const EMPTY_COPY = 'No bookings yet. A booking is created after you accept a proposal.';

function previewItem(
  overrides: Partial<ClientOverviewBookingPreviewItem> = {},
): ClientOverviewBookingPreviewItem {
  return {
    bookingReference: 'HPB-ABCDEF0123456789ABCD',
    statusLabel: 'Confirmed',
    travelStartDate: null,
    travelEndDate: null,
    destination: null,
    tourPackageName: null,
    ...overrides,
  };
}

describe('BookingSummarySection', () => {
  it('renders the exact empty-state copy when total is 0', () => {
    const { container } = render(
      <BookingSummarySection
        bookings={{ total: 0, byStatus: { ...EMPTY_BY_STATUS }, preview: [] }}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Bookings (0)' })).toBeInTheDocument();
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(container.querySelector('ul')).toBeNull();
  });

  it('renders the header count from total and one row per preview item, with reference, status, dates, destination and package', () => {
    const start = new Date('2026-10-01T00:00:00.000Z');
    const end = new Date('2026-10-09T00:00:00.000Z');
    const { container } = render(
      <BookingSummarySection
        bookings={{
          total: 2,
          byStatus: { ...EMPTY_BY_STATUS, CONFIRMED: 1, COMPLETED: 1 },
          preview: [
            previewItem({
              bookingReference: 'HPB-1111111111111111AAAA',
              statusLabel: 'Confirmed',
              travelStartDate: start,
              travelEndDate: end,
              destination: 'Palawan',
              tourPackageName: 'Island Hopping',
            }),
            previewItem({ bookingReference: 'HPB-2222222222222222BBBB', statusLabel: 'Completed' }),
          ],
        }}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Bookings (2)' })).toBeInTheDocument();
    expect(container.querySelectorAll('li')).toHaveLength(2);

    expect(screen.getByText('HPB-1111111111111111AAAA')).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Palawan')).toBeInTheDocument();
    expect(screen.getByText('Island Hopping')).toBeInTheDocument();

    const times = container.querySelectorAll('time');
    expect(times).toHaveLength(2);
    // `@db.Date` values render a date-only `dateTime` (YYYY-MM-DD) — the
    // established admin bookings convention — never a full timestamp with
    // a spurious `T00:00:00.000Z`.
    expect(times[0]).toHaveAttribute('dateTime', '2026-10-01');
    expect(times[1]).toHaveAttribute('dateTime', '2026-10-09');

    // bookingReference is plain text — never a link (no booking detail
    // route in Stage 6).
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders at most the bounded 5 preview rows', () => {
    const preview = Array.from({ length: 5 }, (_unused, i) =>
      previewItem({ bookingReference: `HPB-000000000000000000${i}A` }),
    );
    const { container } = render(
      <BookingSummarySection
        bookings={{ total: 20, byStatus: { ...EMPTY_BY_STATUS, CONFIRMED: 20 }, preview }}
      />,
    );

    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(container.querySelectorAll('li').length).toBeLessThanOrEqual(5);
  });

  it('never renders a DRAFT label, money, currency, traveler count, internal notes, or a database id', () => {
    const { container } = render(
      <BookingSummarySection
        bookings={{
          total: 1,
          byStatus: { ...EMPTY_BY_STATUS, CONFIRMED: 1 },
          preview: [previewItem({ statusLabel: 'Confirmed', destination: 'Cebu' })],
        }}
      />,
    );

    const text = container.textContent ?? '';
    expect(text).not.toContain('Draft');
    expect(text).not.toContain('DRAFT');

    const html = container.innerHTML.toLowerCase();
    for (const forbidden of [
      'internalnotes',
      'clientvisiblenotes',
      'totalamount',
      'currencycode',
      'travelercount',
      'bookingid',
      'proposalversionid',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
