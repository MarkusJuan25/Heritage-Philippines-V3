import Link from 'next/link';

import styles from './Pagination.module.css';

export type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  /** Builds the href for a given target page — the caller decides which
   * other query parameters (filters, etc.) to preserve, keeping this
   * component reusable across the Lead list, a Lead's status history, and
   * the Client list (D-023 §9: "List filters and pagination live in URL
   * search parameters"; D-025 §10: shared across Lead and Client list
   * pages). */
  buildHref: (page: number) => string;
};

/** Link-based pager — no client JS required, keyboard-operable via plain
 * anchors, and reusable wherever a paginated list needs page controls. */
export function Pagination({ page, pageSize, total, buildHref }: PaginationProps) {
  if (total === 0) {
    return null;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav className={styles.pagination} aria-label="Pagination">
      {hasPrevious ? (
        <Link href={buildHref(page - 1)}>Previous</Link>
      ) : (
        <span aria-disabled="true">Previous</span>
      )}
      <span className={styles.pageInfo}>
        Page {page} of {totalPages} ({total} total)
      </span>
      {hasNext ? (
        <Link href={buildHref(page + 1)}>Next</Link>
      ) : (
        <span aria-disabled="true">Next</span>
      )}
    </nav>
  );
}
