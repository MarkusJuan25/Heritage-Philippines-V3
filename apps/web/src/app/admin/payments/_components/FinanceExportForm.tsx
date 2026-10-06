'use client';

import { useId, useRef, useState, type FormEvent } from 'react';

import styles from '../payments.module.css';
import { PAYMENT_STATUS_LABELS } from './labels';

// The admin form for basic finance exports (D-061 Stage 3). It sends one
// request to `POST /api/payments/exports` and saves the file the server
// returns. Every rule — who may export, which filters a dataset takes, the
// row limit — is the server's; this form only chooses which fields to show
// and carries the server's refusal back to the user.

const EXPORT_URL = '/api/payments/exports';

const DATASETS = [
  { value: 'bookings', label: 'Bookings' },
  { value: 'payments', label: 'Payments' },
  { value: 'refunds', label: 'Refunds' },
  { value: 'allocations', label: 'Allocations' },
  { value: 'installments', label: 'Installments' },
] as const;
type Dataset = (typeof DATASETS)[number]['value'];

// What each dataset's date range is measured on (D-061 §5).
const DATE_RANGE_HINT: Record<Exclude<Dataset, 'bookings'>, string> = {
  payments: 'Filters by the date a payment was recorded.',
  refunds: 'Filters by the date a refund was performed.',
  allocations: 'Filters by the date an allocation was made.',
  installments: 'Filters by installment due date.',
};

// 422: the export would exceed the row limit. The filters a user can
// narrow differ by dataset.
const ROW_LIMIT_GUIDANCE: Record<Dataset, string> = {
  bookings:
    'This export has too many rows to download at once. Enter a booking reference to export one booking.',
  payments:
    'This export has too many rows to download at once. Choose a shorter date range, enter a booking reference, or pick a payment status, then try again.',
  refunds:
    'This export has too many rows to download at once. Choose a shorter date range or enter a booking reference, then try again.',
  allocations:
    'This export has too many rows to download at once. Choose a shorter date range or enter a booking reference, then try again.',
  installments:
    'This export has too many rows to download at once. Choose a shorter date range or enter a booking reference, then try again.',
};

const VALIDATION_MESSAGE = 'Check the highlighted fields and try again.';
// A 400 that points at no field this form is showing.
const REJECTED_MESSAGE = 'The export request was not accepted. Check the filters and try again.';
const SESSION_MESSAGE = 'Your session has ended. Sign in again, then retry the export.';
// 403 has more than one cause — a role that may not export, or a request
// the endpoint's cross-site policy refused (D-063) — and the server does not
// say which. Neither does this.
const FORBIDDEN_MESSAGE =
  'This export request was not permitted. If this keeps happening, contact your administrator.';
// 500 and anything unexpected. Deliberately says nothing about the cause.
const FAILURE_MESSAGE =
  'The export could not be generated. If this keeps happening, contact your administrator.';
const NETWORK_MESSAGE = 'The export could not be requested. Check your connection and try again.';

type ValidationDetail = { path: string; message: string };

function readValidationDetails(value: unknown): ValidationDetail[] {
  const details = (value as { error?: { details?: unknown } } | null)?.error?.details;
  if (!Array.isArray(details)) return [];
  return details.filter(
    (detail): detail is ValidationDetail =>
      !!detail &&
      typeof (detail as ValidationDetail).path === 'string' &&
      typeof (detail as ValidationDetail).message === 'string',
  );
}

/** The server's own filename from `Content-Disposition`, or `null` if it is not a plain CSV name. */
function readFilename(header: string | null): string | null {
  const match = header ? /^attachment;\s*filename="([^"\\/]+\.csv)"$/.exec(header) : null;
  return match ? match[1]! : null;
}

/** Hands a file to the browser's download handling and always releases the object URL. */
function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

