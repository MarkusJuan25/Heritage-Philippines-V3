import type {
  ClientOverviewBookingPreviewItem,
  ClientOverviewBookings,
} from '@/features/client-portal/schemas';

import { OverviewSection } from './OverviewSection';
import styles from '../client.module.css';

// A `@db.Date` travel date rendered exactly as the existing admin bookings
// surfaces render one (`admin/bookings/[id]/page.tsx`'s `DateValue` /
// `admin/bookings/_components/BookingTable.tsx`'s `TravelDateValue`): the
// date-only ISO form (`YYYY-MM-DD`) in `dateTime` — never the spurious
// `T00:00:00.000Z` a full `toISOString()` would append to a date-only
// value — and a date-only `en-PH` string as the visible text.
function BookingDate({ date }: { date: Date }) {
  return <time dateTime={date.toISOString().slice(0, 10)}>{date.toLocaleDateString('en-PH')}</time>;
}

function BookingPreviewRow({ item }: { item: ClientOverviewBookingPreviewItem }) {
  const hasWindow = item.travelStartDate !== null || item.travelEndDate !== null;

  return (
    <li className={styles.previewItem}>
      <span className={styles.previewItemPrimary}>{item.bookingReference}</span>
      <span className={styles.previewItemMeta}>{item.statusLabel}</span>
      {item.tourPackageName ? (
        <span className={styles.previewItemMeta}>{item.tourPackageName}</span>
      ) : null}
      {item.destination ? <span className={styles.previewItemMeta}>{item.destination}</span> : null}
      {hasWindow ? (
        <span className={styles.previewItemDates}>
          {item.travelStartDate ? <BookingDate date={item.travelStartDate} /> : '—'}
          {' – '}
          {item.travelEndDate ? <BookingDate date={item.travelEndDate} /> : '—'}
        </span>
      ) : null}
    </li>
  );
}

// D-040 §5. The section header uses `sum(byStatus)` — carried on the DTO as
// `bookings.total`, already computed server-side; this component never
// re-sums or re-derives it. The empty state is keyed on `total === 0` and
// reads exactly:
//   "No bookings yet. A booking is created after you accept a proposal."
// The preview is rendered exactly as handed over — already bounded to at
// most 5 by Contract E, `DRAFT` bookings already excluded server-side, and
// carrying only the D-040 §5 allow-list (`bookingReference`, the mapped
// `statusLabel`, travel dates, `destination`, `tourPackageName`). No
// `internalNotes`, `clientVisibleNotes`, `totalAmount`, `currencyCode`,
// `travelerCount`, `Booking.id`, or status history exists on this DTO. The
// per-status `byStatus` breakdown is deliberately not rendered — D-040 §7's
// success layout does not include one.
export function BookingSummarySection({ bookings }: { bookings: ClientOverviewBookings }) {
  return (
    <OverviewSection title="Bookings" count={bookings.total}>
      {bookings.total === 0 ? (
        <p className={styles.emptyState}>
          No bookings yet. A booking is created after you accept a proposal.
        </p>
      ) : (
        <ul className={styles.previewList}>
          {bookings.preview.map((item) => (
            <BookingPreviewRow key={item.bookingReference} item={item} />
          ))}
        </ul>
      )}
    </OverviewSection>
  );
}
