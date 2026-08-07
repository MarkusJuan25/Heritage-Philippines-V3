import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { listBookingsQuerySchema } from '@/features/bookings/schemas';
import { listBookings } from '@/features/bookings/service';

import { Pagination } from '../_components/Pagination';
import { BookingTable } from './_components/BookingTable';
import styles from './bookings.module.css';

// D-028 §3: exactly ADMIN_MANAGER and TRAVEL_CONSULTANT may list Bookings —
// mirrors admin/proposals/page.tsx's identical Layer 3 role-gate pattern.
// Every other staff role (and CLIENT, though app/admin/layout.tsx already
// excludes it before this page ever renders) receives an in-place
// permission-denied state here too, never a redirect.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

type PageSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * Read-only Booking list (D-028 §3/§4's `/admin/bookings`, Stage 2A). A
 * Server Component that authenticates the actor, validates `searchParams`
 * through the existing `listBookingsQuerySchema` (the same schema
 * `GET /api/bookings` itself uses — page/pageSize only, per D-028 §4), and
 * calls the `listBookings` application service directly — never a
 * repository, never an internal fetch to the API route. Pagination uses the
 * shared admin `Pagination` component (admin/_components/Pagination.tsx).
 * There is no filter of any kind on this page — D-028 §4 authorizes no
 * filter field, since the current Booking list contract supports pagination
 * only. Any unexpected error from `listBookings` is intentionally not
 * caught here — it bubbles to this route segment's nearest error boundary
 * (D-028 §4).
 */
export default async function AdminBookingsPage({
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
        <p>Only Admin/Manager and Travel Consultant staff can access Booking management.</p>
      </div>
    );
  }

  const rawParams = await searchParams;
  const queryResult = listBookingsQuerySchema.safeParse(rawParams);

  if (!queryResult.success) {
    return (
      <div>
        <h1>Bookings</h1>
        <div className={styles.errorState} role="alert">
          <p>The page parameters in the URL are invalid.</p>
          <Link href="/admin/bookings">Clear and start over</Link>
        </div>
      </div>
    );
  }

  const query = queryResult.data;
  const { items, page, pageSize, total } = await listBookings(user, query);

  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    params.set('page', String(targetPage));
    params.set('pageSize', String(pageSize));
    return `/admin/bookings?${params.toString()}`;
  }

  // A page beyond the last valid page for a genuinely non-empty result set
  // redirects there, preserving pageSize, rather than rendering a false
  // empty state — mirrors admin/proposals/page.tsx's identical correction.
  // `total === 0` is excluded so a truly empty result still renders the
  // real empty state below instead of redirecting to "page 1 of nothing."
  const lastValidPage = Math.max(1, Math.ceil(total / pageSize));
  if (total > 0 && page > lastValidPage) {
    redirect(buildHref(lastValidPage));
  }

  return (
    <div>
      <div className={styles.pageHeader}>
        <h1>Bookings</h1>
      </div>

      {total === 0 ? (
        <div className={styles.emptyState}>
          <p>No bookings yet.</p>
        </div>
      ) : (
        <>
          <BookingTable items={items} />
          <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
        </>
      )}
    </div>
  );
}
