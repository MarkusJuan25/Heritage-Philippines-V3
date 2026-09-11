import Link from 'next/link';

import styles from '../client.module.css';

// D-049 §7 — the segment not-found boundary for /client/bookings, reached
// via Next.js's notFound() from the detail route
// ([bookingReference]/page.tsx) for every controlled absence: a malformed
// bookingReference, a nonexistent reference, a DRAFT booking's reference,
// and another client's booking's reference are all indistinguishable at
// that point — this renders one calm, generic state regardless of which
// held, revealing neither the rejected reference nor the reason. A <div>,
// never a nested <main> (the one <main> landmark is client/layout.tsx's).
// No fixed HTTP status is asserted by this component — per Next.js's own
// documented behavior a `notFound()` response is 404 when the response has
// not yet begun streaming, and may be 200 if streaming has already begun;
// the identical user-visible boundary here is what this contract requires,
// not the transport status.
export default function ClientBookingNotFound() {
  return (
    <div>
      <h1>Booking not found</h1>
      <p>
        We couldn&apos;t find that booking. It may not exist, or it may not be available to your
        account.
      </p>
      <Link className={styles.navLink} href="/client/bookings">
        Back to Bookings
      </Link>
    </div>
  );
}
