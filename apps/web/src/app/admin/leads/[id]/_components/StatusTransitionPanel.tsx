'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { LEAD_STATUS_LABELS } from '../../_components/leadStatusLabels';
import styles from '../../leads.module.css';

// A client-safe Lead-status type derived from the existing, already
// client-safe LEAD_STATUS_LABELS map — never the generated Prisma
// `LeadStatus` type, which this client component must not import (D-023
// §9/§10).
type LeadStatusKey = keyof typeof LEAD_STATUS_LABELS;

function isValidLeadStatus(value: unknown): value is LeadStatusKey {
  // `Object.hasOwn`, not `in` — `in` also matches inherited
  // Object.prototype properties, which are not real LeadStatus values.
  return typeof value === 'string' && Object.hasOwn(LEAD_STATUS_LABELS, value);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// D-022 §6's mandatory-reason limit (features/leads/schemas.ts's
// reasonSchema: `.trim().min(1).max(500)`).
const REASON_MAX_LENGTH = 500;

// The set of transitions this specific Lead may make from its current
// status, and whether each one requires a reason — computed server-side in
// page.tsx from the real features/leads/transitions.ts matrix (which this
// client component must not import: it type-imports the generated Prisma
// `LeadStatus` as a runtime enum value, not just a type). This filtering is
// a UX convenience only; the server remains the sole authority — a request
// this panel would never offer is still rejected authoritatively by
// PUT /api/leads/[id]/status if it somehow arrives.
export type StatusOption = { status: LeadStatusKey; reasonRequired: boolean };

type UpdateLeadStatusSuccess = { lead: { id: string; status: LeadStatusKey } };

type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while updating the lead status. Please check your connection and try again.';

function isUpdateLeadStatusSuccess(value: unknown): value is UpdateLeadStatusSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const lead = candidate.lead;
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return false;
  const leadCandidate = lead as Record<string, unknown>;
  return isNonEmptyTrimmedString(leadCandidate.id) && isValidLeadStatus(leadCandidate.status);
}

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

export type StatusTransitionPanelProps = {
  leadId: string;
  currentStatus: LeadStatusKey;
  options: StatusOption[];
};

/**
 * Lifecycle-status transition controls (D-022 §6/§7; D-023 §4). Submits
 * directly to the existing `PUT /api/leads/[id]/status` — offered targets
 * come entirely from `options` (server-computed from the real transition
 * matrix), never a locally reimplemented copy of it. `CONVERTED_TO_CLIENT`
 * and the confirmed current status are never offered: `options` is computed
 * server-side to exclude both (D-023 §4), and this component additionally
 * filters them defensively (`visibleOptions`) so a caller passing either
 * one — or a stale `options` prop after the confirmed status has since
 * changed — still can't render it. The displayed status only ever changes
 * after the server confirms it — never optimistically.
 *
 * `options` is computed by the server for `currentStatus` specifically — it
 * stops being valid the instant a transition succeeds, because it still
 * describes the *previous* status's legal targets. `router.refresh()`
 * eventually delivers fresh `currentStatus`/`options` props for the new
 * status, but that's a real network round trip; until it lands, this
 * component treats `confirmedStatus !== currentStatus` as "awaiting
 * refreshed options" and shows no transition options at all rather than
 * the stale ones (`awaitingRefresh` below) — while still keeping the
 * "Status updated." confirmation visible throughout that window.
 */
