import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { listLeadsQuerySchema } from '@/features/leads/schemas';
import { listLeads } from '@/features/leads/service';

import { LeadFilters } from './_components/LeadFilters';
import { LeadTable } from './_components/LeadTable';
import { Pagination } from './_components/Pagination';
import styles from './leads.module.css';

// Layer 3 of D-023 §2's defense-in-depth authorization: independently
// re-resolves the authenticated user (never trusting app/admin/layout.tsx's
// own check, Layer 2) and narrows the Lead surface to exactly the two
// roles D-022 authorizes to manage Leads. Every other staff role — and
// CLIENT, though the layout above already excludes it before this page
// ever renders — receives an in-place permission-denied state here too,
// consistent with this checkpoint's defense-in-depth discipline.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

type PageSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * Maps an exactly-empty string to `undefined`, leaving every other value
 * (arrays, non-empty strings, `undefined` itself) unchanged (Stage 3
 * correction, Finding 1). Never normalizes an arbitrary invalid value —
 * only the specific blank-string shape a native GET form control submits
 * when left empty.
 */
function normalizeBlankParam<T extends string | string[] | undefined>(value: T): T | undefined {
  return value === '' ? undefined : value;
}

/**
 * Read-only Lead list (D-023 §4's `/admin/leads`). A Server Component that
 * authenticates the actor, validates `searchParams` through the existing
 * `listLeadsQuerySchema` (D-023 §9 — the same schema `GET /api/leads`
 * itself uses), and calls the `listLeads` application service directly —
 * never a repository, never an internal fetch to the API route. Filters
 * and pagination live entirely in the URL query string
 * (`LeadFilters`/`Pagination`), so no client-side state or JS is required
 * for this page to be fully functional and keyboard-operable. Any
 * unexpected error from `listLeads` is intentionally not caught here — it
 * bubbles to this route segment's `error.tsx` boundary.
 */
export default async function AdminLeadsPage({ searchParams }: { searchParams: PageSearchParams }) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, ALLOWED_ROLES);
  if (!access.authorized) {
    return (
      <div>
        <h1>Access denied</h1>
        <p>Only Admin/Manager and Travel Consultant staff can access Lead management.</p>
      </div>
    );
  }

  const rawParams = await searchParams;
  // Stage 3 correction (Finding 1): a native GET form submits every named
  // control, blank or not — an unfiltered submission from LeadFilters
  // produces `{ status: '', source: '', search: 'juan' }`, not omitted
  // keys. `listLeadsQuerySchema`'s `status`/`source`/`search` are
  // `.optional()` (absent/undefined only) with no blank-string transform
  // of their own (unlike, e.g., features/leads/schemas.ts's create/edit
  // schemas), and must not be changed here — this page alone normalizes
  // an exactly-empty string to `undefined` before validation, for these
  // three fields only. Arrays and every non-empty value pass through
  // unchanged, so a genuinely malformed value (e.g. an invalid status)
  // still fails validation exactly as before.
  const normalizedParams = {
    ...rawParams,
    status: normalizeBlankParam(rawParams.status),
    source: normalizeBlankParam(rawParams.source),
    search: normalizeBlankParam(rawParams.search),
  };
  const queryResult = listLeadsQuerySchema.safeParse(normalizedParams);

  if (!queryResult.success) {
    return (
      <div>
        <h1>Leads</h1>
        <div className={styles.errorState} role="alert">
          <p>The filter or page parameters in the URL are invalid.</p>
          <Link href="/admin/leads">Clear filters and start over</Link>
        </div>
      </div>
    );
  }

  const query = queryResult.data;
  const { items, page, pageSize, total } = await listLeads(user, query);

  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.source) params.set('source', query.source);
    if (query.search) params.set('search', query.search);
    params.set('page', String(targetPage));
    params.set('pageSize', String(pageSize));
    return `/admin/leads?${params.toString()}`;
  }

  // Stage 3 correction (Finding 2): a page beyond the last valid page for
  // a genuinely non-empty result set must redirect there, preserving
  // filters and pageSize, rather than rendering a false empty state.
  // `total === 0` is excluded so a truly empty result (no leads at all,
  // or none matching the active filters) still renders the real empty
  // state below instead of redirecting to "page 1 of nothing." Because
  // `lastValidPage` depends only on `total`/`pageSize` (never on the
  // requested `page` itself), the corrected page always satisfies
  // `page <= lastValidPage` on the very next request — this cannot loop.
  const lastValidPage = Math.max(1, Math.ceil(total / pageSize));
  if (total > 0 && page > lastValidPage) {
    redirect(buildHref(lastValidPage));
  }

  const hasActiveFilters = Boolean(query.status || query.source || query.search);

  return (
    <div>
      <div className={styles.pageHeader}>
        <h1>Leads</h1>
        <Link href="/admin/leads/new" className={styles.newLeadLink}>
          New Lead
        </Link>
      </div>
      <LeadFilters status={query.status} source={query.source} search={query.search} />

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <p>
            {hasActiveFilters
              ? 'No leads match these filters.'
              : 'No leads yet. Leads created by staff will appear here.'}
          </p>
          {hasActiveFilters ? <Link href="/admin/leads">Clear filters</Link> : null}
        </div>
      ) : (
        <>
          <LeadTable items={items} />
          <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
        </>
      )}
    </div>
  );
}
