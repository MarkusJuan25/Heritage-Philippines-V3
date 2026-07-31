'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../clients.module.css';

// D-025 §5/§10's exact ordinary-field edit contract
// (features/clients/schemas.ts's updateClientSchema): all eight fields
// optional at the PATCH level — this client sends only the keys that
// actually changed, plus `expectedUpdatedAt` (always present, D-025 §7).
// `assignment`, `originatingLeads`, `createdAt`, `id`, `normalizedEmail`,
// and `normalizedPhone` are never part of this form's state or request body
// — updateClientSchema is `.strict()` and has no fields for any of them, so
// the server's own contract already forbids it; this form additionally
// never even constructs an object containing them.
type FieldName =
  | 'fullName'
  | 'email'
  | 'phone'
  | 'address'
  | 'nationality'
  | 'dateOfBirth'
  | 'emergencyContact'
  | 'notes';
type FormFields = Record<FieldName, string>;
type FieldErrors = Partial<Record<FieldName, string>>;

const FIELD_NAMES: readonly FieldName[] = [
  'fullName',
  'email',
  'phone',
  'address',
  'nationality',
  'dateOfBirth',
  'emergencyContact',
  'notes',
];
const FIELD_MAX_LENGTHS: Partial<Record<FieldName, number>> = {
  fullName: 200,
  email: 320,
  phone: 50,
  address: 500,
  nationality: 100,
  emergencyContact: 200,
  notes: 2000,
};

// Required-string fields must actually contain content, not just be the
// right JS type — a whitespace-only value is exactly as unusable as an
// empty one.
function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// email/phone/address/nationality/dateOfBirth/emergencyContact/notes are
// always either null (cleared) or a genuinely non-blank string — the
// server's own toNullIfBlank transform (and dateOfBirthSchema's null/''
// branch) guarantees a blank value is never stored as `''`.
function isNullableNonBlankString(value: unknown): value is string | null {
  return value === null || isNonEmptyTrimmedString(value);
}

function isIsoDatetimeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

// Local, minimal response shapes for this form's own use — deliberately not
// imported from features/clients/repository.ts or features/clients/service.ts
// (both server-only). This client component talks to `PATCH
// /api/clients/[id]` only through `fetch`, never a server-only service,
// repository, HTTP helper, or the generated Prisma runtime (D-025 §9/§10).
//
// A `LEAD`-type duplicate match's `status` is validated only as a
// non-empty string, never against the full Lead-status enum: mapping it to
// a human label would require importing
// admin/leads/_components/leadStatusLabels — reaching into another
// feature's UI internals, which .claude/rules/architecture.md's
// cross-feature-reuse discipline forbids. It renders as the raw status
// value instead (mirrors Stage F2's identical choice for
// originatingLeads' own status rendering).
type MatchedOn = 'EMAIL' | 'PHONE';
type DuplicateMatch =
  | { type: 'CLIENT'; id: string; fullName: string; matchedOn: MatchedOn[] }
  | { type: 'LEAD'; id: string; fullName: string; status: string; matchedOn: MatchedOn[] };

function isDuplicateMatch(value: unknown): value is DuplicateMatch {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;

  if (candidate.type !== 'LEAD' && candidate.type !== 'CLIENT') return false;
  if (!isNonEmptyTrimmedString(candidate.id)) return false;
  if (!isNonEmptyTrimmedString(candidate.fullName)) return false;
  if (!Array.isArray(candidate.matchedOn) || candidate.matchedOn.length === 0) return false;
  if (!candidate.matchedOn.every((entry) => entry === 'EMAIL' || entry === 'PHONE')) return false;

  if (candidate.type === 'LEAD') {
    return isNonEmptyTrimmedString(candidate.status);
  }
  // A CLIENT match must carry no status at all (D-025 §6).
  return candidate.status === undefined;
}

function isAssignmentSummary(
  value: unknown,
): value is { staffId: string; staffName: string } | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return isNonEmptyTrimmedString(candidate.staffId) && isNonEmptyTrimmedString(candidate.staffName);
}

type OriginatingLead = {
  id: string;
  fullName: string;
  status: string;
  source: string;
  createdAt: string;
};

function isOriginatingLead(value: unknown): value is OriginatingLead {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(candidate.id) &&
    isNonEmptyTrimmedString(candidate.fullName) &&
    isNonEmptyTrimmedString(candidate.status) &&
    isNonEmptyTrimmedString(candidate.source) &&
    isIsoDatetimeString(candidate.createdAt)
  );
}

// The FULL authoritative Client shape `PATCH /api/clients/[id]` returns
// (features/clients/service.ts's `UpdateClientResult` reuses the exact same
// `ClientDetailRecord` `GET` already returns — D-025 §4/§7) — this form
// validates the complete envelope, not only the eight fields it directly
// consumes, so a response malformed anywhere in the documented shape is
// treated as unsafe rather than partially trusted.
type ClientDetail = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  emergencyContact: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  assignment: { staffId: string; staffName: string } | null;
  originatingLeads: OriginatingLead[];
};

