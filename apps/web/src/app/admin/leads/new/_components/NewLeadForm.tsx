'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';

import { LEAD_STATUS_LABELS } from '../../_components/leadStatusLabels';
import styles from '../../leads.module.css';

// D-022 §3's exact manual-creation field contract. `status` is
// deliberately never part of this form's state — it is never rendered,
// never collected, and therefore never sent, so this client component
// cannot override the server's own "every new Lead starts NEW" rule
// (features/leads/schemas.ts's createLeadSchema is `.strict()` and has no
// `status` field at all).
type FieldName = 'fullName' | 'source' | 'email' | 'phone' | 'notes';
type FormFields = Record<FieldName, string>;
type FieldErrors = Partial<Record<FieldName, string>>;

const EMPTY_FIELDS: FormFields = { fullName: '', source: '', email: '', phone: '', notes: '' };
const FIELD_NAMES: readonly FieldName[] = ['fullName', 'source', 'email', 'phone', 'notes'];
const FIELD_MAX_LENGTHS: Record<FieldName, number> = {
  fullName: 200,
  source: 200,
  email: 320,
  phone: 50,
  notes: 2000,
};

// A client-safe Lead-status type derived from the existing, already
// client-safe LEAD_STATUS_LABELS map (shared with LeadStatusBadge/
// LeadFilters) — never the generated Prisma `LeadStatus` type, which this
// client component must not import (D-023 §9/§10).
type LeadStatusKey = keyof typeof LEAD_STATUS_LABELS;

function isValidLeadStatus(value: unknown): value is LeadStatusKey {
  // `Object.hasOwn`, not `in` — `in` also matches inherited
  // Object.prototype properties (e.g. "toString", "constructor",
  // "__proto__"), which are not real LeadStatus values.
  return typeof value === 'string' && Object.hasOwn(LEAD_STATUS_LABELS, value);
}

// Local, minimal response shapes for this form's own use — deliberately
// not imported from features/leads/repository.ts or features/leads/
// service.ts (both server-only). This client component talks to
// POST /api/leads only through `fetch`, never a server-only service,
// repository, HTTP helper, or the generated Prisma runtime (D-023 §9/§10).
// A LEAD-type match always carries the matched Lead's current status
// (features/leads/service.ts's findDuplicateMatches always includes it for
// a Lead row); a CLIENT-type match never does — modeled as a discriminated
// union so this invariant is enforced at the type level, not only at
// runtime.
type MatchedOn = 'EMAIL' | 'PHONE';
type DuplicateMatch =
  | { type: 'LEAD'; id: string; fullName: string; status: LeadStatusKey; matchedOn: MatchedOn[] }
  | { type: 'CLIENT'; id: string; fullName: string; matchedOn: MatchedOn[] };

type CreateLeadSuccess = {
  lead: { id: string; fullName: string };
  duplicateMatches: DuplicateMatch[];
  restrictedMatchDetected: boolean;
};

type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while creating this lead. Please check your connection and try again.';

// Required-string fields (lead id/fullName, error code/message, a
// validation detail's message) must actually contain content, not just be
// the right JS type — a whitespace-only value is exactly as unusable as an
// empty one, and both are treated as a malformed response.
function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates a single duplicate-match entry against D-022 §5's exact
 * envelope. Every field is checked, not just its presence, so a malformed
 * match can never reach render — it instead fails `isCreateLeadSuccess`
 * below, and the whole response is treated as malformed rather than
 * partially rendered.
 */
function isDuplicateMatch(value: unknown): value is DuplicateMatch {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;

  if (candidate.type !== 'LEAD' && candidate.type !== 'CLIENT') return false;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false;
  if (typeof candidate.fullName !== 'string' || candidate.fullName.length === 0) return false;
  if (!Array.isArray(candidate.matchedOn) || candidate.matchedOn.length === 0) return false;
  if (!candidate.matchedOn.every((entry) => entry === 'EMAIL' || entry === 'PHONE')) return false;

  if (candidate.type === 'LEAD') {
    return isValidLeadStatus(candidate.status);
  }
  // A CLIENT match must carry no Lead status at all (D-022 §5).
  return candidate.status === undefined;
}

