import type { ClientBookingPreviewItem } from '@/features/bookings/service';

import { BookingListItem } from './BookingListItem';
import { BookingPagination } from './BookingPagination';
import styles from '../../client.module.css';

// D-049 §4/§5/§7 — the body of `/client/bookings`. `items.length === 0` can
// only happen on page 1 (a confirmed page > 1 with no rows is redirected
// upstream before this ever renders — §4), so it maps 1:1 to the global
// empty state, whose copy matches the existing Home / Overview
// `BookingSummarySection` empty state exactly. `hasPrevious` is derived
// here from `page > 1` — a trivial UI-layer computation, not something the
// D-049 Stage 2 service result carries.
export function BookingList({
  items,
  page,
  hasNext,
}: {
  items: ClientBookingPreviewItem[];
  page: number;
  hasNext: boolean;
}) {
  if (items.length === 0) {
    return (
      <p className={styles.emptyState}>
        No bookings yet. A booking is created after you accept a proposal.
      </p>
    );
  }

  return (
    <div className={styles.bookingListWrapper}>
      <ul className={styles.bookingList}>
        {items.map((item) => (
          <BookingListItem key={item.bookingReference} item={item} />
        ))}
      </ul>
      <BookingPagination page={page} hasPrevious={page > 1} hasNext={hasNext} />
    </div>
  );
}