export function StatusTransitionPanel({
  leadId,
  currentStatus,
  options,
}: StatusTransitionPanelProps) {
  const router = useRouter();
  const [confirmedStatus, setConfirmedStatus] = useState<LeadStatusKey>(currentStatus);
  const [selected, setSelected] = useState('');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justChanged, setJustChanged] = useState(false);

  const selectId = useId();
  const reasonId = useId();

  // `options`/`currentStatus` are a matched pair computed server-side for
  // one specific status. Once `confirmedStatus` (set from the mutation
  // response, immediately on success) diverges from `currentStatus` (the
  // prop — only updated once router.refresh()'s new Server Component
  // render reaches this component), `options` describes the *previous*
  // status's legal targets and must not be offered at all, not even
  // filtered, until the props catch up.
  const awaitingRefresh = confirmedStatus !== currentStatus;

  // Defensive filter — `options` is server-computed to already exclude the
  // current status and CONVERTED_TO_CLIENT (page.tsx), but this component
  // never trusts that alone: it re-derives the confirmed status live from
  // `confirmedStatus`, and never renders CONVERTED_TO_CLIENT regardless of
  // what a caller passes in.
  const visibleOptions = awaitingRefresh
    ? []
    : options.filter(
        (option) => option.status !== confirmedStatus && option.status !== 'CONVERTED_TO_CLIENT',
      );

  const selectedOption = visibleOptions.find((option) => option.status === selected);
  const reasonRequired = selectedOption?.reasonRequired ?? false;

  function handleSelectChange(value: string) {
    setSelected(value);
    // A reason entered for one transition must never be submitted with a
    // different transition — clear it on every selection change, not just
    // the error/status state below.
    setReason('');
    setReasonError(null);
    setFormError(null);
    setJustChanged(false);
  }

  function handleReasonChange(value: string) {
    setReason(value);
    setReasonError(null);
    setJustChanged(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    if (!selectedOption) {
      setFormError('Select a status to change to.');
      return;
    }

    const trimmedReason = reason.trim();
    if (reasonRequired && trimmedReason.length === 0) {
      setReasonError('A reason is required for this transition.');
      return;
    }

    setFormError(null);
    setReasonError(null);
    setJustChanged(false);
    setSubmitting(true);

    try {
      const response = await fetch(`/api/leads/${leadId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedStatus: confirmedStatus,
          newStatus: selectedOption.status,
          // Gated on `reasonRequired`, not merely on non-empty `reason` —
          // a non-reason-required transition must never include a `reason`
          // key, even defensively, regardless of what `reason` state holds.
          ...(reasonRequired && trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isUpdateLeadStatusSuccess(body)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        // Never assume success or invent the new status from the submitted
        // values alone — only the confirmed response updates it.
        setConfirmedStatus(body.lead.status);
        setSelected('');
        setReason('');
        setJustChanged(true);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      // The reason field is only rendered when `reasonRequired` is true —
      // a reason-shaped error is only shown inline when there is an input
      // for it to describe; otherwise it falls back to the general alert
      // below rather than being set on an invisible field.
      if (error.code === 'REASON_REQUIRED' && reasonRequired) {
        setReasonError(error.message);
        return;
      }
      if (
        error.code === 'VALIDATION_ERROR' &&
        error.details &&
        error.details.length > 0 &&
        reasonRequired
      ) {
        const reasonDetail = error.details.find((detail) => detail.path === 'reason');
        if (reasonDetail) {
          setReasonError(reasonDetail.message);
          return;
        }
      }
      // Covers LEAD_CONFLICT (stale expectedStatus), INVALID_STATUS_
      // TRANSITION, CONVERSION_ENDPOINT_REQUIRED, LEAD_NOT_FOUND/
      // LEAD_FORBIDDEN, and any other controlled failure — each already
      // carries a safe, server-crafted message.
      setFormError(error.message);
    } catch {
      setFormError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.statusPanel}>
      <h2>Change Status</h2>
      <p>
        Current status: <strong>{LEAD_STATUS_LABELS[confirmedStatus]}</strong>
      </p>

      {/* Rendered independently of the options/form state below so a
          successful transition's confirmation stays visible throughout the
          `awaitingRefresh` window, not just while the form happens to be
          shown. */}
      {justChanged ? (
        <p role="status" className={styles.formSuccessAlert}>
          Status updated.
        </p>
      ) : null}

      {awaitingRefresh ? (
        <p>Refreshing available status changes…</p>
      ) : visibleOptions.length === 0 ? (
        <p>No status changes are available for this lead.</p>
      ) : (
        <form onSubmit={handleSubmit} className={styles.leadForm} noValidate>
          {formError ? (
            <p role="alert" className={styles.formAlert}>
              {formError}
            </p>
          ) : null}

          <div className={styles.filterField}>
            <label htmlFor={selectId}>Change status to</label>
            <select
              id={selectId}
              value={selected}
              onChange={(event) => handleSelectChange(event.target.value)}
            >
              <option value="">Select a status…</option>
              {visibleOptions.map((option) => (
                <option key={option.status} value={option.status}>
                  {LEAD_STATUS_LABELS[option.status]}
                </option>
              ))}
            </select>
          </div>

          {reasonRequired ? (
            <div className={styles.filterField}>
              <label htmlFor={reasonId}>Reason</label>
              <textarea
                id={reasonId}
                value={reason}
                onChange={(event) => handleReasonChange(event.target.value)}
                maxLength={REASON_MAX_LENGTH}
                rows={3}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby={reasonError ? `${reasonId}-error` : undefined}
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
            <button type="submit" disabled={submitting || !selected}>
              {submitting ? 'Changing…' : 'Change Status'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
