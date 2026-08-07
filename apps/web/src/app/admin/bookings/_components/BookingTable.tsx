import Link from 'next/link';

import type { BookingStatus } from '@/generated/prisma/client';
import type { BookingRecord } from '@/features/bookings/repository';

import styles from '../bookings.module.css';

// Human-readable labels for the ten BookingStatus values (blueprint Section
// 13.4; docs/HERITAGE_V3_DECISIONS_LOG.md D-014) — never inventing a status
// the schema doesn't define (.claude/rules/admin-dashboard.md's "Status
// indicators must reflect the actual lifecycle statuses defined in the
// blueprint, not ad hoc labels invented in the UI layer"), mirroring
// admin/leads/_components/leadStatusLabels.ts's identical convention.
const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  DRAFT: 'Draft',
  PENDING_CONFIRMATION: 'Pending Confirmation',
  CONFIRMED: 'Confirmed',
  IN_PREPARATION: 'In Preparation',
  DOCUMENTS_REQUIRED: 'Documents Required',
  VISA_PROCESSING: 'Visa Processing',
  READY_FOR_TRAVEL: 'Ready for Travel',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const NOT_SET_PLACEHOLDER = 'Not set';

function DestinationValue({ destination }: { destination: string | null }) {
  return destination === null ? <>{NOT_SET_PLACEHOLDER}</> : <>{destination}</>;
}

function TravelDateValue({ date }: { date: Date | null }) {
  if (date === null) {
    return <>{NOT_SET_PLACEHOLDER}</>;
  }
  return <time dateTime={date.toISOString().slice(0, 10)}>{date.toLocaleDateString('en-PH')}</time>;
}

/**
 * Renders the Booking list twice — a stacked-card layout for narrow screens
 * and a real `<table>` from tablet width up — with CSS alone toggling which
 * is visible (`bookings.module.css`), never duplicating data-fetching or
 * JS-driven layout switching (.claude/rules/frontend.md's mobile-first
 * requirement), mirroring
 * admin/proposals/_components/ProposalTable.tsx's established pattern.
 *
 * Renders the Stage 2A list's selected fields (`bookingReference`, `status`,
 * `destination`, `travelStartDate`, `travelEndDate`, `createdAt`) — all
 * drawn from the existing `BookingRecord` response shape (D-028 §10 and its
 * Constraint paragraph: "Booking list/detail data may display only fields
 * the existing `BookingRecord` response shape already returns") — plus a
 * `bookingReference` link to the Booking's own detail page at
 * `/admin/bookings/{booking.id}` (D-028 §3's authorized detail route,
 * implemented in a later stage; this link target is authorized now without
 * creating that route). Items are rendered in exactly the order supplied —
 * this component never sorts or filters `items` itself. Deferred/sensitive
 * fields (`internalNotes`, `clientVisibleNotes`, `specialRequests`,
 * `includedServices`, `excludedServices`, `travelerCount`,
 * `proposalVersionId`, `totalAmount`, `currencyCode`, status history,
 * assignment information) are never rendered here (D-028 §10's explicit
 * deferrals). Booking creation is not initiated from this list — it is
 * entry-pointed from the Proposal detail flow instead (D-028 §6).
 *
 * The mobile card carries the same information as the desktop row —
 * including identical formatting — labelled with a `dl`/`dt`/`dd` structure,
 * including the booking-reference link itself, so each value's meaning is
 * visible and accessible without relying on column position alone (the
 * desktop table's own `scope="col"` headers already provide that for its
 * layout).
 */
export function BookingTable({ items }: { items: BookingRecord[] }) {
  return (
    <>
      <ul className={styles.bookingCards}>
        {items.map((booking) => (
          <li key={booking.id} className={styles.bookingCard}>
            <dl className={styles.bookingCardDetails}>
              <div className={styles.bookingCardDetailRow}>
                <dt>Booking reference</dt>
                <dd>
                  <Link href={`/admin/bookings/${booking.id}`}>{booking.bookingReference}</Link>
                </dd>
              </div>
              <div className={styles.bookingCardDetailRow}>
                <dt>Status</dt>
                <dd>{BOOKING_STATUS_LABELS[booking.status]}</dd>
              </div>
              <div className={styles.bookingCardDetailRow}>
                <dt>Destination</dt>
                <dd>
                  <DestinationValue destination={booking.destination} />
                </dd>
              </div>
              <div className={styles.bookingCardDetailRow}>
                <dt>Travel start</dt>
                <dd>
                  <TravelDateValue date={booking.travelStartDate} />
                </dd>
              </div>
              <div className={styles.bookingCardDetailRow}>
                <dt>Travel end</dt>
                <dd>
                  <TravelDateValue date={booking.travelEndDate} />
                </dd>
              </div>
              <div className={styles.bookingCardDetailRow}>
                <dt>Created</dt>
                <dd>
                  <time dateTime={booking.createdAt.toISOString()}>
                    {booking.createdAt.toLocaleDateString('en-PH')}
                  </time>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <table className={styles.bookingTable}>
        <caption className={styles.srOnly}>Bookings</caption>
        <thead>
          <tr>
            <th scope="col">Booking reference</th>
            <th scope="col">Status</th>
            <th scope="col">Destination</th>
            <th scope="col">Travel start</th>
            <th scope="col">Travel end</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((booking) => (
            <tr key={booking.id}>
              <th scope="row">
                <Link href={`/admin/bookings/${booking.id}`}>{booking.bookingReference}</Link>
              </th>
              <td>{BOOKING_STATUS_LABELS[booking.status]}</td>
              <td>
                <DestinationValue destination={booking.destination} />
              </td>
              <td>
                <TravelDateValue date={booking.travelStartDate} />
              </td>
              <td>
                <TravelDateValue date={booking.travelEndDate} />
              </td>
              <td>
                <time dateTime={booking.createdAt.toISOString()}>
                  {booking.createdAt.toLocaleDateString('en-PH')}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
