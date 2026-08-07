import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { BookingStatus } from '@/generated/prisma/client';
import { BookingError } from '@/features/bookings/errors';
import { bookingIdParamSchema } from '@/features/bookings/schemas';
import { getBookingById } from '@/features/bookings/service';
import { isTransitionAllowed } from '@/features/bookings/transitions';
import { findActiveAssignmentForBooking } from '@/features/assignments/repository';
import { prisma } from '@/lib/db';

import styles from '../bookings.module.css';
import { BookingStatusTransitionPanel } from './_components/BookingStatusTransitionPanel';
import { BookingAssignmentPanel } from './_components/BookingAssignmentPanel';
import type { BookingAssignmentSummary } from './_components/BookingAssignmentPanel';

// D-028 §3: exactly ADMIN_MANAGER and TRAVEL_CONSULTANT may read a
// Booking's detail — mirrors admin/proposals/[id]/page.tsx's/
// admin/clients/[id]/page.tsx's identical Layer 3 role-gate pattern.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

const NOT_SET_PLACEHOLDER = 'Not set';

// Duplicated from admin/bookings/_components/BookingTable.tsx rather than
// imported/shared, because Stage 2B's authorized file boundary does not
// permit modifying BookingTable.tsx (D-028 Stage 2B correction-pass
// discipline) — mirrors this codebase's established per-feature-copy
// convention (e.g. clients.module.css/proposals.module.css each keeping
// their own copy of generically-named classes) taken to its file-scoped
// extreme here. Never inventing a status the schema doesn't define
// (.claude/rules/admin-dashboard.md).
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

type PageParams = Promise<{ id: string }>;

function TextValue({ value }: { value: string | null }) {
  return <>{value === null ? NOT_SET_PLACEHOLDER : value}</>;
}

function NumberValue({ value }: { value: number | null }) {
  return <>{value === null ? NOT_SET_PLACEHOLDER : value}</>;
}

function DateValue({ date }: { date: Date | null }) {
  if (date === null) {
    return <>{NOT_SET_PLACEHOLDER}</>;
  }
  return <time dateTime={date.toISOString().slice(0, 10)}>{date.toLocaleDateString('en-PH')}</time>;
}

/**
 * Booking detail foundation (D-028 §3/§5's `/admin/bookings/[id]`, Stage
 * 2B). A Server Component that authenticates the actor, validates the
 * route `id` through the existing `bookingIdParamSchema`, and calls the
 * `getBookingById` application service directly — never a repository,
 * never an internal fetch to `GET /api/bookings/[id]` — mirroring
 * admin/proposals/[id]/page.tsx's/admin/clients/[id]/page.tsx's identical
 * established pattern exactly.
 *
 * `BOOKING_NOT_FOUND`/`BOOKING_FORBIDDEN` are handled explicitly inline and
 * render the identical "Booking not found" state, preserving D-028 §2's
 * anti-enumeration property exactly as the service layer already shapes
 * it: an unassigned `TRAVEL_CONSULTANT` can never distinguish "this Booking
 * does not exist" from "this Booking exists but is not assigned to you"
 * from this page's rendered output — neither branch renders any
 * Booking-specific content. Any other error bubbles to this route
 * segment's nearest error boundary, exactly as the Proposal/Client detail
 * pages already establish for an unexpected service failure.
 *
 * Displays every D-028 §5-authorized `BookingRecord` field read-only:
 * `bookingReference` (as the page heading, mirroring
 * admin/clients/[id]/page.tsx's `client.fullName`-as-heading convention —
 * not duplicated in the field list below), `status` (as a human-readable
 * label), `clientId` (linked to `/admin/clients/[clientId]`; `BookingRecord`
 * carries no Client name to display, so the link text is the id itself),
 * `proposalVersionId` (reference text only, never a link — no
 * proposal-version detail route exists), the nullable operational/travel
 * fields, and `createdAt`/`updatedAt`. The raw Booking `id` is never
 * rendered as a separate field — it is already this page's own route
 * identity. `totalAmount`/`currencyCode` are not part of `BookingRecord`
 * and are never displayed or inferred (D-028 §5). No edit or
 * status-history control is rendered by this page (D-028 §5/§10).
 *
 * As of Stage 2C, this page additionally computes `allowedTargetStatuses`
 * server-side — every `BookingStatus` value (from the canonical generated
 * enum) for which the existing, unmodified `isTransitionAllowed(booking.
 * status, candidate)` returns true — and passes only that already-filtered
 * set to `BookingStatusTransitionPanel` (D-028 §7), rendered for both
 * `ADMIN_MANAGER` and `TRAVEL_CONSULTANT` (both already the only two roles
 * that can reach this point, per the `ALLOWED_ROLES` gate above). The panel
 * never independently computes or widens this set.
 *
 * As of Stage 2D, this page additionally reads the Booking's active
 * assignment by calling the existing, already-implemented
 * `features/assignments/repository.ts`'s `findActiveAssignmentForBooking`
 * directly (D-028 §8) — a same-process, owning-feature function call, not
 * a new HTTP round-trip, and no `GET /api/bookings/[id]/assignment`
 * endpoint is introduced. This call is sequenced strictly *after*
 * `getBookingById` has already succeeded — never in parallel with it (no
 * `Promise.all`), and never before it — because `findActiveAssignmentForBooking`
 * performs no actor-scoping of its own: calling it before or alongside the
 * Booking authorization check would risk a data or timing signal for an
 * inaccessible or nonexistent Booking that D-028 §2's existence-leak and
 * timing discipline forbids. Only `booking.id` (the already-authorized,
 * actor-scoped record's own id) is passed — never the raw route parameter.
 *
 * Neither `BookingStatusTransitionPanel` nor `BookingAssignmentPanel` is
 * ever rendered for the access-denied, malformed-id, or
 * not-found/forbidden branches above, since those all return before a
 * `booking` is ever resolved, and `findActiveAssignmentForBooking` is
 * never called for those cases either.
 */