function isCreateLeadSuccess(value: unknown): value is CreateLeadSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;

  const lead = candidate.lead;
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return false;
  const leadCandidate = lead as Record<string, unknown>;
  if (!isNonEmptyTrimmedString(leadCandidate.id)) return false;
  if (!isNonEmptyTrimmedString(leadCandidate.fullName)) return false;

  return (
    Array.isArray(candidate.duplicateMatches) &&
    candidate.duplicateMatches.every(isDuplicateMatch) &&
    typeof candidate.restrictedMatchDetected === 'boolean'
  );
}

// `path` may legitimately be an empty string (a root-level validation
// error, per createLeadSchema's own `.refine(..., { path: ['email'] })`-
// style usage elsewhere in this codebase, and Zod's own root-level `path:
// []` convention which http.ts's `toValidationIssues` joins down to `''`)
// — only `message` must actually contain content.
function isApiErrorDetail(value: unknown): value is ApiErrorDetail {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === 'string' && isNonEmptyTrimmedString(candidate.message);
}

/**
 * `details`, when present, must be an array of valid detail entries — a
 * malformed `details` (not an array, or containing a malformed entry)
 * rejects the whole error body rather than being partially iterated or
 * rendered.
 */
function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const error = candidate.error as Record<string, unknown> | undefined;
  if (!error) return false;
  if (!isNonEmptyTrimmedString(error.code) || !isNonEmptyTrimmedString(error.message)) return false;
  if (error.details === undefined) return true;
  return Array.isArray(error.details) && error.details.every(isApiErrorDetail);
}

/**
 * Manual Lead creation (D-022 §2/§3; D-023 §4). Submits directly to the
 * existing `POST /api/leads` — client validation here is advisory only
 * (D-023 §4's "native/client validation is advisory only"); the server's
 * own `createLeadSchema` remains authoritative, and every controlled
 * failure it returns is rendered from its response, never guessed at
 * client-side.
 */
