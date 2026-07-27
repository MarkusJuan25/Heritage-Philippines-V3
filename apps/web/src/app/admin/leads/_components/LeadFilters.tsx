import Link from 'next/link';

import { LEAD_STATUS_LABELS, LEAD_STATUS_VALUES } from './leadStatusLabels';
import styles from '../leads.module.css';

export type LeadFiltersValues = {
  status?: string;
  source?: string;
  search?: string;
};

/**
 * Plain server-rendered `GET` form (D-023 §9/§10: no runtime UI/form
 * library, plain HTML) — submitting navigates to
 * `/admin/leads?search=...&status=...&source=...`, which the list page
 * re-renders from scratch. No client JS is required for filtering to
 * work, and every control is a native, keyboard-operable element.
 * Omitting `page` here is deliberate: a fresh filter submission has no
 * `page` field, so the resulting query naturally lands back on page 1
 * (`listLeadsQuerySchema`'s own default).
 */
export function LeadFilters({ status, source, search }: LeadFiltersValues) {
  return (
    <form
      // `key` forces a full remount when any URL-derived filter value
      // changes: every control below is uncontrolled (`defaultValue`
      // only), and React applies `defaultValue` at mount only — it never
      // re-syncs it on a prop change. Without this, a Next.js
      // client-side navigation (e.g. the Clear link) that reconciles
      // this same form in place would leave one or more controls
      // showing a stale prior value. `JSON.stringify` keeps the key
      // collision-free across arbitrary free-text `search`/`source`
      // values (a plain delimiter join could collide).
      key={JSON.stringify({ status: status ?? '', source: source ?? '', search: search ?? '' })}
      method="GET"
      action="/admin/leads"
      className={styles.filterForm}
      aria-label="Filter leads"
    >
      <div className={styles.filterField}>
        <label htmlFor="lead-search">Search</label>
        <input
          id="lead-search"
          name="search"
          type="search"
          defaultValue={search ?? ''}
          placeholder="Name, email, or phone"
        />
      </div>
      <div className={styles.filterField}>
        <label htmlFor="lead-status">Status</label>
        <select id="lead-status" name="status" defaultValue={status ?? ''}>
          <option value="">All statuses</option>
          {LEAD_STATUS_VALUES.map((value) => (
            <option key={value} value={value}>
              {LEAD_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.filterField}>
        <label htmlFor="lead-source">Source</label>
        <input
          id="lead-source"
          name="source"
          type="text"
          defaultValue={source ?? ''}
          placeholder="e.g. Contact page"
        />
      </div>
      <div className={styles.filterActions}>
        <button type="submit">Apply filters</button>
        <Link href="/admin/leads">Clear</Link>
      </div>
    </form>
  );
}
