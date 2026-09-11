import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';
import { ClientError } from '@/features/clients/errors';
import { getOwnClientForUser } from '@/features/clients/service';
import { BookingError } from '@/features/bookings/errors';
import { parseClientBookingListPageParam } from '@/features/bookings/schemas';
import {
  getClientBookingListPage,
  type ClientBookingListPageResult,
} from '@/features/bookings/service';

import { BookingList } from './_components/BookingList';
import styles from '../client.module.css';

type PageSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// D-049 §2/§4/§7 — recomputed per request from the caller's own session;
// never statically prerendered, ISR-cached, or full-route-cached. Inherits
// the `/client/:path*` `Cache-Control: private, no-store` /
// `Referrer-Policy: no-referrer` headers from next.config.ts (unchanged).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// D-049 §2, Layer 3 of the D-040 four-layer authorization model. Reads
// exactly one optional URL query, `page=N` (no database identifier, §4),
// through `parseClientBookingListPageParam`. The owned `clientId` is
// resolved from the session identity alone via Contract A; the read is
// re-checked with `canAccessClient` inside `getClientBookingListPage`'s own
// independent `assertClientPortalAccess` call (§2 — never shared with the
// detail route's own call). Contract A `null` (no ClientProfile) and a
// `ROLE_NOT_PERMITTED` from Contract A (`ClientError`) or the read service
// (`BookingError`) resolve to `null` (the layout owns the panel); every
// other value rethrows to `error.tsx`. The service's `{kind:'redirect'}`
// result is turned into a real `redirect('/client/bookings')` here — the
// service itself never calls a Next.js navigation function (§7).
export default async function ClientBookingsPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const { page: rawPage } = await searchParams;
  const page = parseClientBookingListPageParam(rawPage);

  let result: ClientBookingListPageResult | null = null;
  try {
    const owned = await getOwnClientForUser(user);
    if (!owned) {
      return null;
    }
    result = await getClientBookingListPage(user, owned.clientId, page);
  } catch (error) {
    if (
      (error instanceof ClientError || error instanceof BookingError) &&
      error.code === 'ROLE_NOT_PERMITTED'
    ) {
      return null;
    }
    throw error;
  }

  if (result.kind === 'redirect') {
    redirect('/client/bookings');
  }

  return (
    <div className={styles.overview}>
      <h1 className={styles.pageHeading}>Bookings</h1>
      <BookingList items={result.items} page={result.page} hasNext={result.hasNext} />
    </div>
  );
}
