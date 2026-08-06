'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../proposals.module.css';

// D-027 §7/§9.1's externally-received-response control: rendered by
// `ProposalVersionHistory` only for the current client-visible version
// (`clientVisibleAt !== null && supersededAt === null`) that has no
// recorded response yet (`acceptance === null`), and only when the viewing
// actor is `ADMIN_MANAGER` or `TRAVEL_CONSULTANT` — this component itself
// accepts no role or user object, trusting only the minimal props its
// parent already computed from the actor-scoped Proposal detail read.

const RESPONSE_TYPE_OPTIONS = [
  { value: 'ACCEPT', label: 'Accept' },
  { value: 'DECLINE', label: 'Decline' },
  { value: 'REQUEST_CHANGES', label: 'Request Changes' },
] as const;

type ResponseTypeValue = (typeof RESPONSE_TYPE_OPTIONS)[number]['value'];

const RESPONSE_METHOD_MAX_LENGTH = 100;
const EVIDENCE_REFERENCE_MAX_LENGTH = 500;

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Local, minimal response shapes for this component's own use —
// deliberately not imported from features/proposals/repository.ts or
// features/proposals/service.ts (both server-only). This client component
// talks to `POST /api/proposals/versions/[id]/response` only through
// `fetch`, mirroring PublishProposalVersionButton.tsx's/
// CreateProposalRevisionPanel.tsx's identical discipline.
type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while recording this response. Please check your connection and try again.';

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

type RecordResponseSuccess = { acceptance: { id: string; proposalVersionId: string } };

/**
 * Strict `200` response validation (Stage 7F §E): `acceptance` must exist,
 * `acceptance.id` must be a nonblank string, and — unlike
 * `PublishProposalVersionButton.tsx`'s optional cross-check —
 * `acceptance.proposalVersionId` is unconditionally required to exactly
 * match the submitted `versionId`, matching D-027 §9.1's `ProposalAcceptance`
 * shape (`proposalVersionId` is always present on this record) exactly.
 */
function isRecordResponseSuccess(
  value: unknown,
  expectedVersionId: string,
): value is RecordResponseSuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const acceptance = candidate.acceptance;
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) return false;
  const acceptanceCandidate = acceptance as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(acceptanceCandidate.id) &&
    acceptanceCandidate.proposalVersionId === expectedVersionId
  );
}

type FieldErrors = {
  responseType?: string;
  respondedAt?: string;
  responseMethod?: string;
  evidenceReference?: string;
};

export type RecordProposalResponsePanelProps = {
  versionId: string;
  versionNumber: number;
};

/**
 * Records a Section 9.1 externally received Accept/Decline/Request Changes
 * response (D-027 §4/§7/§9.1, Stage 7F). Submits directly to the existing
 * `POST /api/proposals/versions/{versionId}/response` — exactly the four
 * required body keys (`responseType`, `respondedAt`, `responseMethod`,
 * `evidenceReference`), matching `recordProposalResponseSchema`'s exact
 * `.strict()` contract; never `expectedCurrentVersionId`, role information,
 * or Proposal content. `respondedAt` is entered via a `datetime-local`
 * input (the client's local wall-clock time) and converted to a
 * timezone-aware ISO-8601 string (`new Date(...).toISOString()`, always
 * `Z`-suffixed) immediately before submission — the schema's own
 * `z.iso.datetime({ offset: true })` requires some timezone marker, which a
 * bare `datetime-local` value never carries on its own.
 *
 * Every validation branch (required response type, a parseable non-empty
 * timestamp, a trimmed non-blank response method of at most 100 characters,
 * a trimmed non-blank evidence reference of at most 500 characters) runs
 * inside `handleSubmit` itself — never relying on HTML5 constraint
 * validation alone (`noValidate` is set) — so a direct `form.submit()` or
 * synthesized submit event can never bypass it. An internal `submitting`
 * guard at the very first line of the handler, together with the disabled
 * pending button, protects this endpoint from a duplicate in-flight
 * request.
 *
 * On a validated `200` success, this component never navigates: it shows
 * an accessible `role="status"` confirmation, calls `router.refresh()` (so
 * the Server Component reloads the authoritative version/response state —
 * `router.push` is never called), and disables itself permanently
 * (`justRecorded`) so a stray extra click during the brief window before
 * that refreshed data lands can never issue a second, redundant response
 * recording — this endpoint's own `ProposalAcceptance.proposalVersionId
 * @unique` constraint (D-027 §4/§7) already makes a genuine duplicate
 * impossible server-side, but this component never relies on that alone.
 *
 * `PROPOSAL_RESPONSE_ALREADY_RECORDED` and `PROPOSAL_VERSION_NOT_CURRENT`
 * both indicate this exact panel's target state has become genuinely stale
 * (a response already exists, or this is no longer the current
 * client-visible version) — the regular submit action is disabled for
 * either, and a distinct, accessible "Refresh proposal" action appears that
 * calls only `router.refresh()`, never resubmitting the response by
 * itself. `PROPOSAL_CONFLICT` is shown like any other controlled error
 * message but leaves the regular submit action enabled, permitting a
 * deliberate manual retry — never an automatic resubmission. Every other
 * controlled error (`PROPOSAL_VERSION_FORBIDDEN`, `PROPOSAL_VERSION_NOT_FOUND`,
 * a role-forbidden/unauthenticated response, or a generic 500) already
 * carries a safe, server-crafted message, rendered verbatim; a malformed
 * JSON body, an incomplete/mismatched success body, or a network rejection
 * all fall back to the identical generic message, and the entered field
 * values are always preserved for retry. Nothing is ever logged: no raw
 * response body, evidence value, or exception is ever passed to
 * `console.*` anywhere in this component.
 */
