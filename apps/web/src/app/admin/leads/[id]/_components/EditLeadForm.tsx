'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { LEAD_STATUS_LABELS } from '../../_components/leadStatusLabels';
import styles from '../../leads.module.css';

// D-022 §3's exact ordinary-field edit contract (features/leads/schemas.ts's
// updateLeadSchema): all five fields optional at the PATCH level — this
// client sends only the keys that actually changed. `status` is never part
// of this form's state or request body; updateLeadSchema has no `status`
// field at all, so the server's own lifecycle rules can never be bypassed
// from here.
type FieldName = 'fullName' | 'source' | 'email' | 'phone' | 'notes';
type FormFields = Record<FieldName, string>;
type FieldErrors = Partial<Record<FieldName, string>>;

const FIELD_NAMES: readonly FieldName[] = ['fullName', 'source', 'email', 'phone', 'notes'];
const FIELD_MAX_LENGTHS: Record<FieldName, number> = {
  fullName: 200,
  source: 200,
  email: 320,
  phone: 50,
  notes: 2000,
};

// A client-safe Lead-status type derived from the existing, already
// client-safe LEAD_STATUS_LABELS map — never the generated Prisma
// `LeadStatus` type, which this client component must not import (D-023
// §9/§10).
type LeadStatusKey = keyof typeof LEAD_STATUS_LABELS;

function isValidLeadStatus(value: unknown): value is LeadStatusKey {
  // `Object.hasOwn`, not `in` — `in` also matches inherited
  // Object.prototype properties (e.g. "toString", "constructor",
  // "__proto__"), which are not real LeadStatus values.
  return typeof value === 'string' && Object.hasOwn(LEAD_STATUS_LABELS, value);
}

// Required-string fields must actually contain content, not just be the
// right JS type — a whitespace-only value is exactly as unusable as an
// empty one.
function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// email/phone/notes are always either null (cleared) or a genuinely
// non-blank string — the server's own toNullIfBlank transform guarantees a
// blank value is never stored as `''`.
function isNullableNonBlankString(value: unknown): value is string | null {
  return value === null || isNonEmptyTrimmedString(value);
}

// Local, minimal response shapes for this form's own use — deliberately not
// imported from features/leads/repository.ts or features/leads/service.ts
// (both server-only). This client component talks to PATCH /api/leads/[id]
// only through `fetch`, never a server-only service, repository, HTTP
// helper, or the generated Prisma runtime (D-023 §9/§10). Mirrors
// NewLeadForm.tsx's identical duplicate-match shape and validation
// discipline exactly (D-022 §5).
type MatchedOn = 'EMAIL' | 'PHONE';
type DuplicateMatch =
  | { type: 'LEAD'; id: string; fullName: string; status: LeadStatusKey; matchedOn: MatchedOn[] }
  | { type: 'CLIENT'; id: string; fullName: string; matchedOn: MatchedOn[] };

function isDuplicateMatch(value: unknown): value is DuplicateMatch {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;

  if (candidate.type !== 'LEAD' && candidate.type !== 'CLIENT') return false;
  if (!isNonEmptyTrimmedString(candidate.id)) return false;
  if (!isNonEmptyTrimmedString(candidate.fullName)) return false;
  if (!Array.isArray(candidate.matchedOn) || candidate.matchedOn.length === 0) return false;
  if (!candidate.matchedOn.every((entry) => entry === 'EMAIL' || entry === 'PHONE')) return false;

  if (candidate.type === 'LEAD') {
    return isValidLeadStatus(candidate.status);
  }
  // A CLIENT match must carry no Lead status at all (D-022 §5).
  return candidate.status === undefined;
}

type UpdatedLead = {
  id: string;
  fullName: string;
  source: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
};

// duplicateMatches/restrictedMatchDetected are present in the response only
// when the patch touched email or phone (features/leads/service.ts's
// `updateLead` — `Partial<DuplicateMatchResult>`), never unconditionally.
type UpdateLeadSuccess = {
  lead: UpdatedLead;
  duplicateMatches?: DuplicateMatch[];
  restrictedMatchDetected?: boolean;
};

type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while saving this lead. Please check your connection and try again.';

