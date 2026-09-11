import Link from 'next/link';

import type { ClientBookingDetail } from '@/features/bookings/service';

import styles from '../../client.module.css';

function BookingDate({ date }: { date: Date }) {
  return <time dateTime={date.toISOString().slice(0, 10)}>{date.toLocaleDateString('en-PH')}</time>;
}

// D-049 §5/§7 — the single-booking detail view. Renders exactly the
// approved detail allow-list the service already enforces (§5): no
// `Booking.id`, `clientId`, `proposalVersionId`, `internalNotes`, or
// financial field is ever present on `detail` to begin with — this
// component never spreads or otherwise re-derives fields beyond the DTO it
// receives. `includedServices` / `excludedServices` / `specialRequests` /
// `clientVisibleNotes` are rendered as plain text only (React's default
// text-node escaping — never `dangerouslySetInnerHTML`, per D-049 §5), each
// shown only when present so an empty section isn't displayed for content a
// consultant never entered.
export function BookingDetailView({ detail }: { detail: ClientBookingDetail }) {
  const hasWindow = detail.travelStartDate !== null || detail.travelEndDate !== null;

  return (
    <div className={styles.bookingDetail}>
      <Link className={styles.navLink} href="/client/bookings">
        Back to Bookings
      </Link>

      <h1 className={styles.bookingDetailHeading}>Booking {detail.bookingReference}</h1>
      <p className={styles.bookingDetailStatus}>{detail.statusLabel}</p>

      <dl className={styles.bookingDetailFacts}>
        <dt>Destination</dt>
        <dd>{detail.destination ?? '—'}</dd>

        <dt>Tour / package</dt>
        <dd>{detail.tourPackageName ?? '—'}</dd>

        <dt>Travel dates</dt>
        <dd>
          {hasWindow ? (
            <>
              {detail.travelStartDate ? <BookingDate date={detail.travelStartDate} /> : '—'}
              {' – '}
              {detail.travelEndDate ? <BookingDate date={detail.travelEndDate} /> : '—'}
            </>
          ) : (
            '—'
          )}
        </dd>

        <dt>Travelers</dt>
        <dd>{detail.travelerCount ?? '—'}</dd>
      </dl>

      {detail.includedServices ? (
        <section className={styles.bookingDetailSection} aria-label="Included services">
          <h2 className={styles.bookingDetailSectionHeading}>Included services</h2>
          <p className={styles.bookingDetailText}>{detail.includedServices}</p>
        </section>
      ) : null}

      {detail.excludedServices ? (
        <section className={styles.bookingDetailSection} aria-label="Excluded services">
          <h2 className={styles.bookingDetailSectionHeading}>Excluded services</h2>
          <p className={styles.bookingDetailText}>{detail.excludedServices}</p>
        </section>
      ) : null}

      {detail.specialRequests ? (
        <section className={styles.bookingDetailSection} aria-label="Special requests">
          <h2 className={styles.bookingDetailSectionHeading}>Special requests</h2>
          <p className={styles.bookingDetailText}>{detail.specialRequests}</p>
        </section>
      ) : null}

      {detail.clientVisibleNotes ? (
        <section
          className={styles.bookingDetailSection}
          aria-label="Notes from your travel consultant"
        >
          <h2 className={styles.bookingDetailSectionHeading}>Notes from your travel consultant</h2>
          <p className={styles.bookingDetailText}>{detail.clientVisibleNotes}</p>
        </section>
      ) : null}
    </div>
  );
}
