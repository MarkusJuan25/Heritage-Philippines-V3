'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import type { AppRole } from '@/lib/auth/roles';

import styles from '../../leads.module.css';

// D-026 §10's Lead assignment panel: for ADMIN_MANAGER, interactive
// assign/reassign/end-assignment controls calling the existing, unchanged
// `PUT`/`DELETE /api/leads/[id]/assignment` routes and
// features/assignments/service.ts functions directly — no second
// StaffAssignment write path is introduced. For TRAVEL_CONSULTANT, the
// current assignment renders read-only, with no interactive control of any
// kind (D-026 §2 — a Travel Consultant may never assign, reassign, or end
// any Lead assignment). D-026 §3 (binding): this component never reads or
// checks `Lead.status` — its controls remain available for every Lead the
// actor can access, including a `CONVERTED_TO_CLIENT` Lead. Do not add a
// status-based lock here without a separate, approved decision that also
// updates the backend (see D-026 §3's explicit prohibition on a UI-only
// lock).

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Local, minimal response shapes for this panel's own use — deliberately
// not imported from features/assignments/repository.ts or
// features/assignments/service.ts (both server-only). This client
// component talks to the existing assignment endpoints only through
// `fetch`, never a server-only service, repository, HTTP helper, or the
// generated Prisma runtime — mirrors EditLeadForm.tsx's/
// StatusTransitionPanel.tsx's identical discipline.
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
// now assigned, `leadId` to confirm the returned row genuinely targets
// this Lead rather than a different Lead, a Client, or a Booking (the
// three-way XOR CHECK constraint on StaffAssignment means a real Lead
// assignment always carries a non-null `leadId` and null `clientId`/
// `bookingId` — checking `leadId` alone is therefore sufficient to prove
// the row is not a Client/Booking assignment as well), and `endedAt` to
// distinguish an active row from one that was just ended. Every other
// AssignmentRecord field (assignedByUserId, clientId, bookingId, createdAt,
// updatedAt) is never displayed by this panel and is intentionally not
// validated here.
type AssignmentRecordLike = {
  id: string;
  assignedStaffId: string;
  leadId: string | null;
  endedAt: string | null;
};

function isAssignmentRecordLike(value: unknown): value is AssignmentRecordLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(candidate.id) &&
    isNonEmptyTrimmedString(candidate.assignedStaffId) &&
    (candidate.leadId === null || isNonEmptyTrimmedString(candidate.leadId)) &&
    (candidate.endedAt === null || isNonEmptyTrimmedString(candidate.endedAt))
  );
}

type SetAssignmentSuccess = { assignment: AssignmentRecordLike };

/**
 * A `PUT` success is trusted only when the returned row is structurally
 * valid, still active (`endedAt === null` — `setLeadAssignment` never
 * returns an already-ended row), and targets exactly this Lead
 * (`leadId === expectedLeadId`) — never another Lead, a Client, or a
 * Booking that a malformed or miswired response might otherwise smuggle in.
 */
function isSetAssignmentSuccess(
  value: unknown,
  expectedLeadId: string,
): value is SetAssignmentSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const assignment = candidate.assignment;
  if (!isAssignmentRecordLike(assignment)) return false;
  return assignment.endedAt === null && assignment.leadId === expectedLeadId;
}

type EndAssignmentSuccess = { assignment: AssignmentRecordLike | null };

/**
 * `endLeadAssignment` returns `null` only when there was no active
 * assignment to begin with (an idempotent no-op) — otherwise it returns
 * the just-ended record itself, which must have a non-null `endedAt` and
 * still target exactly this Lead. A structurally valid record with
 * `endedAt === null` (claiming to still be active) is exactly as invalid
 * here as one targeting a different Lead.
 */
function isEndAssignmentSuccess(
  value: unknown,
  expectedLeadId: string,
): value is EndAssignmentSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const assignment = candidate.assignment;
  if (assignment === null) return true;
  if (!isAssignmentRecordLike(assignment)) return false;
  return assignment.endedAt !== null && assignment.leadId === expectedLeadId;
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

export type LeadAssignmentSummary = { staffId: string; staffName: string } | null;

export type LeadAssignmentPanelProps = {
  leadId: string;
  role: AppRole;
  currentAssignment: LeadAssignmentSummary;
};

/** A stable primitive key for a `LeadAssignmentSummary`, used only to
 * detect whether the `currentAssignment` prop has genuinely changed value
 * between renders — never persisted, displayed, or sent anywhere. */
function assignmentKey(assignment: LeadAssignmentSummary): string {
  return assignment ? `${assignment.staffId}:${assignment.staffName}` : '';
}

type PendingAction = 'assign' | 'end' | null;