// Shared verbatim with validateClientSide's own message below and with the
// server's identical refine message (features/leads/schemas.ts's
// createLeadSchema/updateLeadSchema `path: ['email']`) — used to recognize
// this specific error later so an edit to *either* contact field can clear
// it, not just an edit to `email` (the key it happens to be stored under).
const EMAIL_OR_PHONE_REQUIRED_MESSAGE = 'At least one of email or phone is required.';

function isUpdatedLead(value: unknown): value is UpdatedLead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(candidate.id) &&
    isNonEmptyTrimmedString(candidate.fullName) &&
    isNonEmptyTrimmedString(candidate.source) &&
    isNullableNonBlankString(candidate.email) &&
    isNullableNonBlankString(candidate.phone) &&
    isNullableNonBlankString(candidate.notes)
  );
}

function isUpdateLeadSuccess(value: unknown): value is UpdateLeadSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!isUpdatedLead(candidate.lead)) return false;

  if (candidate.duplicateMatches !== undefined) {
    if (!Array.isArray(candidate.duplicateMatches)) return false;
    if (!candidate.duplicateMatches.every(isDuplicateMatch)) return false;
  }
  if (candidate.restrictedMatchDetected !== undefined) {
    if (typeof candidate.restrictedMatchDetected !== 'boolean') return false;
  }
  return true;
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

function toFormFields(input: {
  fullName: string;
  source: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
}): FormFields {
  return {
    fullName: input.fullName,
    source: input.source,
    email: input.email ?? '',
    phone: input.phone ?? '',
    notes: input.notes ?? '',
  };
}

export type EditLeadFormProps = {
  leadId: string;
  initialFullName: string;
  initialSource: string;
  initialEmail: string | null;
  initialPhone: string | null;
  initialNotes: string | null;
  initiallyLocked: boolean;
};

/**
 * Ordinary-field Lead editing (D-022 §3; D-023 §4). Submits directly to the
 * existing `PATCH /api/leads/[id]` — only fields that changed from the last
 * confirmed server state are ever sent, so an unmodified form can never
 * produce an empty PATCH. Client validation here is advisory only; the
 * server's own `updateLeadSchema` and service-layer invariants remain
 * authoritative.
 */