function isClientDetail(value: unknown): value is ClientDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(candidate.id) &&
    isNonEmptyTrimmedString(candidate.fullName) &&
    isNullableNonBlankString(candidate.email) &&
    isNullableNonBlankString(candidate.phone) &&
    isNullableNonBlankString(candidate.address) &&
    isNullableNonBlankString(candidate.nationality) &&
    isNullableNonBlankString(candidate.dateOfBirth) &&
    isNullableNonBlankString(candidate.emergencyContact) &&
    isNullableNonBlankString(candidate.notes) &&
    isIsoDatetimeString(candidate.createdAt) &&
    isIsoDatetimeString(candidate.updatedAt) &&
    isAssignmentSummary(candidate.assignment) &&
    Array.isArray(candidate.originatingLeads) &&
    candidate.originatingLeads.every(isOriginatingLead)
  );
}

// duplicateMatches/restrictedMatchDetected are present in the response only
// when the patch touched email or phone (features/clients/service.ts's
// `updateClient` — `Partial<DuplicateMatchResult>`), and always as a pair —
// never one present without the other (D-025 §6/§9).
type UpdateClientSuccess = {
  client: ClientDetail;
  duplicateMatches?: DuplicateMatch[];
  restrictedMatchDetected?: boolean;
};

function isUpdateClientSuccess(value: unknown): value is UpdateClientSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (!isClientDetail(candidate.client)) return false;

  const hasDuplicateMatches = Object.hasOwn(candidate, 'duplicateMatches');
  const hasRestrictedFlag = Object.hasOwn(candidate, 'restrictedMatchDetected');
  if (hasDuplicateMatches !== hasRestrictedFlag) return false;

  if (hasDuplicateMatches) {
    if (!Array.isArray(candidate.duplicateMatches)) return false;
    if (!candidate.duplicateMatches.every(isDuplicateMatch)) return false;
    if (typeof candidate.restrictedMatchDetected !== 'boolean') return false;
  }
  return true;
}

type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while saving this client. Please check your connection and try again.';

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
  email: string | null;
  phone: string | null;
  address: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  emergencyContact: string | null;
  notes: string | null;
}): FormFields {
  return {
    fullName: input.fullName,
    email: input.email ?? '',
    phone: input.phone ?? '',
    address: input.address ?? '',
    nationality: input.nationality ?? '',
    dateOfBirth: input.dateOfBirth ?? '',
    emergencyContact: input.emergencyContact ?? '',
    notes: input.notes ?? '',
  };
}

export type EditClientFormProps = {
  clientId: string;
  initialFullName: string;
  initialEmail: string | null;
  initialPhone: string | null;
  initialAddress: string | null;
  initialNationality: string | null;
  initialDateOfBirth: string | null;
  initialEmergencyContact: string | null;
  initialNotes: string | null;
  /** ISO-8601 UTC timestamp (`Date.prototype.toISOString()` form) — the
   * authoritative `updatedAt` this form sends back as `expectedUpdatedAt`
   * on every submission (D-025 §7). */
  initialUpdatedAt: string;
};

/**
 * Ordinary-field Client editing (D-025 §5/§10). Submits directly to the
 * existing `PATCH /api/clients/[id]` — only fields that changed from the
 * last confirmed server state are ever sent, alongside the current
 * authoritative `expectedUpdatedAt` (always present, D-025 §7), so an
 * unmodified form can never produce a request with no editable field.
 * Client validation here is advisory only (fullName non-blank); the
 * server's own `updateClientSchema` and service-layer invariants remain
 * authoritative. The current assignment and Originating Leads remain
 * read-only, rendered by the parent page outside this form (D-025 §10 —
 * this stage adds no assignment controls).
 *
 * A successful response's `client` becomes the new confirmed baseline for
 * every field this form owns, and its `updatedAt` becomes the token the
 * very next submission sends — never a value derived from what was
 * submitted (D-025 §7's optimistic-concurrency contract). `router.refresh()`
 * additionally re-fetches the surrounding Server Component (assignment,
 * Originating Leads, Created/Last updated) — the returned `client` above is
 * always applied first and synchronously, never awaited before updating
 * this form's own visible state.
 *
 * On `CLIENT_CONFLICT`, this form never resubmits or overwrites on its own:
 * it shows the server's own message and disables Save until BOTH the user
 * has explicitly clicked "Refresh and try again" AND the parent's
 * authoritative props actually reflect a fresh read (the render-time check
 * below requires both) — recovery never happens from a prop change alone,
 * and the button itself never does anything but request that refresh.
 */
