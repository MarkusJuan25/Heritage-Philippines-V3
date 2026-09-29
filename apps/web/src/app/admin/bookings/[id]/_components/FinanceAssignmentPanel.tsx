'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../bookings.module.css';

export type FinanceAssigneeSummary = {
  name: string;
  email: string;
  role: string;
  /** False when the assignee is no longer an active Finance/Accounting user. */
  eligible: boolean;
} | null;

export type EligibleFinanceStaff = { id: string; name: string; email: string };

type ApiErrorBody = {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
};

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error as Record<string, unknown> | undefined;
  return !!error && typeof error.code === 'string' && typeof error.message === 'string';
}

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while updating the Finance/Accounting assignment. Please check your connection and try again.';

/**
 * The Booking's Finance/Accounting assignment (D-056 §1), shown only to
 * Admin/Manager — the only role that may read or change it. Set, replace
 * (a reason is required), and end (a reason and an explicit confirmation
 * step are required) all go through `/api/bookings/[id]/finance-assignment`
 * and `features/assignments/service.ts`, which own eligibility, the reason
 * rules, and the audit records. It never touches the Travel Consultant
 * assignment panel above it.
 */
export function FinanceAssignmentPanel({
  bookingId,
  current,
  eligible,
}: {
  bookingId: string;
  current: FinanceAssigneeSummary;
  eligible: EligibleFinanceStaff[];
}) {
  const router = useRouter();
  const selectId = useId();
  const reasonId = useId();
  const endReasonId = useId();
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [reason, setReason] = useState('');
  const [endOpen, setEndOpen] = useState(false);
  const [endReason, setEndReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  async function send(method: 'PUT' | 'DELETE', body: Record<string, string>, done: string) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/bookings/${bookingId}/finance-assignment`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: unknown = await response.json();
      if (response.ok) {
        setSelectedStaffId('');
        setReason('');
        setEndReason('');
        setEndOpen(false);
        setSuccess(done);
        router.refresh();
        return;
      }
      if (isApiErrorBody(json)) {
        const detail = json.error.details?.find((item) => item.path === 'reason');
        setError(detail ? detail.message : json.error.message);
        return;
      }
      setError(GENERIC_ERROR_MESSAGE);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedStaffId) {
      setError('Select a Finance/Accounting user to assign.');
      return;
    }
    const trimmed = reason.trim();
    if (current && trimmed.length === 0) {
      setError('A reason is required when replacing the current assignee.');
      return;
    }
    void send(
      'PUT',
      { assignedStaffId: selectedStaffId, ...(current ? { reason: trimmed } : {}) },
      current ? 'Finance/Accounting assignee replaced.' : 'Finance/Accounting assignee set.',
    );
  }

  function handleEnd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = endReason.trim();
    if (trimmed.length === 0) {
      setError('A reason is required to end the assignment.');
      return;
    }
    void send('DELETE', { reason: trimmed }, 'Finance/Accounting assignment ended.');
  }

  return (
    <div className={styles.assignmentPanel}>
      <h2>Finance/Accounting assignment</h2>
      <p>
        Assigned Finance/Accounting:{' '}
        <strong>{current ? `${current.name} (${current.email})` : 'Not assigned'}</strong>
      </p>
      {current && !current.eligible ? (
        <p role="alert" className={styles.formAlert}>
          This assignee is no longer an active Finance/Accounting user (current role: {current.role}
          ), so the assignment grants no payment access. End or replace it.
        </p>
      ) : null}
      {success ? (
        <p role="status" className={styles.formSuccessAlert}>
          {success}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.formAlert}>
          {error}
        </p>
      ) : null}

      {eligible.length === 0 ? (
        <p>No eligible Finance/Accounting users are currently available.</p>
      ) : (
        <form onSubmit={handleAssign} className={styles.statusForm} noValidate>
          <div className={styles.formField}>
            <label htmlFor={selectId}>{current ? 'Replace with' : 'Assign to'}</label>
            <select
              id={selectId}
              value={selectedStaffId}
              onChange={(event) => {
                setSelectedStaffId(event.target.value);
                setError(null);
                setSuccess(null);
              }}
              disabled={submitting}
            >
              <option value="">Select a Finance/Accounting user…</option>
              {eligible.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.name} ({staff.email})
                </option>
              ))}
            </select>
          </div>
          {current ? (
            <div className={styles.formField}>
              <label htmlFor={reasonId}>Reason for replacement</label>
              <textarea
                id={reasonId}
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={submitting}
                required
              />
            </div>
          ) : null}
          <div className={styles.formActions}>
            <button type="submit" disabled={submitting || !selectedStaffId}>
              {submitting ? 'Saving…' : current ? 'Replace' : 'Assign'}
            </button>
          </div>
        </form>
      )}

      {current ? (
        endOpen ? (
          <form onSubmit={handleEnd} className={styles.statusForm} noValidate>
            <p>
              Ending removes this user&apos;s access to this booking&apos;s payments. The record is
              kept.
            </p>
            <div className={styles.formField}>
              <label htmlFor={endReasonId}>Reason for ending</label>
              <textarea
                id={endReasonId}
                rows={2}
                maxLength={500}
                value={endReason}
                onChange={(event) => setEndReason(event.target.value)}
                disabled={submitting}
                required
              />
            </div>
            <div className={styles.formActions}>
              <button type="submit" disabled={submitting}>
                {submitting ? 'Ending…' : 'End assignment'}
              </button>
              <button type="button" onClick={() => setEndOpen(false)} disabled={submitting}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setEndOpen(true)}>
            End assignment…
          </button>
        )
      ) : null}
    </div>
  );
}
