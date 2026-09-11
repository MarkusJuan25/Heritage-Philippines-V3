import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';
import { ClientError } from '@/features/clients/errors';
import { getOwnClientForUser } from '@/features/clients/service';
import { BookingError } from '@/features/bookings/errors';
import { getClientBookingDetail, type ClientBookingDetail } from '@/features/bookings/service';

import { BookingDetailView } from '../_components/BookingDetailView';
import styles from '../../client.module.css';

type PageParams = Promise<{ bookingReference: string }>;

// D-049 §2/§3/§7 — recomputed per request; inherits the unchanged
// `/client/:path*` header contract from next.config.ts.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// D-049 §2/§3/§7, Layer 3. The route segment value is passed straight to
// `getClientBookingDetail`, which lexically validates it (§3) before any
// query and independently calls `assertClientPortalAccess` (§2 — never
// shared with the list route's own call). A `null` result — a malformed
// reference, a nonexistent reference, a DRAFT booking's reference, or
// another client's booking's reference, all indistinguishable at this
// layer — is mapped here, and ONLY here, to Next.js's `notFound()` (§7);
// the service/repository layer never calls it. `notFound()` is called
// strictly outside the try/catch below, so the internal Next.js
// control-flow signal it throws is never caught and swallowed as an
// ordinary error. Contract A `null` and a `ROLE_NOT_PERMITTED` from
// Contract A (`ClientError`) or the read service (`BookingError`) resolve
// to `null` (the layout owns the panel) before `notFound()` is ever
// reached; every other value rethrows to `error.tsx`.
export default async function ClientBookingDetailPage({ params }: { params: PageParams }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const { bookingReference } = await params;

  let detail: ClientBookingDetail | null = null;
  try {
    const owned = await getOwnClientForUser(user);
    if (!owned) {
      return null;
    }
    detail = await getClientBookingDetail(user, owned.clientId, bookingReference);
  } catch (error) {
    if (
      (error instanceof ClientError || error instanceof BookingError) &&
      error.code === 'ROLE_NOT_PERMITTED'
    ) {
      return null;
    }
    throw error;
  }

  if (detail === null) {
    notFound();
  }

  return (
    <div className={styles.overview}>
      <BookingDetailView detail={detail} />
    </div>
  );
}
