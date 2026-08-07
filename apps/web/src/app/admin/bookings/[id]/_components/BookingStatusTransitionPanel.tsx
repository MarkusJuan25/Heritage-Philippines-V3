'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import type { BookingStatus } from '@/generated/prisma/client';

import styles from '../../bookings.module.css';

// D-028 §7's status-transition control: rendered by admin/bookings/[id]/
// page.tsx for both ADMIN_MANAGER and TRAVEL_CONSULTANT — this component
// itself accepts no role or user object, trusting only the already
// server-filtered `allowedTargetStatuses` prop its parent computed via the
// existing, unmodified `isTransitionAllowed`.

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Local, minimal response shapes for this component's own use —
// deliberately not imported from features/bookings/repository.ts or
// features/bookings/service.ts (both server-only). This client component
// talks to `PUT /api/bookings/[id]/status` only through `fetch`, mirroring
// PublishProposalVersionButton.tsx's/CreateProposalRevisionPanel.tsx's
// identical discipline.
type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while updating this booking status. Please check your connection and try again.';

function isApiErrorDetail(value: unknown): value is ApiErrorDetail {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === 'string' && isNonEmptyTrimmedString(candidate.message);
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const error = candidate.error as Record<string, unknown> | undefined;
  if (!error) return false;
  if (!isNonEmptyTrimmedString(error.code) || !isNonEmptyTrimmedString(error.message)) return false;
  if (error.details === undefined) return true;
  return Array.isArray(error.details) && error.details.every(isApiErrorDetail);
}

type StatusUpdateSuccess = { booking: { id: string; status: BookingStatus } };

/**
 * Strict `200` response validation, mirroring
 * `PublishProposalVersionButton.tsx`'s `isPublishSuccess`'s identical
 * "never trust a conflicting identifier" discipline, extended here to the
 * resulting status too: `booking.id` must match this panel's own
 * `bookingId` prop, and `booking.status` must equal the exact `newStatus`
 * just submitted — a response describing a different Booking, or one whose
 * resulting status doesn't match what was requested, is never treated as
 * success.
 */
function isStatusUpdateSuccess(
  value: unknown,
  expectedBookingId: string,
  expectedNewStatus: BookingStatus,
): value is StatusUpdateSuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const booking = candidate.booking;
  if (!booking || typeof booking !== 'object' || Array.isArray(booking)) return false;
  const bookingCandidate = booking as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(bookingCandidate.id) &&
    bookingCandidate.id === expectedBookingId &&
    bookingCandidate.status === expectedNewStatus
  );
}

// Duplicated from admin/bookings/_components/BookingTable.tsx /
// admin/bookings/[id]/page.tsx rather than imported/shared — mirrors this
// codebase's established per-feature-copy convention (each component keeps
// its own copy of a generically-named constant rather than sharing one
// cross-file module). Never inventing a status the schema doesn't define
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

export type BookingStatusTransitionPanelProps = {
  bookingId: string;
  currentStatus: BookingStatus;
  /**
   * Already server-filtered by the parent page via `isTransitionAllowed`
   * (D-028 §7) — this component never independently computes, widens, or
   * invents a transition beyond exactly this set. `CANCELLED` is presented
   * as an ordinary member of this set whenever the parent includes it,
   * never as a separate control.
   */
  allowedTargetStatuses: BookingStatus[];
};