export function RecordProposalResponsePanel({
  versionId,
  versionNumber,
}: RecordProposalResponsePanelProps) {
  const router = useRouter();

  const [responseType, setResponseType] = useState<ResponseTypeValue | ''>('');
  const [respondedAt, setRespondedAt] = useState('');
  const [responseMethod, setResponseMethod] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justRecorded, setJustRecorded] = useState(false);
  const [refreshOnly, setRefreshOnly] = useState(false);

  const responseTypeId = useId();
  const respondedAtId = useId();
  const responseMethodId = useId();
  const evidenceReferenceId = useId();
  const evidenceHintId = `${evidenceReferenceId}-hint`;

  const disabled = submitting || justRecorded || refreshOnly;

  function clearFieldError(name: keyof FieldErrors) {
    setFieldErrors((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  function validate(): { valid: true; respondedAtIso: string } | { valid: false } {
    const errors: FieldErrors = {};

    if (!responseType) {
      errors.responseType = 'Select a response.';
    }

    let respondedAtIso = '';
    if (!respondedAt) {
      errors.respondedAt = 'Enter the date and time the client responded.';
    } else {
      const parsed = new Date(respondedAt);
      if (Number.isNaN(parsed.getTime())) {
        errors.respondedAt = 'Enter a valid date and time.';
      } else {
        respondedAtIso = parsed.toISOString();
      }
    }

    const trimmedMethod = responseMethod.trim();
    if (trimmedMethod.length === 0) {
      errors.responseMethod = 'Response method is required.';
    } else if (trimmedMethod.length > RESPONSE_METHOD_MAX_LENGTH) {
      errors.responseMethod = 'Response method must be at most 100 characters.';
    }

    const trimmedEvidence = evidenceReference.trim();
    if (trimmedEvidence.length === 0) {
      errors.evidenceReference = 'Evidence reference is required.';
    } else if (trimmedEvidence.length > EVIDENCE_REFERENCE_MAX_LENGTH) {
      errors.evidenceReference = 'Evidence reference must be at most 500 characters.';
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return { valid: false };
    }
    return { valid: true, respondedAtIso };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || disabled) return;

    setFormError(null);
    const result = validate();
    if (!result.valid) {
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch(`/api/proposals/versions/${versionId}/response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          responseType,
          respondedAt: result.respondedAtIso,
          responseMethod: responseMethod.trim(),
          evidenceReference: evidenceReference.trim(),
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
        if (!isRecordResponseSuccess(body, versionId)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        setJustRecorded(true);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      if (
        error.code === 'PROPOSAL_RESPONSE_ALREADY_RECORDED' ||
        error.code === 'PROPOSAL_VERSION_NOT_CURRENT'
      ) {
        setRefreshOnly(true);
      }
      setFormError(error.message);
    } catch {
      setFormError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.responseAction}>
      <h4>Record Client Response</h4>
      <p>
        This records the client&rsquo;s response to Version {versionNumber} once. It cannot be
        edited, replaced, or undone.
      </p>

      <form onSubmit={handleSubmit} className={styles.revisionForm} noValidate>
        {formError ? (
          <p role="alert" className={styles.formAlert}>
            {formError}
            {refreshOnly ? (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => {
                    // A deliberate, user-triggered re-fetch only — this
                    // never resubmits the response on its own.
                    router.refresh();
                  }}
                >
                  Refresh proposal
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {justRecorded ? (
          <p role="status" className={styles.formSuccessAlert}>
            Response recorded for Version {versionNumber}.
          </p>
        ) : null}

        <div className={styles.formField}>
          <label htmlFor={responseTypeId}>Response</label>
          <select
            id={responseTypeId}
            value={responseType}
            onChange={(event) => {
              setResponseType(event.target.value as ResponseTypeValue | '');
              clearFieldError('responseType');
              setFormError(null);
            }}
            aria-invalid={fieldErrors.responseType ? true : undefined}
            aria-describedby={fieldErrors.responseType ? `${responseTypeId}-error` : undefined}
            disabled={disabled}
            required
          >
            <option value="">Select a response…</option>
            {RESPONSE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {fieldErrors.responseType ? (
            <p id={`${responseTypeId}-error`} className={styles.fieldError}>
              {fieldErrors.responseType}
            </p>
          ) : null}
        </div>

        <div className={styles.formField}>
          <label htmlFor={respondedAtId}>Client responded at</label>
          <input
            id={respondedAtId}
            type="datetime-local"
            value={respondedAt}
            onChange={(event) => {
              setRespondedAt(event.target.value);
              clearFieldError('respondedAt');
              setFormError(null);
            }}
            aria-invalid={fieldErrors.respondedAt ? true : undefined}
            aria-describedby={fieldErrors.respondedAt ? `${respondedAtId}-error` : undefined}
            disabled={disabled}
            required
          />
          {fieldErrors.respondedAt ? (
            <p id={`${respondedAtId}-error`} className={styles.fieldError}>
              {fieldErrors.respondedAt}
            </p>
          ) : null}
        </div>

        <div className={styles.formField}>
          <label htmlFor={responseMethodId}>Response method</label>
          <input
            id={responseMethodId}
            type="text"
            value={responseMethod}
            onChange={(event) => {
              setResponseMethod(event.target.value);
              clearFieldError('responseMethod');
              setFormError(null);
            }}
            maxLength={RESPONSE_METHOD_MAX_LENGTH}
            aria-invalid={fieldErrors.responseMethod ? true : undefined}
            aria-describedby={fieldErrors.responseMethod ? `${responseMethodId}-error` : undefined}
            disabled={disabled}
            required
          />
          {fieldErrors.responseMethod ? (
            <p id={`${responseMethodId}-error`} className={styles.fieldError}>
              {fieldErrors.responseMethod}
            </p>
          ) : null}
        </div>

        <div className={styles.formField}>
          <label htmlFor={evidenceReferenceId}>Evidence reference</label>
          <textarea
            id={evidenceReferenceId}
            value={evidenceReference}
            onChange={(event) => {
              setEvidenceReference(event.target.value);
              clearFieldError('evidenceReference');
              setFormError(null);
            }}
            maxLength={EVIDENCE_REFERENCE_MAX_LENGTH}
            rows={2}
            aria-invalid={fieldErrors.evidenceReference ? true : undefined}
            aria-describedby={
              fieldErrors.evidenceReference
                ? `${evidenceHintId} ${evidenceReferenceId}-error`
                : evidenceHintId
            }
            disabled={disabled}
            required
          />
          <p id={evidenceHintId}>
            A reference or pointer only (e.g. a call log ID, or an email subject and date) — not
            pasted correspondence or an uploaded file.
          </p>
          {fieldErrors.evidenceReference ? (
            <p id={`${evidenceReferenceId}-error`} className={styles.fieldError}>
              {fieldErrors.evidenceReference}
            </p>
          ) : null}
        </div>

        <div className={styles.formActions}>
          <button type="submit" disabled={disabled}>
            {submitting
              ? `Recording Response for Version ${versionNumber}…`
              : `Record Response for Version ${versionNumber}`}
          </button>
        </div>
      </form>
    </div>
  );
}
