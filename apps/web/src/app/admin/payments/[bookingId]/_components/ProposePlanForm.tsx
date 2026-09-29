'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../payments.module.css';
import { sendJson } from './paymentRequest';

type Row = { amount: string; dueDate: string };

const EMPTY_ROW: Row = { amount: '', dueDate: '' };

/**
 * A Travel Consultant's plan proposal (D-054 §3/§6). Installments are
 * numbered in the order shown; the first may be marked as the deposit
 * (D-019: a deposit is always sequence 1). The service validates the
 * structure, the amounts' currency precision, the Booking's financials and
 * status, and active-plan uniqueness; its field errors are shown per row.
 */
export function ProposePlanForm({
  bookingId,
  currencyCode,
}: {
  bookingId: string;
  currencyCode: string;
}) {
  const router = useRouter();
  const formId = useId();
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY_ROW }]);
  const [firstIsDeposit, setFirstIsDeposit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  function updateRow(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setFieldErrors({});
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const outcome = await sendJson('/api/payments/plans', 'POST', {
        bookingId,
        installments: rows.map((row, index) => ({
          sequenceNumber: index + 1,
          isDeposit: index === 0 && firstIsDeposit,
          amount: row.amount.trim(),
          dueDate: row.dueDate,
        })),
      });
      if (outcome.ok) {
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

  return (
    <form onSubmit={handleSubmit} className={styles.form} noValidate>
      <h3>Propose a payment plan</h3>
      <p>
        Amounts are in {currencyCode}, with two decimal places (for example 35000.00). The
        installments must add up to the booking total before Finance/Accounting can approve the
        plan.
      </p>
      {error ? (
        <p role="alert" className={styles.formAlert}>
          {error}
        </p>
      ) : null}
      <ol className={styles.itemList}>
        {rows.map((row, index) => {
          const amountId = `${formId}-amount-${index}`;
          const dueId = `${formId}-due-${index}`;
          const amountError = fieldErrors[`installments.${index}.amount`];
          const dueError = fieldErrors[`installments.${index}.dueDate`];
          return (
            <li key={index} className={styles.item}>
              <div className={styles.formRow}>
                <div className={styles.formField}>
                  <label htmlFor={amountId}>
                    Installment {index + 1}
                    {index === 0 && firstIsDeposit ? ' (deposit)' : ''} amount
                  </label>
                  <input
                    id={amountId}
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(event) => updateRow(index, { amount: event.target.value })}
                    aria-invalid={amountError ? true : undefined}
                    disabled={submitting}
                    required
                  />
                  {amountError ? <p className={styles.fieldError}>{amountError}</p> : null}
                </div>
                <div className={styles.formField}>
                  <label htmlFor={dueId}>Due date</label>
                  <input
                    id={dueId}
                    type="date"
                    value={row.dueDate}
                    onChange={(event) => updateRow(index, { dueDate: event.target.value })}
                    aria-invalid={dueError ? true : undefined}
                    disabled={submitting}
                    required
                  />
                  {dueError ? <p className={styles.fieldError}>{dueError}</p> : null}
                </div>
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    disabled={submitting}
                    aria-label={`Remove installment ${index + 1}`}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <label>
        <input
          type="checkbox"
          checked={firstIsDeposit}
          onChange={(event) => setFirstIsDeposit(event.target.checked)}
          disabled={submitting}
        />{' '}
        Installment 1 is the deposit
      </label>
      <div className={styles.formActions}>
        <button
          type="button"
          onClick={() => setRows((current) => [...current, { ...EMPTY_ROW }])}
          disabled={submitting}
        >
          Add installment
        </button>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Proposing…' : 'Propose plan'}
        </button>
      </div>
    </form>
  );
}