/**
 * Status-transition control for a single Booking (D-028 §7). Submits
 * directly to the existing `PUT /api/bookings/{bookingId}/status` — exactly
 * `{ expectedStatus, newStatus }`, where `expectedStatus` is always this
 * panel's own `currentStatus` prop (the server-rendered status this panel
 * was most recently given), reusing `updateBookingStatusSchema` unmodified.
 * A synchronous `submitting` guard at the very first line of the submit
 * handler, together with the disabled pending control, protects this
 * non-idempotent optimistic-concurrency endpoint from a duplicate in-flight
 * request.
 *
 * Unlike `CreateBookingButton`'s one-shot permanent latch, a status
 * transition is a repeatable, in-place operation — so the post-success
 * duplicate guard here is not a boolean that, once set, never clears. It is
 * `lastTransition: { from, to } | null`, and the panel is disabled whenever
 * `lastTransition !== null && lastTransition.from === currentStatus` — i.e.
 * only while the page still server-renders the same, now-stale status this
 * panel just transitioned away from. The moment `router.refresh()` causes
 * the Server Component to reload and hand this panel a *different*
 * `currentStatus` (reflecting the transition that just succeeded, and a
 * freshly recomputed `allowedTargetStatuses`), that comparison stops
 * matching and the panel re-enables itself for the Booking's next valid
 * transition — it never permanently blocks further transitions.
 *
 * A synchronous, independently mutable `submittingRef` (not `submitting`
 * React state alone) guards against a second submission dispatched in the
 * same batch as the first, before React has committed `setSubmitting(true)`
 * — mirroring `BookingAssignmentPanel.tsx`'s/`CreateBookingButton.tsx`'s
 * identical `submittingRef` discipline (D-028 Stage 2D Correction Pass 1).
 * It is checked and acquired before the first `await`, and released in a
 * failure-safe `finally` alongside the visible `submitting` state, so a
 * legitimate retry remains possible after any failure — `submitting` still
 * drives only the visible disabled/loading UI.
 *
 * `BOOKING_CONFLICT` (D-028 §7's own exact required refresh-and-retry
 * wording) is shown like any other controlled error message, but
 * additionally exposes a distinct, accessible "Refresh booking" action that
 * calls only `router.refresh()` — a deliberate, user-triggered re-fetch of
 * the authoritative state, never an automatic retry and never another
 * status-update request by itself. Every other controlled error
 * (`BOOKING_FORBIDDEN`, `BOOKING_NOT_FOUND`, `INVALID_STATUS_TRANSITION`, a
 * role-forbidden/unauthenticated response, or a generic 500) already
 * carries a safe, server-crafted message, rendered verbatim; a malformed
 * JSON body, an incomplete/mismatched success body, or a network rejection
 * all fall back to the identical generic message. Nothing is ever logged:
 * no raw response body or exception is ever passed to `console.*` anywhere
 * in this component.
 *
 * When `allowedTargetStatuses` is empty (a terminal Booking, e.g.
 * `COMPLETED`/`CANCELLED`), this panel renders an accessible read-only
 * message and no mutation control of any kind — never a disabled form.
 */
export function BookingStatusTransitionPanel({
  bookingId,
  currentStatus,
  allowedTargetStatuses,
}: BookingStatusTransitionPanelProps) {
  const router = useRouter();

  const [selectedStatus, setSelectedStatus] = useState<BookingStatus | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [lastTransition, setLastTransition] = useState<{
    from: BookingStatus;
    to: BookingStatus;
  } | null>(null);
  const submittingRef = useRef(false);

  const selectId = useId();

  const staleGuardActive = lastTransition !== null && lastTransition.from === currentStatus;
  const disabled = submitting || staleGuardActive;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (staleGuardActive) return;
    if (!selectedStatus) return;

    // Checked and acquired synchronously, before any asynchronous
    // boundary — see this component's doc comment above for why
    // `submitting` (React state) alone is not sufficient here.
    if (submittingRef.current) return;
    submittingRef.current = true;

    const newStatus = selectedStatus;

    setFormError(null);
    setConflict(false);
    setSubmitting(true);

    try {
      const response = await fetch(`/api/bookings/${bookingId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedStatus: currentStatus, newStatus }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isStatusUpdateSuccess(body, bookingId, newStatus)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        setLastTransition({ from: currentStatus, to: newStatus });
        setSelectedStatus('');
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      if (error.code === 'BOOKING_CONFLICT') {
        setConflict(true);
      }
      setFormError(error.message);
    } catch {
      setFormError(GENERIC_ERROR_MESSAGE);
    } finally {
      // Every path through the try block above (validated success,
      // malformed success, controlled/malformed error body, and the outer
      // network-failure catch) reaches this finally, since it wraps the
      // whole try — the temporary lock and visible submitting state
      // always release together, permitting a legitimate retry.
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (allowedTargetStatuses.length === 0) {
    return (
      <div className={styles.statusPanel}>
        <h2>Status</h2>
        <p>No status changes are currently available for this booking.</p>
      </div>
    );
  }

  return (
    <div className={styles.statusPanel}>
      <h2>Status</h2>

      <form onSubmit={handleSubmit} className={styles.statusForm} noValidate>
        {formError ? (
          <p role="alert" className={styles.formAlert}>
            {formError}
            {conflict ? (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => {
                    // A deliberate, user-triggered re-fetch only — this
                    // never resubmits the status update on its own (D-028
                    // §7).
                    router.refresh();
                  }}
                >
                  Refresh booking
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {staleGuardActive && lastTransition ? (
          <p role="status" className={styles.formSuccessAlert}>
            Status updated to {BOOKING_STATUS_LABELS[lastTransition.to]}.
          </p>
        ) : null}

        <div className={styles.formField}>
          <label htmlFor={selectId}>New status</label>
          <select
            id={selectId}
            value={selectedStatus}
            onChange={(event) => setSelectedStatus(event.target.value as BookingStatus)}
            disabled={disabled}
          >
            <option value="">Select a status…</option>
            {allowedTargetStatuses.map((status) => (
              <option key={status} value={status}>
                {BOOKING_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.formActions}>
          <button type="submit" disabled={disabled || !selectedStatus}>
            {submitting ? 'Updating status…' : 'Update status'}
          </button>
        </div>
      </form>
    </div>
  );
}
