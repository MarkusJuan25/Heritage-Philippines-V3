import Link from 'next/link';

import styles from '../../client.module.css';

// D-049 §4/§7 — ordinary accessible in-app pagination for the single
// paginated `/client/bookings` route, mirroring
// `client/my-journey/_components/ProposalReviewPagination.tsx`'s identical
// D-047 §5/§12 pattern. No database identifier ever appears in a link: the
// only query is `page=N`, and the page-1 link is the bare
// `/client/bookings`.
export function BookingPagination({
  page,
  hasPrevious,
  hasNext,
}: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
}) {
  if (!hasPrevious && !hasNext) {
    return null;
  }

  const previousPage = page - 1;
  const previousHref =
    previousPage <= 1 ? '/client/bookings' : `/client/bookings?page=${previousPage}`;
  const nextHref = `/client/bookings?page=${page + 1}`;

  return (
    <nav className={styles.bookingPagination} aria-label="Booking pages">
      {hasPrevious ? (
        <Link className={styles.navLink} href={previousHref} rel="prev">
          Previous
        </Link>
      ) : null}
      {hasNext ? (
        <Link className={styles.navLink} href={nextHref} rel="next">
          Next
        </Link>
      ) : null}
    </nav>
  );
}
