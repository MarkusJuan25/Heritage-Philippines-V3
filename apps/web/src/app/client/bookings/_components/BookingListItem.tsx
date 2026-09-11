import Link from 'next/link';

import type { ClientBookingPreviewItem } from '@/features/bookings/service';

import styles from '../../client.module.css';

// D-049 §5 — one row of the D-040 §5 six-field client-visible allow-list
// (bookingReference, statusLabel, travelStartDate, travelEndDate,
// destination, tourPackageName). The date rendering is duplicated from
// `client/_components/BookingSummarySection.tsx` (which renders the same
// shape for the Home Overview preview) rather than imported, matching this
// codebase's established per-surface-copy convention for small renderers.
// The whole row is a real in-app link to the booking's detail view,
// addressed by its `bookingReference` — never an internal database id
// (D-049 §3).
function BookingDate({ date }: { date: Date }) {
  return <time dateTime={date.toISOString().slice(0, 10)}>{date.toLocaleDateString('en-PH')}</time>;
}

export function BookingListItem({ item }: { item: ClientBookingPreviewItem }) {
  const hasWindow = item.travelStartDate !== null || item.travelEndDate !== null;

  return (
    <li className={styles.bookingListItem}>
      <Link className={styles.bookingListLink} href={`/client/bookings/${item.bookingReference}`}>
        <span className={styles.bookingListPrimary}>{item.bookingReference}</span>
        <span className={styles.bookingListMeta}>{item.statusLabel}</span>
        {item.tourPackageName ? (
          <span className={styles.bookingListMeta}>{item.tourPackageName}</span>
        ) : null}
        {item.destination ? (
          <span className={styles.bookingListMeta}>{item.destination}</span>
        ) : null}
        {hasWindow ? (
          <span className={styles.bookingListDates}>
            {item.travelStartDate ? <BookingDate date={item.travelStartDate} /> : '—'}
            {' – '}
            {item.travelEndDate ? <BookingDate date={item.travelEndDate} /> : '—'}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
