import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';
import { ClientError } from '@/features/clients/errors';
import { getOwnClientForUser } from '@/features/clients/service';
import { PaymentError } from '@/features/payments/errors';
import { getClientPaymentSummaries } from '@/features/payments/service';

import { PaymentSummaryCard } from './_components/PaymentSummaryCard';
import styles from '../client.module.css';

// D-049 §2/§4/§7 pattern: recomputed per request from the caller's own
// session; never statically prerendered, ISR-cached, or full-route-cached.
// Inherits the `/client/:path*` `Cache-Control: private, no-store` and
// `Referrer-Policy: no-referrer` headers from next.config.ts.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Payments & Receipts (D-054 §7, Stage 4). Reads no URL parameter and no
 * record id: the owned `clientId` is resolved from the session identity
 * alone (Contract A), and `getClientPaymentSummaries` re-checks, on this
 * request, that the client may access it (`canAccessClient`) before
 * returning only that client's Bookings with an approved plan. Read-only —
 * no route or action exists for a client to change anything here.
 *
 * Contract A `null` and `ROLE_NOT_PERMITTED` resolve to `null` (the layout
 * owns those panels); every other failure goes to `error.tsx`.
 */
export default async function ClientPaymentsPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let summaries;
  try {
    const owned = await getOwnClientForUser(user);
    if (!owned) {
      return null;
    }
    summaries = await getClientPaymentSummaries(user, owned.clientId);
  } catch (error) {
    if (
      (error instanceof ClientError || error instanceof PaymentError) &&
      error.code === 'ROLE_NOT_PERMITTED'
    ) {
      return null;
    }
    throw error;
  }

  return (
    <div className={styles.overview}>
      <h1 className={styles.pageHeading}>Payments &amp; Receipts</h1>

      {summaries.length === 0 ? (
        <div className={styles.emptyState}>
          <p>No payment plans to show yet.</p>
          <p>
            Your payment plan appears here once it has been prepared and approved for your booking.
            If you were expecting one, or have a question about paying, message us in{' '}
            <Link href="/client/support">Support &amp; Messages</Link>.
          </p>
        </div>
      ) : (
        <ul className={styles.paymentSummaryList}>
          {summaries.map((summary) => (
            <PaymentSummaryCard key={summary.bookingReference} summary={summary} />
          ))}
        </ul>
      )}

      <p className={styles.supportGuidance}>
        Questions about a payment, or need a copy of a receipt? Message us in{' '}
        <Link href="/client/support">Support &amp; Messages</Link>.
      </p>
    </div>
  );
}
