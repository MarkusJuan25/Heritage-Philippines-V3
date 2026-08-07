'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../proposals.module.css';

// D-028 §6's sole Booking-creation entry point: rendered by
// ProposalVersionHistory.tsx only for a ProposalVersion that already
// carries an externally recorded ACCEPT response — this component itself
// accepts no role, user object, or eligibility flag, trusting only the
// `proposalVersionId` identity its parent already resolved from the
// actor-scoped Proposal detail read. No Proposal picker, Client picker, or
// standalone creation route exists anywhere in this component.

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Local, minimal response shapes for this component's own use —
// deliberately not imported from features/bookings/repository.ts or
// features/bookings/service.ts (both server-only). This client component
// talks to `POST /api/bookings` only through `fetch`, mirroring
// PublishProposalVersionButton.tsx's/CreateProposalPanel.tsx's identical
// discipline.
type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while creating this booking. Please check your connection and try again.';

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

type CreateBookingSuccess = { booking: { id: string; proposalVersionId: string } };

/**
 * Strict response validation for both documented success statuses (`201`
 * newly created, `200` idempotent replay — D-028 §6; `POST /api/bookings`
 * never returns any other 2xx for this request): `booking.id` must be a
 * nonblank string, and `booking.proposalVersionId` — always present on the
 * real `BookingRecord` response, never merely optional — must exactly
 * match the Proposal Version this button was rendered for. Mirrors
 * `PublishProposalVersionButton.tsx`'s identical strict "never trust a
 * conflicting identifier" discipline (not
 * `CreateProposalRevisionPanel.tsx`'s optional-field variant, since that
 * response shape's identity field is genuinely optional while this one is
 * not).
 */
function isCreateBookingSuccess(
  value: unknown,
  expectedProposalVersionId: string,
): value is CreateBookingSuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const booking = candidate.booking;
  if (!booking || typeof booking !== 'object' || Array.isArray(booking)) return false;
  const bookingCandidate = booking as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(bookingCandidate.id) &&
    isNonEmptyTrimmedString(bookingCandidate.proposalVersionId) &&
    bookingCandidate.proposalVersionId === expectedProposalVersionId
  );
}

export type CreateBookingButtonProps = {
  proposalVersionId: string;
};

/**
 * Booking-creation action for a single accepted `ProposalVersion` (D-028
 * §6). Submits directly to the existing, unmodified `POST /api/bookings` —
 * exactly `{ proposalVersionId }`, matching `createBookingSchema`'s
 * `.strict()` single-key contract exactly; no other field is ever sent.
 *
 * Both documented success statuses are treated as success: `201` (a newly
 * created Booking) and `200` (an idempotent replay for a Proposal Version
 * that already has one — `features/bookings/service.ts`'s `createBooking`).
 * Any other status — including an unrecognized 2xx — is never treated as
 * success. A response is trusted only after `isCreateBookingSuccess` above
 * confirms it is well-formed and genuinely describes this exact Proposal
 * Version; a malformed, identity-mismatched, or unexpected-status response
 * never navigates and never claims success.
 *
 * On a validated success, in this exact order: (1) the permanent
 * `permanentlySucceededRef` latch is set, (2) the visible `succeeded` state
 * is set, (3) `router.push('/admin/bookings/{returnedBookingId}')` is
 * called, (4) `router.refresh()` is called — mirroring
 * `CreateProposalPanel.tsx`'s identical established navigate-then-refresh
 * convention. Both the newly-created and the idempotent-replay path
 * navigate to the authoritative returned Booking id, never a fabricated
 * one.
 *
 * Duplicate-submission protection uses two independently mutable refs, not
 * React state alone (mirroring `BookingAssignmentPanel.tsx`'s corrected
 * `submittingRef` discipline, D-028 Stage 2D Correction Pass 1):
 * `submittingRef` is a temporary, synchronous in-flight lock — checked and
 * acquired before the first `await`, released in a failure-safe `finally`
 * alongside the visible `submitting` state, so a legitimate retry remains
 * possible after any failure. `permanentlySucceededRef` is a one-shot
 * latch that, once set on a validated success, is never released for the
 * remaining lifetime of this mounted component (it unmounts as part of the
 * navigation the success itself triggers) — Booking creation, unlike a
 * repeatable status transition or reassignment, is a one-shot action, so a
 * stray resubmission during the brief window before navigation actually
 * unmounts the component can never issue a second, redundant
 * `POST /api/bookings`. Both refs are checked at the very top of
 * `handleSubmit`, before any `fetch` call.
 *
 * Every controlled `BookingError` code relevant to creation
 * (`PROPOSAL_VERSION_NOT_ACCEPTED`, `PROPOSAL_VERSION_FORBIDDEN`,
 * `PROPOSAL_VERSION_NOT_FOUND`, `ROLE_NOT_PERMITTED`, an
 * unauthenticated/session-expired response, or a generic 500) already
 * carries a safe, server-crafted message — rendered verbatim as the
 * form-level alert, mirroring `PublishProposalVersionButton.tsx`'s/
 * `CreateProposalPanel.tsx`'s identical catch-all fallback. A malformed
 * error body, a malformed success body, and a network rejection all fall
 * back to the identical generic message. Nothing is ever logged: no raw
 * response body or exception is ever passed to `console.*` anywhere in
 * this component.
 */
export function CreateBookingButton({ proposalVersionId }: CreateBookingButtonProps) {
  const router = useRouter();

  const [submitting, setSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submittingRef = useRef(false);
  const permanentlySucceededRef = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submittingRef.current) return;
    if (permanentlySucceededRef.current) return;
    submittingRef.current = true;

    setFormError(null);
    setSubmitting(true);

    try {
      const response = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalVersionId }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.status === 201 || response.status === 200) {
        if (!isCreateBookingSuccess(body, proposalVersionId)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        permanentlySucceededRef.current = true;
        setSucceeded(true);
        router.push(`/admin/bookings/${body.booking.id}`);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      setFormError(body.error.message);
    } catch {
      setFormError(GENERIC_ERROR_MESSAGE);
    } finally {
      // Every path through the try block above (validated success,
      // malformed success, controlled/malformed error body, and the outer
      // network-failure catch) reaches this finally, since it wraps the
      // whole try — the temporary lock and visible submitting state always
      // release together; `permanentlySucceededRef` is never touched here.
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.createBookingAction} noValidate>
      {formError ? (
        <p role="alert" className={styles.formAlert}>
          {formError}
        </p>
      ) : null}
      {succeeded ? (
        <p role="status" className={styles.formSuccessAlert}>
          Booking created. Redirecting…
        </p>
      ) : null}
      <div className={styles.formActions}>
        <button type="submit" disabled={submitting || succeeded}>
          {submitting ? 'Creating Booking…' : 'Create Booking'}
        </button>
      </div>
    </form>
  );
}