export function NewLeadForm() {
  const [fields, setFields] = useState<FormFields>(EMPTY_FIELDS);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateLeadSuccess | null>(null);

  const fullNameId = useId();
  const sourceId = useId();
  const emailId = useId();
  const phoneId = useId();
  const notesId = useId();

  function updateField(name: FieldName, value: string) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  function validateClientSide(): FieldErrors {
    const errors: FieldErrors = {};
    if (fields.fullName.trim().length === 0) {
      errors.fullName = 'Full name is required.';
    }
    if (fields.source.trim().length === 0) {
      errors.source = 'Source is required.';
    }
    if (fields.email.trim().length === 0 && fields.phone.trim().length === 0) {
      errors.email = 'At least one of email or phone is required.';
    }
    return errors;
  }

  // Maps a VALIDATION_ERROR's `details` (D-022/backend.md's `{path,
  // message}[]`) to this form's fields where the path matches one of the
  // five known field names, and folds every other path into the form-level
  // alert instead of silently dropping it. Returns whether anything was
  // rendered from `details` at all.
  function applyServerValidationDetails(details: ApiErrorDetail[] | undefined): boolean {
    if (!details || details.length === 0) return false;

    const nextFieldErrors: FieldErrors = {};
    const unmatched: string[] = [];
    for (const detail of details) {
      if ((FIELD_NAMES as readonly string[]).includes(detail.path)) {
        nextFieldErrors[detail.path as FieldName] = detail.message;
      } else {
        unmatched.push(detail.message);
      }
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
    }
    if (unmatched.length > 0) {
      setFormError(unmatched.join(' '));
    }
    return Object.keys(nextFieldErrors).length > 0 || unmatched.length > 0;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const clientErrors = validateClientSide();
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);

    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: fields.fullName,
          source: fields.source,
          email: fields.email,
          phone: fields.phone,
          notes: fields.notes,
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
        if (!isCreateLeadSuccess(body)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        setResult(body);
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      if (error.code === 'VALIDATION_ERROR' && applyServerValidationDetails(error.details)) {
        return;
      }
      setFormError(error.message);
    } catch {
      setFormError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  function handleCreateAnother() {
    setFields(EMPTY_FIELDS);
    setFieldErrors({});
    setFormError(null);
    setResult(null);
    setSubmitting(false);
  }

  if (result) {
    const hasDuplicateContent =
      result.duplicateMatches.length > 0 || result.restrictedMatchDetected;
    return (
      <div className={styles.formSuccess}>
        <p role="status">
          Lead <strong>{result.lead.fullName}</strong> was created.
        </p>

        {hasDuplicateContent ? (
          <div className={styles.duplicateWarnings}>
            <p>Possible duplicate records were found.</p>
            {result.duplicateMatches.length > 0 ? (
              <ul className={styles.duplicateList}>
                {result.duplicateMatches.map((match) => (
                  <li key={`${match.type}-${match.id}`}>
                    {match.fullName} ({match.type === 'LEAD' ? 'Lead' : 'Client'}
                    {match.type === 'LEAD' ? `, ${LEAD_STATUS_LABELS[match.status]}` : ''}) —
                    matched on {match.matchedOn.join(' and ').toLowerCase()}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.restrictedMatchDetected ? (
              <p className={styles.duplicateRestrictedNotice}>
                Another possible matching record exists, but its details are unavailable to you.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className={styles.formActions}>
          <Link href={`/admin/leads/${result.lead.id}`}>View Lead</Link>
          <button type="button" onClick={handleCreateAnother}>
            Create another Lead
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={styles.leadForm} noValidate>
      {formError ? (
        <p role="alert" className={styles.formAlert}>
          {formError}
        </p>
      ) : null}

      <div className={styles.filterField}>
        <label htmlFor={fullNameId}>Full name</label>
        <input
          id={fullNameId}
          name="fullName"
          type="text"
          value={fields.fullName}
          onChange={(event) => updateField('fullName', event.target.value)}
          maxLength={FIELD_MAX_LENGTHS.fullName}
          aria-invalid={fieldErrors.fullName ? true : undefined}
          aria-describedby={fieldErrors.fullName ? `${fullNameId}-error` : undefined}
          required
        />
        {fieldErrors.fullName ? (
          <p id={`${fullNameId}-error`} className={styles.fieldError}>
            {fieldErrors.fullName}
          </p>
        ) : null}
      </div>

      <div className={styles.filterField}>
        <label htmlFor={sourceId}>Source</label>
        <input
          id={sourceId}
          name="source"
          type="text"
          value={fields.source}
          onChange={(event) => updateField('source', event.target.value)}
          maxLength={FIELD_MAX_LENGTHS.source}
          placeholder="e.g. Contact page, Phone, Walk-in"
          aria-invalid={fieldErrors.source ? true : undefined}
          aria-describedby={fieldErrors.source ? `${sourceId}-error` : undefined}
          required
        />
        {fieldErrors.source ? (
          <p id={`${sourceId}-error`} className={styles.fieldError}>
            {fieldErrors.source}
          </p>
        ) : null}
      </div>

      <div className={styles.filterField}>
        <label htmlFor={emailId}>Email</label>
        <input
          id={emailId}
          name="email"
          type="text"
          value={fields.email}
          onChange={(event) => updateField('email', event.target.value)}
          maxLength={FIELD_MAX_LENGTHS.email}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? `${emailId}-error` : undefined}
        />
        {fieldErrors.email ? (
          <p id={`${emailId}-error`} className={styles.fieldError}>
            {fieldErrors.email}
          </p>
        ) : null}
      </div>

      <div className={styles.filterField}>
        <label htmlFor={phoneId}>Phone</label>
        <input
          id={phoneId}
          name="phone"
          type="text"
          value={fields.phone}
          onChange={(event) => updateField('phone', event.target.value)}
          maxLength={FIELD_MAX_LENGTHS.phone}
          aria-invalid={fieldErrors.phone ? true : undefined}
          aria-describedby={fieldErrors.phone ? `${phoneId}-error` : undefined}
        />
        {fieldErrors.phone ? (
          <p id={`${phoneId}-error`} className={styles.fieldError}>
            {fieldErrors.phone}
          </p>
        ) : null}
      </div>

      <p className={styles.formHint}>Provide at least one of email or phone.</p>

      <div className={styles.filterField}>
        <label htmlFor={notesId}>Notes</label>
        <textarea
          id={notesId}
          name="notes"
          value={fields.notes}
          onChange={(event) => updateField('notes', event.target.value)}
          maxLength={FIELD_MAX_LENGTHS.notes}
          rows={4}
          aria-invalid={fieldErrors.notes ? true : undefined}
          aria-describedby={fieldErrors.notes ? `${notesId}-error` : undefined}
        />
        {fieldErrors.notes ? (
          <p id={`${notesId}-error`} className={styles.fieldError}>
            {fieldErrors.notes}
          </p>
        ) : null}
      </div>

      <div className={styles.formActions}>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create Lead'}
        </button>
      </div>
    </form>
  );
}
