import Link from 'next/link';

import styles from '../clients.module.css';

export type ClientFiltersValues = {
  search?: string;
};

/**
 * Plain server-rendered `GET` form (mirrors
 * admin/leads/_components/LeadFilters.tsx's established pattern for D-025
 * §3's single authorized filter): submitting navigates to
 * `/admin/clients?search=...`, which the list page re-renders from scratch.
 * No client JS is required for filtering to work, and the control is a
 * native, keyboard-operable element. Omitting `page` here is deliberate: a
 * fresh filter submission has no `page` field, so the resulting query
 * naturally lands back on page 1 (`listClientsQuerySchema`'s own default).
 * Exposes only `search` — D-025 §1/§3 authorizes no Client status, source,
 * or assignment filter.
 */
export function ClientFilters({ search }: ClientFiltersValues) {
  return (
    <form
      // `key` forces a full remount when the URL-derived filter value
      // changes: the control below is uncontrolled (`defaultValue` only),
      // and React applies `defaultValue` at mount only — it never re-syncs
      // it on a prop change. Without this, a Next.js client-side navigation
      // (e.g. the Clear link) that reconciles this same form in place would
      // leave the control showing a stale prior value.
      key={JSON.stringify({ search: search ?? '' })}
      method="GET"
      action="/admin/clients"
      className={styles.filterForm}
      aria-label="Filter clients"
    >
      <div className={styles.filterField}>
        <label htmlFor="client-search">Search</label>
        <input
          id="client-search"
          name="search"
          type="search"
          defaultValue={search ?? ''}
          placeholder="Name, email, or phone"
        />
      </div>
      <div className={styles.filterActions}>
        <button type="submit">Apply filters</button>
        <Link href="/admin/clients">Clear</Link>
      </div>
    </form>
  );
}