export default async function AdminBookingDetailPage({ params }: { params: PageParams }) {
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

  const idResult = bookingIdParamSchema.safeParse(await params);
  if (!idResult.success) {
    return (
      <div>
        <Link href="/admin/bookings">← Back to Bookings</Link>
        <h1>Booking not found</h1>
        <p>This booking link is invalid.</p>
      </div>
    );
  }

  const bookingId = idResult.data.id;

  let booking;
  try {
    booking = await getBookingById(user, bookingId);
  } catch (error) {
    if (
      error instanceof BookingError &&
      (error.code === 'BOOKING_NOT_FOUND' || error.code === 'BOOKING_FORBIDDEN')
    ) {
      return (
        <div>
          <Link href="/admin/bookings">← Back to Bookings</Link>
          <h1>Booking not found</h1>
          <p>This booking was not found or is not accessible to you.</p>
        </div>
      );
    }
    throw error;
  }

  // Sequenced strictly after the successful, actor-scoped `booking` read
  // above — never in parallel with it (no Promise.all), and never before
  // it. See this function's docstring for why (D-028 §2/§8).
  const activeAssignment = await findActiveAssignmentForBooking(prisma, booking.id);
  const assignmentSummary: BookingAssignmentSummary = activeAssignment
    ? { staffId: activeAssignment.assignedStaffId }
    : null;

  const allowedTargetStatuses = Object.values(BookingStatus).filter((status) =>
    isTransitionAllowed(booking.status, status),
  );

  return (
    <div>
      <Link href="/admin/bookings">← Back to Bookings</Link>
      <h1>{booking.bookingReference}</h1>

      <dl className={styles.detailFields}>
        <div className={styles.detailField}>
          <dt>Status</dt>
          <dd>{BOOKING_STATUS_LABELS[booking.status]}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Client</dt>
          <dd>
            <Link href={`/admin/clients/${booking.clientId}`}>{booking.clientId}</Link>
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Proposal version</dt>
          <dd>{booking.proposalVersionId}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Tour package</dt>
          <dd>
            <TextValue value={booking.tourPackageName} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Destination</dt>
          <dd>
            <TextValue value={booking.destination} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Travel start</dt>
          <dd>
            <DateValue date={booking.travelStartDate} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Travel end</dt>
          <dd>
            <DateValue date={booking.travelEndDate} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Traveler count</dt>
          <dd>
            <NumberValue value={booking.travelerCount} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Included services</dt>
          <dd className={styles.multilineValue}>
            <TextValue value={booking.includedServices} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Excluded services</dt>
          <dd className={styles.multilineValue}>
            <TextValue value={booking.excludedServices} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Special requests</dt>
          <dd className={styles.multilineValue}>
            <TextValue value={booking.specialRequests} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Internal notes</dt>
          <dd className={styles.multilineValue}>
            <TextValue value={booking.internalNotes} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Client-visible notes</dt>
          <dd className={styles.multilineValue}>
            <TextValue value={booking.clientVisibleNotes} />
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Created</dt>
          <dd>
            <time dateTime={booking.createdAt.toISOString()}>
              {booking.createdAt.toLocaleString('en-PH')}
            </time>
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={booking.updatedAt.toISOString()}>
              {booking.updatedAt.toLocaleString('en-PH')}
            </time>
          </dd>
        </div>
      </dl>

      <BookingStatusTransitionPanel
        bookingId={bookingId}
        currentStatus={booking.status}
        allowedTargetStatuses={allowedTargetStatuses}
      />

      <BookingAssignmentPanel
        bookingId={bookingId}
        role={user.role}
        currentAssignment={assignmentSummary}
      />
    </div>
  );
}
