import Link from 'next/link';

import type { PaymentStatus, Prisma } from '@/generated/prisma/client';
import type { BookingPaymentSummary } from '@/features/payments/service';

import styles from '../../client.module.css';

// The client-facing names of the payment statuses the schema defines
// (blueprint §11.2) — never an invented intermediate state.
const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
  REVERSED: 'Reversed',
};

/** A server-computed amount, formatted for display only — never recalculated. */
export function formatMoney(value: Prisma.Decimal, currencyCode: string | null): string {
  const [whole, fraction] = value.toFixed(2).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currencyCode ? `${currencyCode} ` : ''}${grouped}.${fraction}`;
}

// Installment due dates are calendar dates (`@db.Date`, stored at UTC
// midnight), so they are formatted in UTC to never shift a day.
function CalendarDate({ date }: { date: Date }) {
  return (
    <time dateTime={date.toISOString().slice(0, 10)}>
      {date.toLocaleDateString('en-PH', { timeZone: 'UTC' })}
    </time>
  );
}

function IssuedDate({ date }: { date: Date }) {
  return <time dateTime={date.toISOString()}>{date.toLocaleDateString('en-PH')}</time>;
}

/**
 * One owned Booking's approved payment plan (D-054 §7): the five values the
 * server computed — total, confirmed amount paid, remaining balance, next
 * payment due with its amount, and the full payment history with each
 * payment's status — plus the installment schedule and receipts. Read-only:
 * no action of any kind is rendered. Receipts are shown as their number and
 * issue date beside the payment they belong to, marked by that payment's
 * current status (blueprint §11.5); there is no receipt link or file.
 * Internal record ids are never rendered — including as React keys: this is
 * a server component, and the RSC payload inlined into the HTML serializes
 * every element's key. These read-only lists keep the server's order and are
 * never reordered on the client, so each item is keyed by its position.
 */
export function PaymentSummaryCard({ summary }: { summary: BookingPaymentSummary }) {
  const currency = summary.currencyCode;
  const headingId = `payments-${summary.bookingReference}`;

  return (
    <li>
      <article className={styles.paymentSummary} aria-labelledby={headingId}>
        <h2 id={headingId} className={styles.sectionHeading}>
          Booking {summary.bookingReference}
        </h2>
        <Link
          className={styles.navLink}
          href={`/client/bookings/${encodeURIComponent(summary.bookingReference)}`}
        >
          View booking details
        </Link>

        <dl className={styles.bookingDetailFacts}>
          <dt>Total booking amount</dt>
          <dd>{summary.totalAmount ? formatMoney(summary.totalAmount, currency) : '—'}</dd>

          <dt>Confirmed amount paid</dt>
          <dd>{formatMoney(summary.confirmedAmountPaid, currency)}</dd>

          <dt>Remaining balance</dt>
          <dd>
            {summary.remainingBalance ? formatMoney(summary.remainingBalance, currency) : '—'}
          </dd>

          <dt>Next payment due</dt>
          <dd>
            {summary.nextPaymentDue && summary.nextPaymentDueAmount ? (
              <>
                {formatMoney(summary.nextPaymentDueAmount, currency)} on{' '}
                <CalendarDate date={summary.nextPaymentDue} />
              </>
            ) : (
              'Nothing is due right now'
            )}
          </dd>
        </dl>

        <section className={styles.bookingDetailSection} aria-label="Installment schedule">
          <h3 className={styles.bookingDetailSectionHeading}>Installment schedule</h3>
          <ol className={styles.paymentItemList}>
            {summary.installments.map((installment, index) => (
              <li key={`installment-${index + 1}`} className={styles.paymentItem}>
                <span>Installment {index + 1}</span>
                <span>
                  Due <CalendarDate date={installment.dueDate} />
                </span>
                <span>{formatMoney(installment.amount, currency)}</span>
                <span>
                  {installment.outstandingAmount.greaterThan(0)
                    ? `${formatMoney(installment.outstandingAmount, currency)} outstanding`
                    : 'Paid'}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.bookingDetailSection} aria-label="Payment history">
          <h3 className={styles.bookingDetailSectionHeading}>Payment history</h3>
          {summary.payments.length === 0 ? (
            <p className={styles.emptyState}>No payments have been recorded yet.</p>
          ) : (
            <ul className={styles.paymentItemList}>
              {summary.payments.map((payment, index) => (
                <li key={`payment-${index + 1}`} className={styles.paymentItem}>
                  <span>{formatMoney(payment.amount, currency)}</span>
                  <span>{PAYMENT_STATUS_LABELS[payment.status]}</span>
                  <span>
                    {payment.receipt ? (
                      <>
                        Receipt {payment.receipt.receiptNumber}, issued{' '}
                        <IssuedDate date={payment.receipt.issuedAt} />
                      </>
                    ) : (
                      'No receipt'
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </article>
    </li>
  );
}