export function FinanceExportForm() {
  const formId = useId();
  const [dataset, setDataset] = useState<Dataset>('bookings');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [bookingReference, setBookingReference] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const hasDateRange = dataset !== 'bookings';
  const hasStatus = dataset === 'payments';

  function edited() {
    setError(null);
    setFieldErrors({});
    setDownloaded(null);
  }

  /** Only the filters the chosen dataset takes, and only those that were filled in. */
  function buildRequest(): Record<string, string> {
    const request: Record<string, string> = { dataset };
    if (bookingReference.trim() !== '') request.bookingReference = bookingReference.trim();
    if (hasDateRange && from !== '') request.from = from;
    if (hasDateRange && to !== '') request.to = to;
    if (hasStatus && status !== '') request.status = status;
    return request;
  }

  /** Immediate feedback only; the server validates every request itself. */
  function checkBeforeSending(request: Record<string, string>): Record<string, string> {
    const problems: Record<string, string> = {};
    if (!hasDateRange) return problems;
    if (request.from !== undefined && request.to === undefined) {
      problems.to = 'Enter the end of the date range.';
    } else if (request.from === undefined && request.to !== undefined) {
      problems.from = 'Enter the start of the date range.';
    } else if (request.from === undefined && request.bookingReference === undefined) {
      problems.from = 'Enter a date range, a booking reference, or both.';
    } else if (
      request.from !== undefined &&
      request.to !== undefined &&
      request.from > request.to
    ) {
      problems.from = 'The start date must not be after the end date.';
    }
    return problems;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;

    const request = buildRequest();
    const problems = checkBeforeSending(request);
    setDownloaded(null);
    if (Object.keys(problems).length > 0) {
      setFieldErrors(problems);
      setError(VALIDATION_MESSAGE);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      let response: Response;
      try {
        response = await fetch(EXPORT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch {
        setError(NETWORK_MESSAGE);
        return;
      }

      if (response.ok) {
        const filename = readFilename(response.headers.get('Content-Disposition'));
        if (filename === null) {
          setError(FAILURE_MESSAGE);
          return;
        }
        try {
          saveFile(await response.blob(), filename);
        } catch {
          setError(FAILURE_MESSAGE);
          return;
        }
        setDownloaded(filename);
        return;
      }

      if (response.status === 400) {
        const nextFieldErrors: Record<string, string> = {};
        for (const detail of readValidationDetails(await response.json().catch(() => null))) {
          const field = detail.path === '' ? 'dataset' : detail.path;
          if (!nextFieldErrors[field]) nextFieldErrors[field] = detail.message;
        }
        const shownFields = [
          'dataset',
          'bookingReference',
          ...(hasDateRange ? ['from', 'to'] : []),
          ...(hasStatus ? ['status'] : []),
        ];
        setFieldErrors(nextFieldErrors);
        setError(
          shownFields.some((field) => nextFieldErrors[field])
            ? VALIDATION_MESSAGE
            : REJECTED_MESSAGE,
        );
      } else if (response.status === 422) {
        setError(ROW_LIMIT_GUIDANCE[dataset]);
      } else if (response.status === 401) {
        setError(SESSION_MESSAGE);
      } else if (response.status === 403) {
        setError(FORBIDDEN_MESSAGE);
      } else {
        setError(FAILURE_MESSAGE);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const ids = {
    dataset: `${formId}-dataset`,
    from: `${formId}-from`,
    to: `${formId}-to`,
    bookingReference: `${formId}-booking-reference`,
    status: `${formId}-status`,
  };
  const errorId = (field: keyof typeof ids) => `${ids[field]}-error`;
  const describe = (field: keyof typeof ids) =>
    fieldErrors[field] ? { 'aria-invalid': true as const, 'aria-describedby': errorId(field) } : {};
  const fieldError = (field: keyof typeof ids) =>
    fieldErrors[field] ? (
      <p id={errorId(field)} className={styles.fieldError}>
        {fieldErrors[field]}
      </p>
    ) : null;

  return (
    <form onSubmit={handleSubmit} className={styles.form} noValidate>
      <p>
        Downloads one CSV file of payment records for the bookings you may see. Each export is
        recorded in the audit log.
      </p>
      {error ? (
        <p role="alert" className={styles.formAlert}>
          {error}
        </p>
      ) : null}
      {downloaded ? (
        <p role="status" className={styles.formSuccessAlert}>
          Export downloaded: {downloaded}
        </p>
      ) : null}

      <div className={styles.formField}>
        <label htmlFor={ids.dataset}>Records to export</label>
        <select
          id={ids.dataset}
          value={dataset}
          onChange={(event) => {
            setDataset(event.target.value as Dataset);
            edited();
          }}
          {...describe('dataset')}
        >
          {DATASETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {fieldError('dataset')}
      </div>

      {hasDateRange ? (
        <fieldset className={styles.formRow}>
          <legend>Date range (optional with a booking reference)</legend>
          <div className={styles.formField}>
            <label htmlFor={ids.from}>From</label>
            <input
              id={ids.from}
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                edited();
              }}
              {...describe('from')}
            />
            {fieldError('from')}
          </div>
          <div className={styles.formField}>
            <label htmlFor={ids.to}>To</label>
            <input
              id={ids.to}
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                edited();
              }}
              {...describe('to')}
            />
            {fieldError('to')}
          </div>
          <p>{DATE_RANGE_HINT[dataset]} A range may cover at most 366 days.</p>
        </fieldset>
      ) : null}

      <div className={styles.formField}>
        <label htmlFor={ids.bookingReference}>
          {hasDateRange ? 'Booking reference' : 'Booking reference (optional)'}
        </label>
        <input
          id={ids.bookingReference}
          type="text"
          value={bookingReference}
          maxLength={24}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setBookingReference(event.target.value);
            edited();
          }}
          {...describe('bookingReference')}
        />
        {fieldError('bookingReference')}
      </div>

      {hasStatus ? (
        <div className={styles.formField}>
          <label htmlFor={ids.status}>Payment status</label>
          <select
            id={ids.status}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              edited();
            }}
            {...describe('status')}
          >
            <option value="">Any</option>
            {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {fieldError('status')}
        </div>
      ) : null}

      <div className={styles.formActions}>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Preparing export…' : 'Download CSV'}
        </button>
      </div>
    </form>
  );
}
