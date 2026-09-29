'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { SUPPORTED_CURRENCIES } from '@/features/payments/currencies';

import styles from '../../payments.module.css';
import { sendJson } from './paymentRequest';

/**
 * The Booking's total and currency (D-056 §2; placement corrected
 * September 28, 2026), for the assigned Finance/Accounting user only —
 * other roles see the values read-only on the page. Both values are always
 * sent together, and the currency is chosen explicitly every time, with no
 * default (D-056 §2 "Entry"). Changing values that are already set needs a
 * reason. `setBookingFinancials` decides everything else — the lock once a
 * plan or payment exists, the cancelled-Booking block, the supported
 * currencies and their precision — and its message is shown as-is.
 */
export function FinancialsForm({
  bookingId,
  currentTotal,
  currentCurrency,
}: {
  bookingId: string;
  currentTotal: string | null;
  currentCurrency: string | null;
}) {
  const router = useRouter();
  const formId = useId();
  const isSet = currentTotal !== null;
  const [totalAmount, setTotalAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  function edited() {
    setError(null);
    setFieldErrors({});
    setDone(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (totalAmount.trim() === '') errors.totalAmount = 'Enter the booking total.';
    if (currencyCode === '') errors.currencyCode = 'Select the currency.';
    if (isSet && reason.trim() === '') errors.reason = 'A reason is required to change the total.';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    edited();

    try {
      const outcome = await sendJson(`/api/payments/bookings/${bookingId}/financials`, 'PUT', {
        totalAmount: totalAmount.trim(),
        currencyCode,
        ...(isSet ? { reason: reason.trim() } : {}),
      });
      if (outcome.ok) {
        setTotalAmount('');
        setCurrencyCode('');
        setReason('');
        setDone(true);
        router.refresh();
        return;
      }
      setFieldErrors(outcome.fieldErrors);
      setError(outcome.message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const amountId = `${formId}-total`;
  const currencyId = `${formId}-currency`;
  const reasonId = `${formId}-reason`;

  return (
    <form onSubmit={handleSubmit} className={styles.form} noValidate>
      <h3>{isSet ? 'Correct the booking total' : 'Set the booking total'}</h3>
      <p>
        {isSet
          ? `Currently ${currentCurrency ?? ''} ${currentTotal}. `
          : 'No total is set yet, so no payment plan can be proposed and no payment recorded. '}
        The total and currency lock once a payment plan is proposed or any payment is recorded.
      </p>
      {done ? (
        <p role="status" className={styles.formSuccessAlert}>
          Booking total saved.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.formAlert}>
          {error}
        </p>
      ) : null}
      <div className={styles.formRow}>
        <div className={styles.formField}>
          <label htmlFor={amountId}>Booking total</label>
          <input
            id={amountId}
            inputMode="decimal"
            placeholder="0.00"
            value={totalAmount}
            onChange={(event) => {
              setTotalAmount(event.target.value);
              edited();
            }}
            aria-invalid={fieldErrors.totalAmount ? true : undefined}
            disabled={submitting}
            required
          />
          {fieldErrors.totalAmount ? (
            <p className={styles.fieldError}>{fieldErrors.totalAmount}</p>
          ) : null}
        </div>
        <div className={styles.formField}>
          <label htmlFor={currencyId}>Currency</label>
          <select
            id={currencyId}
            value={currencyCode}
            onChange={(event) => {
              setCurrencyCode(event.target.value);
              edited();
            }}
            aria-invalid={fieldErrors.currencyCode ? true : undefined}
            disabled={submitting}
            required
          >
            <option value="">Select a currency…</option>
            {SUPPORTED_CURRENCIES.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code}
              </option>
            ))}
          </select>
          {fieldErrors.currencyCode ? (
            <p className={styles.fieldError}>{fieldErrors.currencyCode}</p>
          ) : null}
        </div>
      </div>
      {isSet ? (
        <div className={styles.formField}>
          <label htmlFor={reasonId}>Reason for the change</label>
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
      <div className={styles.formActions}>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save booking total'}
        </button>
      </div>
    </form>
  );
}
