import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { listClientsQuerySchema } from '@/features/clients/schemas';
import { listClients } from '@/features/clients/service';

import { Pagination } from '../_components/Pagination';
import { ClientFilters } from './_components/ClientFilters';
import { ClientTable } from './_components/ClientTable';
import styles from './clients.module.css';

// Layer 3 of the established defense-in-depth authorization pattern
// (mirrors admin/leads/page.tsx exactly): independently re-resolves the
// authenticated user (never trusting app/admin/layout.tsx's own check,
// Layer 2) and narrows the Client surface to exactly the two roles D-025 §2
// authorizes to manage Clients. Every other staff role — and CLIENT, though
// the layout above already excludes it before this page ever renders —
// receives an in-place permission-denied state here too.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

type PageSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * Maps an exactly-empty string to `undefined`, leaving every other value
 * (arrays, non-empty strings, `undefined` itself) unchanged — mirrors
 * admin/leads/page.tsx's identical `normalizeBlankParam` helper (a
 * deliberate, self-contained copy, not a shared import, matching that
 * page's own precedent of not sharing this helper across list pages). A
 * native GET form always submits `search`, blank or not; `search` in
 * `listClientsQuerySchema` is `.optional()` with its own `.min(1)` check and
 * no blank-string transform, so an untouched form control would otherwise
 * fail validation.
 */
function normalizeBlankParam<T extends string | string[] | undefined>(value: T): T | undefined {
  return value === '' ? undefined : value;
}

/**
 * Read-only Client list (D-025 §3's `/admin/clients`, Slice 1). A Server
 * Component that authenticates the actor, validates `searchParams` through
 * the existing `listClientsQuerySchema` (the same schema `GET /api/clients`
 * itself uses), and calls the `listClients` application service directly —
 * never a repository, never an internal fetch to the API route. The single
 * `search` filter and pagination live entirely in the URL query string
 * (`ClientFilters`, the `Pagination` component below), so no
 * client-side state or JS is required for this page to be fully functional
 * and keyboard-operable. Pagination uses the shared admin `Pagination`
 * component (admin/_components/Pagination.tsx), relocated from
 * admin/leads in D-025 §10 specifically so the Lead and Client list pages
 * no longer duplicate this markup. Any unexpected error from `listClients`
 * is intentionally not caught here — it bubbles to this route segment's
 * nearest error boundary.
 */
export default async function AdminClientsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, ALLOWED_ROLES);
  if (!access.authorized) {
    return (
      <div>
        <h1>Access denied</h1>
        <p>Only Admin/Manager and Travel Consultant staff can access Client management.</p>
      </div>
    );
  }

  const rawParams = await searchParams;
  const normalizedParams = {
    ...rawParams,
    search: normalizeBlankParam(rawParams.search),
  };
  const queryResult = listClientsQuerySchema.safeParse(normalizedParams);

  if (!queryResult.success) {
    return (
      <div>
        <h1>Clients</h1>
        <div className={styles.errorState} role="alert">
          <p>The filter or page parameters in the URL are invalid.</p>
          <Link href="/admin/clients">Clear filters and start over</Link>
        </div>
      </div>
    );
  }

  const query = queryResult.data;
  const { items, page, pageSize, total } = await listClients(user, query);

  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    params.set('page', String(targetPage));
    params.set('pageSize', String(pageSize));
    return `/admin/clients?${params.toString()}`;
  }

  // A page beyond the last valid page for a genuinely non-empty result set
  // redirects there, preserving the search and pageSize, rather than
  // rendering a false empty state — mirrors admin/leads/page.tsx's
  // identical correction. `total === 0` is excluded so a truly empty result
  // still renders the real empty state below instead of redirecting to
  // "page 1 of nothing." `lastValidPage` depends only on `total`/`pageSize`
  // (never on the requested `page` itself), so the corrected page always
  // satisfies `page <= lastValidPage` on the very next request — this
  // cannot loop.
  const lastValidPage = Math.max(1, Math.ceil(total / pageSize));
  if (total > 0 && page > lastValidPage) {
    redirect(buildHref(lastValidPage));
  }

  const hasActiveFilters = Boolean(query.search);

  return (
    <div>
      <div className={styles.pageHeader}>
        <h1>Clients</h1>
      </div>
      <ClientFilters search={query.search} />

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <p>
            {hasActiveFilters
              ? 'No clients match this search.'
              : 'No clients yet. Clients created through lead conversion will appear here.'}
          </p>
          {hasActiveFilters ? <Link href="/admin/clients">Clear filters</Link> : null}
        </div>
      ) : (
        <>
          <ClientTable items={items} />
          <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
        </>
      )}
    </div>
  );
}
