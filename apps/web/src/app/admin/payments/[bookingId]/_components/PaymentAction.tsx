'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../payments.module.css';
import { sendJson, useIdempotencyKey } from './paymentRequest';
import { useSuccessFeedback } from './SectionFeedback';

export type PaymentActionProps = {
  /** The button that opens the action. */
  label: string;
  /** The button that sends it. */
  submitLabel: string;
  url: string;
  /** Collect a required reason and send it as `reason`. */
  withReason?: boolean;
  /** Send an idempotency key (confirm, reverse, and allocation reversal). */
  idempotent?: boolean;
  /**
   * Shown before the final submit of a destructive or irreversible action
   * (.claude/rules/admin-dashboard.md's explicit confirmation step). The
   * action is only sent from this second step.
   */
  warning?: string;
  successMessage: string;
};

/**
 * One payments operation on one record — approve or withdraw a plan,
 * confirm or reverse a payment, issue a receipt, reverse an allocation.
 * Opening the action and sending it are always two separate clicks; the
 * server decides whether it is allowed and its message is shown as-is.
 */
export function PaymentAction({
  label,
  submitLabel,
  url,
  withReason = false,
  idempotent = false,
  warning,
  successMessage,
}: PaymentActionProps) {
  const router = useRouter();
  const reasonId = useId();
  const { key, renew } = useIdempotencyKey();
  const feedback = useSuccessFeedback();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  function close() {
    setOpen(false);
    setReason('');
    setError(null);
    setReasonError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = reason.trim();
    if (withReason && trimmed.length === 0) {
      setReasonError('A reason is required.');
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setReasonError(null);

    try {
      const outcome = await sendJson(url, 'POST', {
        ...(withReason ? { reason: trimmed } : {}),
        ...(idempotent ? { idempotencyKey: key } : {}),
      });
      if (outcome.ok) {
        renew();
        close();
        // Section-level when available: this control may not exist after the
        // refresh (e.g. Confirm on a now-confirmed payment).
        if (!feedback.announce(successMessage)) setDone(true);
        router.refresh();
        return;
      }
      if (outcome.fieldErrors.reason) {
        setReasonError(outcome.fieldErrors.reason);
        return;
      }
      setError(outcome.message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div>
        {done ? (
          <p role="status" className={styles.formSuccessAlert}>
            {successMessage}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setDone(false);
            feedback.clear();
            setOpen(true);
          }}
        >
          {label}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={styles.confirmBox} noValidate>
      {warning ? <p>{warning}</p> : null}
      {error ? (
        <p role="alert" className={styles.formAlert}>
          {error}
        </p>
      ) : null}
      {withReason ? (
        <div className={styles.formField}>
          <label htmlFor={reasonId}>Reason</label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(null);
              // A changed request is a new operation (see useIdempotencyKey).
              if (idempotent) renew();
            }}
            rows={2}
            maxLength={1000}
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
        <button type="submit" disabled={submitting}>
          {submitting ? 'Working…' : submitLabel}
        </button>
        <button type="button" onClick={close} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}
