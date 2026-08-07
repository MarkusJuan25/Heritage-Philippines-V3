'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import type { AppRole } from '@/lib/auth/roles';

import styles from '../../bookings.module.css';

// D-028 §8's Booking assignment panel: for ADMIN_MANAGER, interactive
// assign/reassign controls calling the existing, unchanged
// `PUT /api/bookings/[id]/assignment` and features/assignments/service.ts
// directly — no second StaffAssignment write path is introduced, and no
// end/unassign workflow is authorized (D-028 §8/§F: assign/reassign only).
// For TRAVEL_CONSULTANT, the current assignment renders read-only, with no
// interactive control of any kind (D-028 §2 — a Travel Consultant may
// never assign, reassign, or end any Booking assignment) — mirroring
// ClientAssignmentPanel.tsx's/LeadAssignmentPanel.tsx's identical
// established convention.

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Local, minimal response shapes for this panel's own use — deliberately
// not imported from features/assignments/repository.ts or
// features/assignments/service.ts (both server-only). This client
// component talks to the existing assignment endpoints only through
// `fetch`, mirroring ClientAssignmentPanel.tsx's identical discipline.
type EligibleConsultant = { id: string; name: string; email: string };

function isEligibleConsultant(value: unknown): value is EligibleConsultant {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(candidate.id) &&
    isNonEmptyTrimmedString(candidate.name) &&
    isNonEmptyTrimmedString(candidate.email)
  );
}

type ListEligibleSuccess = {
  items: EligibleConsultant[];
  page: number;
  pageSize: number;
  total: number;
};

function isListEligibleSuccess(value: unknown): value is ListEligibleSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.items) &&
    candidate.items.every(isEligibleConsultant) &&
    typeof candidate.page === 'number' &&
    typeof candidate.pageSize === 'number' &&
    typeof candidate.total === 'number'
  );
}

const ELIGIBLE_PAGE_SIZE = 100;

// Only the fields this panel actually reads from an AssignmentRecord
// (features/assignments/repository.ts) — `assignedStaffId` to know who is
// now assigned, `bookingId` to confirm the returned row genuinely targets
// this Booking rather than a different Booking, a Lead, or a Client (the
// four-way XOR CHECK constraint on StaffAssignment means a real Booking
// assignment always carries a non-null `bookingId` and null
// `leadId`/`clientId`/`visaCaseId` — checking `bookingId` alone is
// therefore sufficient), and `endedAt` to distinguish an active row from
// one that was just ended. Every other AssignmentRecord field
// (id, assignedByUserId, leadId, clientId, createdAt, updatedAt) is never
// displayed by this panel and is intentionally not validated here.
type AssignmentRecordLike = {
  assignedStaffId: string;
  bookingId: string | null;
  endedAt: string | null;
};

function isAssignmentRecordLike(value: unknown): value is AssignmentRecordLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(candidate.assignedStaffId) &&
    (candidate.bookingId === null || isNonEmptyTrimmedString(candidate.bookingId)) &&
    (candidate.endedAt === null || isNonEmptyTrimmedString(candidate.endedAt))
  );
}

type SetAssignmentSuccess = { assignment: AssignmentRecordLike };

/**
 * A `PUT` success is trusted only when the returned row is structurally
 * valid, still active (`endedAt === null` — `setBookingAssignment` never
 * returns an already-ended row), and targets exactly this Booking
 * (`bookingId === expectedBookingId`) — never another Booking, a Lead, or
 * a Client that a malformed or miswired response might otherwise smuggle
 * in. Mirrors `ClientAssignmentPanel.tsx`'s `isSetAssignmentSuccess`
 * identical discipline.
 */
function isSetAssignmentSuccess(
  value: unknown,
  expectedBookingId: string,
): value is SetAssignmentSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const assignment = candidate.assignment;
  if (!isAssignmentRecordLike(assignment)) return false;
  return assignment.endedAt === null && assignment.bookingId === expectedBookingId;
}

type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

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

const GENERIC_ASSIGNMENT_ERROR_MESSAGE =
  'Something went wrong while updating this assignment. Please check your connection and try again.';
const GENERIC_ELIGIBLE_ERROR_MESSAGE =
  'Something went wrong while loading eligible Travel Consultants. Please check your connection and try again.';