export function EditClientForm({
  clientId,
  initialFullName,
  initialEmail,
  initialPhone,
  initialAddress,
  initialNationality,
  initialDateOfBirth,
  initialEmergencyContact,
  initialNotes,
  initialUpdatedAt,
}: EditClientFormProps) {
  const router = useRouter();
  const initialFields = toFormFields({
    fullName: initialFullName,
    email: initialEmail,
    phone: initialPhone,
    address: initialAddress,
    nationality: initialNationality,
    dateOfBirth: initialDateOfBirth,
    emergencyContact: initialEmergencyContact,
    notes: initialNotes,
  });

  const [baseline, setBaseline] = useState<FormFields>(initialFields);
  const [fields, setFields] = useState<FormFields>(initialFields);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(initialUpdatedAt);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  // True only once the user has explicitly clicked "Refresh and try
  // again" for the CURRENT conflict — never set as a side effect of the
  // conflict itself. This is what makes recovery require that explicit
  // click rather than firing the instant `setConflict(true)` happens to
  // run on a render where the parent's props already differ from what was
  // rejected (e.g. because an unrelated earlier `router.refresh()` — the
  // ordinary post-save one from a PRIOR, unrelated submission — already
  // landed with newer props before this conflict was even shown).
  const [conflictRefreshRequested, setConflictRefreshRequested] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([]);
  const [restrictedMatchDetected, setRestrictedMatchDetected] = useState(false);

  // Reserved for explicit CLIENT_CONFLICT recovery ONLY — never for the
  // ordinary post-save path. Requires all three:
  //   1. `conflict` — this form is stuck after a rejected submission;
  //   2. `conflictRefreshRequested` — the user has explicitly clicked
  //      "Refresh and try again" for THIS conflict (set only there, never
  //      elsewhere);
  //   3. `initialUpdatedAt !== expectedUpdatedAt` — the parent's prop no
  //      longer matches the value the server just rejected, i.e. a
  //      genuinely fresh read has actually arrived.
  // If (3) is already true at the moment (2) becomes true — the parent
  // already held newer props before the click — this fires on the very
  // next render, immediately after that click. If the parent still has
  // the rejected timestamp, this stays false and the form remains
  // conflict-locked until a later render finally satisfies (3).
  //
  // Gating on `conflict`/`conflictRefreshRequested` (never on prop change
  // alone) is exactly what keeps this safe for the ordinary post-save
  // case: a successful submission updates `expectedUpdatedAt` immediately
  // and synchronously (in the submit handler, before `router.refresh()` is
  // even called) but never touches `conflict`, so while the parent's
  // props are still catching up to that same value in the background,
  // this check short-circuits and never touches `fields` — an
  // in-progress second edit made in that window survives untouched.
  //
  // Follows React's own "Adjusting state when a prop changes" pattern (a
  // conditional setState call during render) rather than a `useEffect` —
  // ESLint's `react-hooks/set-state-in-effect` rule forbids the
  // effect-based version, and this pattern also avoids the extra
  // render/commit cycle an effect would incur.
  if (conflict && conflictRefreshRequested && initialUpdatedAt !== expectedUpdatedAt) {
    setBaseline(initialFields);
    setFields(initialFields);
    setExpectedUpdatedAt(initialUpdatedAt);
    setConflict(false);
    setConflictRefreshRequested(false);
    // The conflict alert (and any other transient validation state)
    // describes the rejected submission against the OLD baseline — it no
    // longer applies once the parent has supplied a genuinely fresh
    // authoritative read to reset against.
    setFormError(null);
    setFieldErrors({});
  }

  const fullNameId = useId();
  const emailId = useId();
  const phoneId = useId();
  const addressId = useId();
  const nationalityId = useId();
  const dateOfBirthId = useId();
  const emergencyContactId = useId();
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
    return errors;
  }

  // Maps a VALIDATION_ERROR's `details` to this form's fields where the
  // path matches one of the eight known field names, and folds every other
  // path (including the server's own "at least one of email or phone"
  // invariant, which carries no `details` at all) into the form-level
  // alert instead of silently dropping it.
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
    if (submitting || conflict) return;

    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      // Never submit a request with no editable field changed.
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
      const response = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, expectedUpdatedAt }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isUpdateClientSuccess(body)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        // Never assume success from the submitted values alone — the
        // confirmed server response becomes the new baseline, including a
        // fresh `expectedUpdatedAt` for the next submission.
        const nextBaseline = toFormFields(body.client);
        setBaseline(nextBaseline);
        setFields(nextBaseline);
        setExpectedUpdatedAt(body.client.updatedAt);
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
      if (error.code === 'CLIENT_CONFLICT') {
        setFormError(error.message);
        setConflict(true);
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

  const isDirty = FIELD_NAMES.some((name) => fields[name] !== baseline[name]);
  const hasDuplicateContent = duplicateMatches.length > 0 || restrictedMatchDetected;

  return (
    <form onSubmit={handleSubmit} className={styles.clientForm} noValidate>
      {formError ? (
        <p role="alert" className={styles.formAlert}>
          {formError}
          {conflict ? (
            <>
              {' '}
              <button
                type="button"
                onClick={() => {
                  // Only records the explicit request and re-fetches — it
                  // never submits the rejected patch again on its own, and
                  // never resets any state directly itself; the render-time
                  // check above is solely responsible for actually applying
                  // a reset, and only once fresh props confirm it's safe to.
                  setConflictRefreshRequested(true);
                  router.refresh();
                }}
              >
                Refresh and try again
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {justSaved ? (
        <p role="status" className={styles.formSuccessAlert}>
          Client updated.
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
                  {match.type === 'LEAD' ? `, ${match.status}` : ''}) — matched on{' '}
                  {match.matchedOn.join(' and ').toLowerCase()}
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
          disabled={submitting || conflict}
          required
        />
        {fieldErrors.fullName ? (
          <p id={`${fullNameId}-error`} className={styles.fieldError}>
            {fieldErrors.fullName}
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
          disabled={submitting || conflict}
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
          disabled={submitting || conflict}
        />
        {fieldErrors.phone ? (
          <p id={`${phoneId}-error`} className={styles.fieldError}>
            {fieldErrors.phone}
          </p>
        ) : null}
      </div>

      <div className={styles.filterField}>
        <label htmlFor={addressId}>Address</label>
        <input
          id={addressId}
          name="address"
          type="text"
          value={fields.address}
          onChange={(event) => updateField('address', event.target.value)}
          maxLength={FIELD_MAX_LENGTHS.address}
          aria-invalid={fieldErrors.address ? true : undefined}
          aria-describedby={fieldErrors.address ? `${addressId}-error` : undefined}
          disabled={submitting || conflict}
        />
        {fieldErrors.address ? (
          <p id={`${addressId}-error`} className={styles.fieldError}>
            {fieldErrors.address}
          </p>
        ) : null}
      </div>

      <div className={styles.filterField}>
        <label htmlFor={nationalityId}>Nationality</label>
        <input
          id={nationalityId}
          name="nationality"
          type="text"
          value={fields.nationality}
          onChange={(event) => updateField('nationality', event.target.value)}
          maxLength={FIELD_MAX_LENGTHS.nationality}
          aria-invalid={fieldErrors.nationality ? true : undefined}
          aria-describedby={fieldErrors.nationality ? `${nationalityId}-error` : undefined}
          disabled={submitting || conflict}
        />
        {fieldErrors.nationality ? (
          <p id={`${nationalityId}-error`} className={styles.fieldError}>
            {fieldErrors.nationality}
          </p>
        ) : null}
      </div>

      <div className={styles.filterField}>
        <label htmlFor={dateOfBirthId}>Date of birth</label>
        <input
          id={dateOfBirthId}
          name="dateOfBirth"
          type="date"
          value={fields.dateOfBirth}
          onChange={(event) => updateField('dateOfBirth', event.target.value)}
          aria-invalid={fieldErrors.dateOfBirth ? true : undefined}
          aria-describedby={fieldErrors.dateOfBirth ? `${dateOfBirthId}-error` : undefined}
          disabled={submitting || conflict}
        />
        {fieldErrors.dateOfBirth ? (
          <p id={`${dateOfBirthId}-error`} className={styles.fieldError}>
            {fieldErrors.dateOfBirth}
          </p>
        ) : null}
      </div>

      <div className={styles.filterField}>
        <label htmlFor={emergencyContactId}>Emergency contact</label>
        <input
          id={emergencyContactId}
          name="emergencyContact"
          type="text"
          value={fields.emergencyContact}
          onChange={(event) => updateField('emergencyContact', event.target.value)}
          maxLength={FIELD_MAX_LENGTHS.emergencyContact}
          aria-invalid={fieldErrors.emergencyContact ? true : undefined}
          aria-describedby={
            fieldErrors.emergencyContact ? `${emergencyContactId}-error` : undefined
          }
          disabled={submitting || conflict}
        />
        {fieldErrors.emergencyContact ? (
          <p id={`${emergencyContactId}-error`} className={styles.fieldError}>
            {fieldErrors.emergencyContact}
          </p>
        ) : null}
      </div>

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
          disabled={submitting || conflict}
        />
        {fieldErrors.notes ? (
          <p id={`${notesId}-error`} className={styles.fieldError}>
            {fieldErrors.notes}
          </p>
        ) : null}
      </div>

      <div className={styles.formActions}>
        <button type="submit" disabled={submitting || !isDirty || conflict}>
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