/**
 * Lead assignment management (D-026 §2/§10). Submits directly to the
 * existing, unchanged `PUT`/`DELETE /api/leads/[id]/assignment` — no
 * assignment repository, service, schema, route, or audit behavior is
 * introduced or altered here. Every eligible-consultant read goes through
 * the existing `GET /api/assignments/travel-consultants` (ADMIN_MANAGER
 * only, per that route's own role gate — never fetched for a
 * TRAVEL_CONSULTANT actor, who has no use for it and no controls to
 * populate with it).
 *
 * `role` narrows to exactly two branches: `'ADMIN_MANAGER'` renders the
 * full interactive panel; every other role (in practice only
 * `'TRAVEL_CONSULTANT'`, the only other role reaching this page at all)
 * renders a read-only summary with no button, select, or reason input of
 * any kind — never merely a disabled copy of the Admin controls.
 *
 * `LeadAssignmentPanelProps` carries no Lead-status field of any kind —
 * this panel cannot read or react to `Lead.status`, including
 * `CONVERTED_TO_CLIENT` (D-026 §3, a deliberate, binding scope decision,
 * not an oversight).
 *
 * A successful mutation's response becomes the new displayed assignment —
 * never assumed from the submitted `assignedStaffId`/selection alone. The
 * server response for a `PUT`/`DELETE` carries only `assignedStaffId` (not
 * a display name — `AssignmentRecord` has no `staffName` field), so the
 * confirmed name shown immediately is resolved from the already-loaded
 * eligible list; `router.refresh()` afterward brings back the fully
 * authoritative `staffName` from the Lead detail read, and this panel's
 * own `displayedAssignment` re-syncs from the resulting fresh
 * `currentAssignment` prop the moment it genuinely differs from the last
 * one observed (the render-time guard below) — never from a stale prop
 * that hasn't changed yet, which would otherwise silently clobber a
 * just-confirmed optimistic update while `router.refresh()` is still in
 * flight. A `leadId` change (navigating to a different Lead without this
 * component remounting) fully resets every piece of transient state —
 * selection, reasons, errors, success messages, and any pending action —
 * so nothing from a previous Lead's in-progress form ever leaks into the
 * next one. `pendingAction` (not a shared boolean) tracks which one of the
 * two independent actions — assign/reassign, or end — is in flight, so the
 * inactive action's own button never borrows the active one's progress
 * label, and a successful action clears the *other* action's now-obsolete
 * success/error/reason/selection state, never just its own.
 */