/**
 * The authoritative current Booking assignment, as resolved server-side by
 * `findActiveAssignmentForBooking` (D-028 §8) — deliberately only
 * `staffId`, not a display name: `AssignmentRecord` (the sole shape this
 * checkpoint authorizes reading) has no `staffName` field, and no new
 * Booking/assignment read is authorized to resolve one. Unlike
 * `ClientAssignmentPanel.tsx`'s `ClientAssignmentSummary` (which benefits
 * from an already-existing, `features/clients/repository.ts`-owned nested
 * Prisma join predating D-028), this panel resolves a display name itself,
 * client-side, only where legitimately possible — see the render logic
 * below.
 */
export type BookingAssignmentSummary = { staffId: string } | null;

export type BookingAssignmentPanelProps = {
  bookingId: string;
  role: AppRole;
  currentAssignment: BookingAssignmentSummary;
};

/** A stable primitive key for a `BookingAssignmentSummary`, used only to
 * detect whether the `currentAssignment` prop has genuinely changed value
 * between renders — never persisted, displayed, or sent anywhere. */
function assignmentKey(assignment: BookingAssignmentSummary): string {
  return assignment ? assignment.staffId : '';
}

/**
 * Booking assignment management (D-028 §8). Submits directly to the
 * existing, unchanged `PUT /api/bookings/[id]/assignment` — no assignment
 * repository, service, schema, route, or audit behavior is introduced or
 * altered here. Every eligible-consultant read goes through the existing
 * `GET /api/assignments/travel-consultants` (ADMIN_MANAGER only, per that
 * route's own role gate — never fetched for a TRAVEL_CONSULTANT actor, who
 * has no use for it and no controls to populate with it). No
 * end/unassign action exists — D-028 §8 authorizes assign/reassign only,
 * unlike `ClientAssignmentPanel.tsx`'s additional end-assignment form.
 *
 * `role` narrows to exactly two branches: `'ADMIN_MANAGER'` renders the
 * full interactive panel; every other role (in practice only
 * `'TRAVEL_CONSULTANT'`, the only other role D-028 §2 authorizes to reach
 * this page at all) renders a read-only summary with no button, select, or
 * reason input of any kind.
 *
 * Display-name resolution: because `AssignmentRecord` carries only
 * `assignedStaffId`, the "Assigned Consultant" value shown is the matching
 * eligible consultant's `name` once the ADMIN_MANAGER-only eligible list
 * has loaded and contains a match; otherwise (still loading, no match, or
 * the read-only TRAVEL_CONSULTANT branch, which never fetches the eligible
 * list at all) the raw `assignedStaffId` is shown instead — never a
 * fabricated or blank value.
 *
 * A successful mutation's response becomes the new displayed assignment —
 * never assumed from the submitted `assignedStaffId`/selection alone.
 * `router.refresh()` afterward brings back the fully authoritative
 * assignment from the Booking detail read, and this panel's own
 * `displayedAssignment` re-syncs from the resulting fresh
 * `currentAssignment` prop the moment it genuinely differs from the last
 * one observed (the render-time guard below) — never from a stale prop
 * that hasn't changed yet, which would otherwise silently clobber a
 * just-confirmed optimistic update while `router.refresh()` is still in
 * flight.
 */
