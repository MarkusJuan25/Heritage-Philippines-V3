import Link from 'next/link';

import type { PaymentBookingHeader } from '@/features/payments/repository';

import styles from '../payments.module.css';
import { BOOKING_STATUS_LABELS } from './labels';

/** One card per Booking the actor may see in payments (D-054 §6). */
export function PaymentBookingList({ items }: { items: PaymentBookingHeader[] }) {
  return (
    <ul className={styles.cards}>
      {items.map((booking) => (
        <li key={booking.id} className={styles.card}>
          <dl className={styles.cardDetails}>
            <div className={styles.cardDetailRow}>
              <dt>Booking reference</dt>
              <dd>
                <Link href={`/admin/payments/${booking.id}`}>{booking.bookingReference}</Link>
              </dd>
            </div>
            <div className={styles.cardDetailRow}>
              <dt>Client</dt>
              <dd>{booking.client.fullName}</dd>
            </div>
            <div className={styles.cardDetailRow}>
              <dt>Booking status</dt>
              <dd>{BOOKING_STATUS_LABELS[booking.status]}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
