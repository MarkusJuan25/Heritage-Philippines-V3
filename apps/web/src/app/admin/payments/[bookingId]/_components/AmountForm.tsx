'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../payments.module.css';
import { sendJson, useIdempotencyKey } from './paymentRequest';
import { useSuccessFeedback } from './SectionFeedback';

export type SelectField = {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  /** Adds a first "none" option sending no value (an optional field). */
  optionalLabel?: string;
};

export type AmountFormProps = {
  title: string;
  submitLabel: string;
  url: string;
  /** Fixed values sent with every request, such as the Booking id. */
  fixed?: Record<string, string>;
  selects?: SelectField[];
  withReason?: boolean;
  /** Explicit confirmation text for an irreversible action (refunds). */
  warning?: string;
  successMessage: string;
  currencyCode: string;
};

/**
 * An amount-bearing payments operation — record a payment, refund a
 * payment, or allocate part of a payment to an installment. Always sends an
 * idempotency key (see useIdempotencyKey). With `warning`, the first submit
 * only asks for confirmation and the second sends the request.
 */
export function AmountForm({
  title,
  submitLabel,
  url,
  fixed = {},
  selects = [],
  withReason = false,
  warning,
  successMessage,
  currencyCode,
}: AmountFormProps) {
  const router = useRouter();
  const formId = useId();
  const { key, renew } = useIdempotencyKey();
  const feedback = useSuccessFeedback();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      selects.map((select) => [
        select.name,
        select.optionalLabel ? '' : (select.options[0]?.value ?? ''),
      ]),
    ),
  );
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  function edited() {
    renew();
    setConfirming(false);
    setError(null);
    setFieldErrors({});
    setDone(false);
    feedback.clear();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (warning && !confirming) {
      setConfirming(true);
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const outcome = await sendJson(url, 'POST', {
        ...fixed,
        ...Object.fromEntries(Object.entries(selected).filter(([, value]) => value !== '')),
        amount: amount.trim(),
        ...(withReason ? { reason: reason.trim() } : {}),
        idempotencyKey: key,
      });
      if (outcome.ok) {
        renew();
        setAmount('');
        setReason('');
        setConfirming(false);
        // Section-level when available: a full refund removes this form.
        if (!feedback.announce(successMessage)) setDone(true);
        router.refresh();
        return;
      }
      setConfirming(false);
      setFieldErrors(outcome.fieldErrors);
      setError(outcome.message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const amountId = `${formId}-amount`;
  const reasonId = `${formId}-reason`;

  return (
    <form onSubmit={handleSubmit} className={styles.form} noValidate>
      <h3>{title}</h3>
      {done ? (
        <p role="status" className={styles.formSuccessAlert}>
          {successMessage}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.formAlert}>
          {error}
        </p>
      ) : null}
      {selects.map((select) => {
        const id = `${formId}-${select.name}`;
        return (
          <div key={select.name} className={styles.formField}>
            <label htmlFor={id}>{select.label}</label>
            <select
              id={id}
              value={selected[select.name] ?? ''}
              onChange={(event) => {
                setSelected((current) => ({ ...current, [select.name]: event.target.value }));
                edited();
              }}
              disabled={submitting}
            >
              {select.optionalLabel ? <option value="">{select.optionalLabel}</option> : null}
              {select.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {fieldErrors[select.name] ? (
              <p className={styles.fieldError}>{fieldErrors[select.name]}</p>
            ) : null}
          </div>
        );
      })}
      <div className={styles.formField}>
        <label htmlFor={amountId}>Amount ({currencyCode})</label>
        <input
          id={amountId}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value);
            edited();
          }}
          aria-invalid={fieldErrors.amount ? true : undefined}
          disabled={submitting}
          required
        />
        {fieldErrors.amount ? <p className={styles.fieldError}>{fieldErrors.amount}</p> : null}
      </div>
      {withReason ? (
        <div className={styles.formField}>
          <label htmlFor={reasonId}>Reason</label>
          <textarea
            id={reasonId}
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              edited();
            }}
            aria-invalid={fieldErrors.reason ? true : undefined}
            disabled={submitting}
            required
          />
          {fieldErrors.reason ? <p className={styles.fieldError}>{fieldErrors.reason}</p> : null}
        </div>
      ) : null}
      {confirming && warning ? (
        <p role="alert" className={styles.confirmBox}>
          {warning}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Working…' : confirming ? `Confirm: ${submitLabel}` : submitLabel}
        </button>
        {confirming ? (
          <button type="button" onClick={() => setConfirming(false)} disabled={submitting}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