export function BookingAssignmentPanel({
  bookingId,
  role,
  currentAssignment,
}: BookingAssignmentPanelProps) {
  const router = useRouter();
  const isAdmin = role === 'ADMIN_MANAGER';

  const [displayedAssignment, setDisplayedAssignment] =
    useState<BookingAssignmentSummary>(currentAssignment);
  // Tracks the last `currentAssignment` prop value this panel has already
  // accounted for — updated only by the render-time guard below, never by
  // a mutation's own success handler, so a fresh optimistic update is
  // never immediately re-compared against (and overwritten by) the prop
  // it hasn't caught up to yet.
  const [lastPropAssignmentKey, setLastPropAssignmentKey] = useState(() =>
    assignmentKey(currentAssignment),
  );

  const [eligible, setEligible] = useState<EligibleConsultant[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(isAdmin);
  const [eligibleError, setEligibleError] = useState<string | null>(null);

  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Independently mutable, synchronous submission lock — `submitting`
  // (React state) alone cannot prevent a second submission dispatched in
  // the same batch as the first, before React has committed
  // `setSubmitting(true)`: two synchronous submit dispatches issued without
  // an intervening render both close over the *same* pre-update
  // `submitting` value. `submittingRef` is a plain mutable ref, so it is
  // read/written synchronously and is visible to the very next
  // invocation regardless of render timing. `submitting` still drives all
  // visible disabled/loading UI.
  const submittingRef = useRef(false);

  // Same Booking — the authoritative assignment prop itself changed
  // (typically `router.refresh()` finally resolving). Re-syncs the
  // displayed assignment only; never touches in-progress
  // selection/reason/error state, which describes an action the user may
  // still be composing.
  if (assignmentKey(currentAssignment) !== lastPropAssignmentKey) {
    setLastPropAssignmentKey(assignmentKey(currentAssignment));
    setDisplayedAssignment(currentAssignment);
  }

  // Fetches every eligible-consultant page exactly once, only for
  // ADMIN_MANAGER — never for the read-only Travel Consultant path, which
  // has no selector to populate. Requests page 1 at the schema's own
  // maximum `pageSize`, inspects the real `total`, and keeps requesting
  // subsequent pages until every item has been aggregated — never
  // silently stopping after the first page (D-028 §E/§G: "Do not silently
  // assume the first response contains every eligible consultant").
  // Mirrors ClientAssignmentPanel.tsx's identical established convention
  // exactly.
  useEffect(() => {
    if (!isAdmin) return;
    let ignore = false;

    async function loadAllEligible() {
      let page = 1;
      let total = Infinity;
      let aggregated: EligibleConsultant[] = [];

      try {
        while (!ignore && aggregated.length < total) {
          const response = await fetch(
            `/api/assignments/travel-consultants?page=${page}&pageSize=${ELIGIBLE_PAGE_SIZE}`,
          );

          let body: unknown;
          try {
            body = await response.json();
          } catch {
            if (!ignore) setEligibleError(GENERIC_ELIGIBLE_ERROR_MESSAGE);
            return;
          }
          if (!response.ok || !isListEligibleSuccess(body)) {
            if (!ignore) setEligibleError(GENERIC_ELIGIBLE_ERROR_MESSAGE);
            return;
          }

          aggregated = aggregated.concat(body.items);
          total = body.total;
          // Defensive: an empty page while still short of `total` would
          // otherwise loop forever on an inconsistent server response.
          if (body.items.length === 0) break;
          page += 1;
        }
      } catch {
        if (!ignore) setEligibleError(GENERIC_ELIGIBLE_ERROR_MESSAGE);
        return;
      } finally {
        if (!ignore) setEligibleLoading(false);
      }

      // Committed once, only after every page succeeded — never a
      // partial list from pages fetched before a later one failed.
      if (!ignore) setEligible(aggregated);
    }

    loadAllEligible();

    return () => {
      ignore = true;
    };
  }, [isAdmin]);

  const selectId = useId();
  const reasonId = useId();

  const isReplacing = displayedAssignment !== null;
  const isNoOpSelection =
    isReplacing && selectedStaffId !== '' && selectedStaffId === displayedAssignment.staffId;

  function resolveDisplayName(assignment: { staffId: string }): string {
    const match = eligible.find((consultant) => consultant.id === assignment.staffId);
    return match ? match.name : assignment.staffId;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedStaffId) {
      setFormError('Select a Travel Consultant to assign.');
      return;
    }
    if (isNoOpSelection) {
      // Defensive — the submit button is already disabled in this case
      // (D-028 §F.5: reassigning to the already-assigned consultant is
      // never treated as a meaningful mutation).
      return;
    }

    const trimmedReason = reason.trim();
    if (isReplacing && trimmedReason.length === 0) {
      setReasonError('A reason is required when replacing an existing assignment.');
      return;
    }

    // Checked and acquired synchronously, before any asynchronous
    // boundary — see `submittingRef`'s declaration above for why this
    // cannot be `submitting` (React state) alone.
    if (submittingRef.current) return;
    submittingRef.current = true;

    setReasonError(null);
    setFormError(null);
    setSuccess(false);
    setSubmitting(true);

    try {
      const response = await fetch(`/api/bookings/${bookingId}/assignment`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedStaffId: selectedStaffId,
          // Gated on `isReplacing`, not merely on non-empty `reason` — a
          // first assignment must never include a `reason` key, even
          // defensively, regardless of what `reason` state holds.
          ...(isReplacing && trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isSetAssignmentSuccess(body, bookingId)) {
          setFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
          return;
        }
        // Never assume success or invent the assignee from the submitted
        // selection alone — only the confirmed, bookingId-checked
        // `assignedStaffId` in the response decides who is now shown as
        // assigned.
        setDisplayedAssignment({ staffId: body.assignment.assignedStaffId });
        setSelectedStaffId('');
        setReason('');
        setSuccess(true);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      if (error.code === 'REASON_REQUIRED') {
        setReasonError(error.message);
        return;
      }
      const reasonDetail = error.details?.find((detail) => detail.path === 'reason');
      if (error.code === 'VALIDATION_ERROR' && reasonDetail) {
        setReasonError(reasonDetail.message);
        return;
      }
      // Covers ASSIGNEE_NOT_FOUND, ASSIGNEE_INACTIVE,
      // ASSIGNEE_INELIGIBLE_ROLE, ASSIGNMENT_CONFLICT, BOOKING_NOT_FOUND,
      // and any other controlled failure — each already carries a safe,
      // server-crafted message. A failed request never replaces
      // `displayedAssignment` — it is only ever updated inside the
      // validated-success branch above.
      setFormError(error.message);
    } catch {
      setFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
    } finally {
      // Every path through the try block above (validated success,
      // malformed success, controlled API failure, malformed/generic error
      // body, and the outer network-failure catch) reaches this finally —
      // both the imperative lock and the visible submitting state are
      // always released together, regardless of outcome.
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!isAdmin) {
    return (
      <div className={styles.assignmentPanel}>
        <h2>Assignment</h2>
        <p>
          Assigned Consultant:{' '}
          <strong>
            {displayedAssignment ? resolveDisplayName(displayedAssignment) : 'Unassigned'}
          </strong>
        </p>
      </div>
    );
  }

  return (
    <div className={styles.assignmentPanel}>
      <h2>Assignment</h2>
      <p>
        Assigned Consultant:{' '}
        <strong>
          {displayedAssignment ? resolveDisplayName(displayedAssignment) : 'Unassigned'}
        </strong>
      </p>

      {success ? (
        <p role="status" className={styles.formSuccessAlert}>
          Assignment updated.
        </p>
      ) : null}

      {eligibleLoading ? (
        <p role="status">Loading eligible Travel Consultants…</p>
      ) : eligibleError ? (
        <p role="alert" className={styles.formAlert}>
          {eligibleError}
        </p>
      ) : eligible.length === 0 ? (
        <p>No eligible Travel Consultants are currently available.</p>
      ) : (
        <form onSubmit={handleSubmit} className={styles.statusForm} noValidate>
          {formError ? (
            <p role="alert" className={styles.formAlert}>
              {formError}
            </p>
          ) : null}

          <div className={styles.formField}>
            <label htmlFor={selectId}>Assign to</label>
            <select
              id={selectId}
              value={selectedStaffId}
              onChange={(event) => {
                setSelectedStaffId(event.target.value);
                setReason('');
                setReasonError(null);
                setFormError(null);
                setSuccess(false);
              }}
              disabled={submitting}
            >
              <option value="">Select a Travel Consultant…</option>
              {eligible.map((consultant) => (
                <option key={consultant.id} value={consultant.id}>
                  {consultant.name}
                </option>
              ))}
            </select>
          </div>

          {isReplacing ? (
            <div className={styles.formField}>
              <label htmlFor={reasonId}>Reason for reassignment</label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setReasonError(null);
                  setFormError(null);
                  setSuccess(false);
                }}
                maxLength={500}
                rows={3}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby={reasonError ? `${reasonId}-error` : undefined}
                disabled={submitting}
                required
              />
              {reasonError ? (
                <p id={`${reasonId}-error`} className={styles.fieldError}>
                  {reasonError}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className={styles.formActions}>
            <button type="submit" disabled={submitting || !selectedStaffId || isNoOpSelection}>
              {submitting ? 'Saving…' : isReplacing ? 'Reassign' : 'Assign'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
