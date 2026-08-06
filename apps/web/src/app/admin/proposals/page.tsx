import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { listProposalsQuerySchema } from '@/features/proposals/schemas';
import { listProposals } from '@/features/proposals/service';

import { Pagination } from '../_components/Pagination';
import { ProposalTable } from './_components/ProposalTable';
import styles from './proposals.module.css';

// D-027 §3/§8: exactly ADMIN_MANAGER and TRAVEL_CONSULTANT may list
// Proposals — mirrors admin/clients/page.tsx's identical Layer 3 role-gate
// pattern. Every other staff role (and CLIENT, though app/admin/layout.tsx
// already excludes it before this page ever renders) receives an in-place
// permission-denied state here too, never a redirect.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

type PageSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * Read-only Proposal list (D-027 §8's `/admin/proposals`, Stage 7A). A
 * Server Component that authenticates the actor, validates `searchParams`
 * through the existing `listProposalsQuerySchema` (the same schema
 * `GET /api/proposals` itself uses — page/pageSize only, per D-027 §6's
 * route table), and calls the `listProposals` application service directly —
 * never a repository, never an internal fetch to the API route. Pagination
 * uses the shared admin `Pagination` component
 * (admin/_components/Pagination.tsx). There is no filter of any kind on
 * this page — D-027 §8 defines no title/reference/status field on a
 * Proposal to filter by in the first place. Any unexpected error from
 * `listProposals` is intentionally not caught here — it bubbles to this
 * route segment's nearest error boundary.
 */
export default async function AdminProposalsPage({
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
        <p>Only Admin/Manager and Travel Consultant staff can access Proposal management.</p>
      </div>
    );
  }

  const rawParams = await searchParams;
  const queryResult = listProposalsQuerySchema.safeParse(rawParams);

  if (!queryResult.success) {
    return (
      <div>
        <h1>Proposals</h1>
        <div className={styles.errorState} role="alert">
          <p>The page parameters in the URL are invalid.</p>
          <Link href="/admin/proposals">Clear and start over</Link>
        </div>
      </div>
    );
  }

  const query = queryResult.data;
  const { items, page, pageSize, total } = await listProposals(user, query);

  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    params.set('page', String(targetPage));
    params.set('pageSize', String(pageSize));
    return `/admin/proposals?${params.toString()}`;
  }

  // A page beyond the last valid page for a genuinely non-empty result set
  // redirects there, preserving pageSize, rather than rendering a false
  // empty state — mirrors admin/clients/page.tsx's identical correction.
  // `total === 0` is excluded so a truly empty result still renders the
  // real empty state below instead of redirecting to "page 1 of nothing."
  const lastValidPage = Math.max(1, Math.ceil(total / pageSize));
  if (total > 0 && page > lastValidPage) {
    redirect(buildHref(lastValidPage));
  }

  return (
    <div>
      <div className={styles.pageHeader}>
        <h1>Proposals</h1>
      </div>

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <p>No proposals yet.</p>
        </div>
      ) : (
        <>
          <ProposalTable items={items} />
          <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
        </>
      )}
    </div>
  );
}
