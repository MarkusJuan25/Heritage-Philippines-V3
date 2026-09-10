import Link from 'next/link';

import styles from '../../client.module.css';

// D-047 §5/§12 — ordinary accessible in-app pagination for the single
// paginated `/client/my-journey` route. No database identifier ever appears
// in a link: the only query is `page=N`, and the page-1 link is the bare
// `/client/my-journey`. "Previous" shows from page 2 onward; "Next" shows
// only when the service reported an eleventh fetched row (`hasNext`). When
// neither applies (a single page of results) this renders nothing.
export function ProposalReviewPagination({
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
    previousPage <= 1 ? '/client/my-journey' : `/client/my-journey?page=${previousPage}`;
  const nextHref = `/client/my-journey?page=${page + 1}`;

  return (
    <nav className={styles.reviewPagination} aria-label="Proposal review pages">
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
