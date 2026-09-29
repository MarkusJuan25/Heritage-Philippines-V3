import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { listPaymentBookingsSchema } from '@/features/payments/schemas';
import { listPaymentBookingsForActor } from '@/features/payments/service';

import { Pagination } from '../_components/Pagination';
import { PLAN_FILTER_LABELS } from './_components/labels';
import { PaymentBookingList } from './_components/PaymentBookingList';
import styles from './payments.module.css';

// D-054 §3/§6: the roles the payments reads permit. The service scopes
// Travel Consultant and Finance/Accounting to their assigned Bookings; this
// gate only decides who may open the page at all.
const ALLOWED_ROLES: readonly AppRole[] = [
  'ADMIN_MANAGER',
  'TRAVEL_CONSULTANT',
  'FINANCE_ACCOUNTING',
];

type PageSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * The staff payments list (D-054 Stage 3; D-056 §3's
 * `listPaymentBookingsForActor`): a Booking-reference search, a plan-state
 * filter, and pagination, all in URL search parameters. Empty filter values
 * from the GET form are dropped before strict validation, so submitting the
 * form with a blank field shows every Booking rather than an error.
 */
export default async function AdminPaymentsPage({
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
        <p>
          Only Admin/Manager, Travel Consultant, and Finance/Accounting staff can access payments.
        </p>
      </div>
    );
  }

  const rawParams = Object.fromEntries(
    Object.entries(await searchParams).filter(([, value]) => value !== ''),
  );
  const queryResult = listPaymentBookingsSchema.safeParse(rawParams);

  if (!queryResult.success) {
    return (
      <div>
        <h1>Payments</h1>
        <div className={styles.errorState} role="alert">
          <p>The page parameters in the URL are invalid.</p>
          <Link href="/admin/payments">Clear and start over</Link>
        </div>
      </div>
    );
  }

  const query = queryResult.data;
  const { items, total } = await listPaymentBookingsForActor(user, query);
  const { page, pageSize } = query;

  function buildHref(targetPage: number): string {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.planState) params.set('planState', query.planState);
    params.set('page', String(targetPage));
    params.set('pageSize', String(pageSize));
    return `/admin/payments?${params.toString()}`;
  }

  const lastValidPage = Math.max(1, Math.ceil(total / pageSize));
  if (total > 0 && page > lastValidPage) {
    redirect(buildHref(lastValidPage));
  }

  const filtered = Boolean(query.search || query.planState);

  return (
    <div>
      <div className={styles.pageHeader}>
        <h1>Payments</h1>
      </div>

      <form method="get" action="/admin/payments" className={styles.filters} role="search">
        <div className={styles.formField}>
          <label htmlFor="payments-search">Booking reference</label>
          <input
            id="payments-search"
            name="search"
            type="search"
            defaultValue={query.search ?? ''}
            maxLength={200}
          />
        </div>
        <div className={styles.formField}>
          <label htmlFor="payments-plan-state">Payment plan</label>
          <select id="payments-plan-state" name="planState" defaultValue={query.planState ?? ''}>
            <option value="">Any</option>
            {Object.entries(PLAN_FILTER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.formActions}>
          <button type="submit">Filter</button>
          {filtered ? <Link href="/admin/payments">Clear</Link> : null}
        </div>
      </form>

      {total === 0 ? (
        <div className={styles.emptyState}>
          {filtered ? (
            <p>No bookings match these filters.</p>
          ) : (
            <p>
              No bookings are available to you in payments yet. A Booking appears here once you are
              assigned to it.
            </p>
          )}
        </div>
      ) : (
        <>
          <PaymentBookingList items={items} />
          <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
        </>
      )}
    </div>
  );
}