export function EditLeadForm({
  leadId,
  initialFullName,
  initialSource,
  initialEmail,
  initialPhone,
  initialNotes,
  initiallyLocked,
}: EditLeadFormProps) {
  const router = useRouter();
  const initialFields = toFormFields({
    fullName: initialFullName,
    source: initialSource,
    email: initialEmail,
    phone: initialPhone,
    notes: initialNotes,
  });

  const [baseline, setBaseline] = useState<FormFields>(initialFields);
  const [fields, setFields] = useState<FormFields>(initialFields);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [locked, setLocked] = useState(initiallyLocked);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([]);
  const [restrictedMatchDetected, setRestrictedMatchDetected] = useState(false);

  const fullNameId = useId();
  const sourceId = useId();
  const emailId = useId();
  const phoneId = useId();
  const notesId = useId();

  function updateField(name: FieldName, value: string) {
    setFields((current) => ({ ...current, [name]: value }));
    setJustSaved(false);
    setDuplicateMatches([]);
    setRestrictedMatchDetected(false);
    // Stale errors describe the value as it was at last validation, not as
    // the user is now editing it — clear both the form-level alert (the
    // user is actively correcting the form) and this field's own error.
    setFormError(null);
    setFieldErrors((current) => {
      if (Object.keys(current).length === 0) return current;
      const next = { ...current };
      delete next[name];
      // The "at least one of email or phone" error is stored under the
      // `email` key (validateClientSide's/the server's own convention) but
      // is jointly determined by both fields — editing `phone` can resolve
      // it exactly as editing `email` can, so it must clear either way.
      if (
        (name === 'email' || name === 'phone') &&
        next.email === EMAIL_OR_PHONE_REQUIRED_MESSAGE
      ) {
        delete next.email;
      }
      return next;
    });
  }

  function buildPatch(): Partial<Record<FieldName, string>> {
    const patch: Partial<Record<FieldName, string>> = {};
    for (const name of FIELD_NAMES) {
      if (fields[name] !== baseline[name]) {
        patch[name] = fields[name];
      }
    }
    return patch;
  }

  function validateClientSide(patch: Partial<Record<FieldName, string>>): FieldErrors {
    const errors: FieldErrors = {};
    if (Object.hasOwn(patch, 'fullName') && fields.fullName.trim().length === 0) {
      errors.fullName = 'Full name is required.';
    }
    if (Object.hasOwn(patch, 'source') && fields.source.trim().length === 0) {
      errors.source = 'Source is required.';
    }
    const finalEmail = Object.hasOwn(patch, 'email') ? fields.email : baseline.email;
    const finalPhone = Object.hasOwn(patch, 'phone') ? fields.phone : baseline.phone;
    if (finalEmail.trim().length === 0 && finalPhone.trim().length === 0) {
      errors.email = EMAIL_OR_PHONE_REQUIRED_MESSAGE;
    }
    return errors;
  }

  // Maps a VALIDATION_ERROR's `details` to this form's fields where the
  // path matches one of the five known field names, and folds every other
  // path into the form-level alert instead of silently dropping it.
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
    if (submitting || locked) return;

    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      // Never submit an empty PATCH request.
      return;
    }

    const clientErrors = validateClientSide(patch);
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      setFormError(null);
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setJustSaved(false);
    setSubmitting(true);

    try {
      const response = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isUpdateLeadSuccess(body)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        // Never assume success from the submitted values alone — the
        // confirmed server response becomes the new baseline.
        const nextBaseline = toFormFields(body.lead);
        setBaseline(nextBaseline);
        setFields(nextBaseline);
        setDuplicateMatches(body.duplicateMatches ?? []);
        setRestrictedMatchDetected(body.restrictedMatchDetected ?? false);
        setJustSaved(true);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      if (error.code === 'LEAD_LOCKED') {
        setLocked(true);
        return;
      }
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

  if (locked) {
    // Locked (CONVERTED_TO_CLIENT) Lead: no editable controls, but Source,
    // Email, Phone, and Notes remain visible as read-only values — the last
    // confirmed server state (`baseline`), never unsaved/rejected input.
    return (
      <div className={styles.lockedNotice}>
        <p>This lead has been converted to a client and can no longer be edited.</p>
        <dl className={styles.detailFields}>
          <div className={styles.detailField}>
            <dt>Source</dt>
            <dd>{baseline.source}</dd>
          </div>
          <div className={styles.detailField}>
            <dt>Email</dt>
            <dd>{baseline.email || '—'}</dd>
          </div>
          <div className={styles.detailField}>
            <dt>Phone</dt>
            <dd>{baseline.phone || '—'}</dd>
          </div>
          <div className={styles.detailField}>
            <dt>Notes</dt>
            <dd>{baseline.notes || '—'}</dd>
          </div>
        </dl>
      </div>
    );
  }

  const isDirty = FIELD_NAMES.some((name) => fields[name] !== baseline[name]);
  const hasDuplicateContent = duplicateMatches.length > 0 || restrictedMatchDetected;

  return (
    <form onSubmit={handleSubmit} className={styles.leadForm} noValidate>
      {formError ? (
        <p role="alert" className={styles.formAlert}>
          {formError}
        </p>
      ) : null}
      {justSaved ? (
        <p role="status" className={styles.formSuccessAlert}>
          Lead updated.
        </p>
      ) : null}

      {hasDuplicateContent ? (
        <div className={styles.duplicateWarnings}>
          <p>Possible duplicate records were found.</p>
          {duplicateMatches.length > 0 ? (
            <ul className={styles.duplicateList}>
              {duplicateMatches.map((match) => (
                <li key={`${match.type}-${match.id}`}>
                  {match.fullName} ({match.type === 'LEAD' ? 'Lead' : 'Client'}
                  {match.type === 'LEAD' ? `, ${LEAD_STATUS_LABELS[match.status]}` : ''}) — matched
                  on {match.matchedOn.join(' and ').toLowerCase()}
                </li>
              ))}
            </ul>
          ) : null}
          {restrictedMatchDetected ? (
            <p className={styles.duplicateRestrictedNotice}>
              Another possible matching record exists, but its details are unavailable to you.
            </p>
          ) : null}
        </div>
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
        <button type="submit" disabled={submitting || !isDirty}>
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