export function LeadAssignmentPanel({ leadId, role, currentAssignment }: LeadAssignmentPanelProps) {
  const router = useRouter();
  const isAdmin = role === 'ADMIN_MANAGER';

  const [displayedAssignment, setDisplayedAssignment] =
    useState<LeadAssignmentSummary>(currentAssignment);
  // Tracks the last `currentAssignment` prop value this panel has already
  // accounted for — updated only by the render-time guards below, never by
  // a mutation's own success handler, so a fresh optimistic update is never
  // immediately re-compared against (and overwritten by) the prop it hasn't
  // caught up to yet.
  const [lastPropAssignmentKey, setLastPropAssignmentKey] = useState(() =>
    assignmentKey(currentAssignment),
  );
  const [priorLeadId, setPriorLeadId] = useState(leadId);

  const [eligible, setEligible] = useState<EligibleConsultant[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(isAdmin);
  const [eligibleError, setEligibleError] = useState<string | null>(null);

  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [assignReasonError, setAssignReasonError] = useState<string | null>(null);
  const [assignFormError, setAssignFormError] = useState<string | null>(null);
  const [assignSuccess, setAssignSuccess] = useState(false);

  const [endReason, setEndReason] = useState('');
  const [endReasonError, setEndReasonError] = useState<string | null>(null);
  const [endFormError, setEndFormError] = useState<string | null>(null);
  const [endSuccess, setEndSuccess] = useState(false);

  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  // Navigated to a different Lead without this component remounting —
  // every piece of transient state describes the PREVIOUS Lead and must
  // not leak into this one. Checked first, and takes priority over the
  // ordinary prop-resync guard below (which would otherwise also fire on
  // the same render, redundantly, since `currentAssignment` almost always
  // differs between two different Leads too).
  if (leadId !== priorLeadId) {
    setPriorLeadId(leadId);
    setLastPropAssignmentKey(assignmentKey(currentAssignment));
    setDisplayedAssignment(currentAssignment);
    setSelectedStaffId('');
    setAssignReason('');
    setAssignReasonError(null);
    setAssignFormError(null);
    setAssignSuccess(false);
    setEndReason('');
    setEndReasonError(null);
    setEndFormError(null);
    setEndSuccess(false);
    setPendingAction(null);
  } else if (assignmentKey(currentAssignment) !== lastPropAssignmentKey) {
    // Same Lead — the authoritative assignment prop itself changed
    // (typically `router.refresh()` finally resolving). Re-syncs the
    // displayed assignment only; never touches in-progress
    // selection/reason/error state, which describes an action the user may
    // still be composing.
    setLastPropAssignmentKey(assignmentKey(currentAssignment));
    setDisplayedAssignment(currentAssignment);
  }

  // Fetches every eligible-consultant page exactly once, only for
  // ADMIN_MANAGER — never for the read-only Travel Consultant path, which
  // has no selector to populate. Requests page 1 at the schema's own
  // maximum `pageSize` (features/assignments/schemas.ts's
  // listEligibleTravelConsultantsQuerySchema), inspects the real `total`,
  // and keeps requesting subsequent pages until every item has been
  // aggregated — never silently stopping after the first page. Every page
  // response is validated identically; a malformed or failed later page
  // discards whatever was aggregated so far and shows the same controlled
  // error a first-page failure would, rather than committing a silently
  // incomplete list. `ignore` guards every request in the sequence, not
  // just the first, so an unmounted panel (or a `leadId` change, which
  // does not itself cancel this Lead-independent roster fetch) never
  // applies a late page's result. No further pagination UI exists — this
  // panel offers a plain `<select>` of every eligible consultant, fully
  // aggregated client-side, not a paginated picker.
  useEffect(() => {
    if (role !== 'ADMIN_MANAGER') return;
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

      // Committed once, only after every page succeeded — never a partial
      // list from pages fetched before a later one failed.
      if (!ignore) setEligible(aggregated);
    }

    loadAllEligible();

    return () => {
      ignore = true;
    };
  }, [role]);

  const selectId = useId();
  const assignReasonId = useId();
  const endReasonId = useId();

  const isReplacing = displayedAssignment !== null;
  const isNoOpSelection =
    isReplacing && selectedStaffId !== '' && selectedStaffId === displayedAssignment.staffId;
  const isPending = pendingAction !== null;

  async function handleAssignSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;

    if (!selectedStaffId) {
      setAssignFormError('Select a Travel Consultant to assign.');
      return;
    }
    if (isNoOpSelection) {
      // Defensive — the submit button is already disabled in this case
      // (D-026 §5: reassigning to the already-assigned consultant is never
      // treated as a meaningful mutation).
      return;
    }

    const trimmedReason = assignReason.trim();
    if (isReplacing && trimmedReason.length === 0) {
      setAssignReasonError('A reason is required when replacing an existing assignment.');
      return;
    }

    setAssignReasonError(null);
    setAssignFormError(null);
    setAssignSuccess(false);
    setPendingAction('assign');

    try {
      const response = await fetch(`/api/leads/${leadId}/assignment`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedStaffId: selectedStaffId,
          // Gated on `isReplacing`, not merely on non-empty `assignReason`
          // — a first assignment must never include a `reason` key, even
          // defensively, regardless of what `assignReason` state holds.
          ...(isReplacing && trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setAssignFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isSetAssignmentSuccess(body, leadId)) {
          setAssignFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
          return;
        }
        // Never assume success or invent the assignee from the submitted
        // selection alone — only the confirmed, leadId-checked
        // `assignedStaffId` in the response decides who is now shown as
        // assigned.
        const assignedName =
          eligible.find((consultant) => consultant.id === body.assignment.assignedStaffId)?.name ??
          'Assigned consultant';
        setDisplayedAssignment({
          staffId: body.assignment.assignedStaffId,
          staffName: assignedName,
        });
        setSelectedStaffId('');
        setAssignReason('');
        setAssignSuccess(true);
        // A successful reassign/assign makes the opposite (end-assignment)
        // form's own success/error state obsolete — it described the prior
        // assignment, which this action just superseded.
        setEndReason('');
        setEndReasonError(null);
        setEndFormError(null);
        setEndSuccess(false);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setAssignFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      if (error.code === 'REASON_REQUIRED') {
        setAssignReasonError(error.message);
        return;
      }
      const reasonDetail = error.details?.find((detail) => detail.path === 'reason');
      if (error.code === 'VALIDATION_ERROR' && reasonDetail) {
        setAssignReasonError(reasonDetail.message);
        return;
      }
      // Covers ASSIGNEE_NOT_FOUND, ASSIGNEE_INACTIVE, ASSIGNEE_INELIGIBLE_
      // ROLE, ASSIGNMENT_CONFLICT, LEAD_NOT_FOUND, and any other controlled
      // failure — each already carries a safe, server-crafted message.
      setAssignFormError(error.message);
    } catch {
      setAssignFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
    } finally {
      setPendingAction(null);
    }
  }

  async function handleEndSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) return;

    const trimmedReason = endReason.trim();
    if (trimmedReason.length === 0) {
      setEndReasonError('A reason is required when ending an assignment.');
      return;
    }

    setEndReasonError(null);
    setEndFormError(null);
    setEndSuccess(false);
    setPendingAction('end');

    try {
      const response = await fetch(`/api/leads/${leadId}/assignment`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: trimmedReason }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setEndFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isEndAssignmentSuccess(body, leadId)) {
          setEndFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
          return;
        }
        setDisplayedAssignment(null);
        setEndReason('');
        setEndSuccess(true);
        // A successful end makes the opposite (assign/reassign) form's own
        // success/error/selection state obsolete — it described an action
        // against the assignment this just ended.
        setSelectedStaffId('');
        setAssignReason('');
        setAssignReasonError(null);
        setAssignFormError(null);
        setAssignSuccess(false);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setEndFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      const reasonDetail = error.details?.find((detail) => detail.path === 'reason');
      if (error.code === 'VALIDATION_ERROR' && reasonDetail) {
        setEndReasonError(reasonDetail.message);
        return;
      }
      setEndFormError(error.message);
    } catch {
      setEndFormError(GENERIC_ASSIGNMENT_ERROR_MESSAGE);
    } finally {
      setPendingAction(null);
    }
  }

  if (!isAdmin) {
    return (
      <div className={styles.statusPanel}>
        <h2>Assignment</h2>
        <p>
          Assigned Consultant:{' '}
          <strong>{displayedAssignment ? displayedAssignment.staffName : 'Unassigned'}</strong>
        </p>
      </div>
    );
  }

  return (
    <div className={styles.statusPanel}>
      <h2>Assignment</h2>
      <p>
        Assigned Consultant:{' '}
        <strong>{displayedAssignment ? displayedAssignment.staffName : 'Unassigned'}</strong>
      </p>

      {assignSuccess ? (
        <p role="status" className={styles.formSuccessAlert}>
          Assignment updated.
        </p>
      ) : null}
      {endSuccess ? (
        <p role="status" className={styles.formSuccessAlert}>
          Assignment ended.
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
        <form onSubmit={handleAssignSubmit} className={styles.leadForm} noValidate>
          {assignFormError ? (
            <p role="alert" className={styles.formAlert}>
              {assignFormError}
            </p>
          ) : null}

          <div className={styles.filterField}>
            <label htmlFor={selectId}>Assign to</label>
            <select
              id={selectId}
              value={selectedStaffId}
              onChange={(event) => {
                setSelectedStaffId(event.target.value);
                setAssignReason('');
                setAssignReasonError(null);
                setAssignFormError(null);
                setAssignSuccess(false);
              }}
              disabled={isPending}
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
            <div className={styles.filterField}>
              <label htmlFor={assignReasonId}>Reason for reassignment</label>
              <textarea
                id={assignReasonId}
                value={assignReason}
                onChange={(event) => {
                  setAssignReason(event.target.value);
                  setAssignReasonError(null);
                  setAssignFormError(null);
                  setAssignSuccess(false);
                }}
                maxLength={500}
                rows={3}
                aria-invalid={assignReasonError ? true : undefined}
                aria-describedby={assignReasonError ? `${assignReasonId}-error` : undefined}
                disabled={isPending}
                required
              />
              {assignReasonError ? (
                <p id={`${assignReasonId}-error`} className={styles.fieldError}>
                  {assignReasonError}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className={styles.formActions}>
            <button type="submit" disabled={isPending || !selectedStaffId || isNoOpSelection}>
              {pendingAction === 'assign' ? 'Saving…' : isReplacing ? 'Reassign' : 'Assign'}
            </button>
          </div>
        </form>
      )}

      {isReplacing ? (
        <form onSubmit={handleEndSubmit} className={styles.leadForm} noValidate>
          {endFormError ? (
            <p role="alert" className={styles.formAlert}>
              {endFormError}
            </p>
          ) : null}

          <div className={styles.filterField}>
            <label htmlFor={endReasonId}>Reason for ending assignment</label>
            <textarea
              id={endReasonId}
              value={endReason}
              onChange={(event) => {
                setEndReason(event.target.value);
                setEndReasonError(null);
                setEndFormError(null);
                setEndSuccess(false);
              }}
              maxLength={500}
              rows={3}
              aria-invalid={endReasonError ? true : undefined}
              aria-describedby={endReasonError ? `${endReasonId}-error` : undefined}
              disabled={isPending}
              required
            />
            {endReasonError ? (
              <p id={`${endReasonId}-error`} className={styles.fieldError}>
                {endReasonError}
              </p>
            ) : null}
          </div>

          <div className={styles.formActions}>
            <button type="submit" disabled={isPending}>
              {pendingAction === 'end' ? 'Ending…' : 'End assignment'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
