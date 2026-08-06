'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../proposals.module.css';

// D-027 §5/§8's publish control: rendered by `ProposalVersionHistory` only
// for an eligible draft (not currently client-visible, not superseded) when
// the viewing actor is `TRAVEL_CONSULTANT` — this component itself accepts
// no role or user object, trusting only the three minimal props its parent
// already computed from the actor-scoped Proposal detail read.

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Local, minimal response shapes for this component's own use —
// deliberately not imported from features/proposals/repository.ts or
// features/proposals/service.ts (both server-only). This client component
// talks to `POST /api/proposals/versions/[id]/publish` only through
// `fetch`, mirroring CreateProposalRevisionPanel.tsx's identical
// discipline.
type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while publishing this version. Please check your connection and try again.';

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

type PublishSuccess = { version: { id: string } };

/**
 * Strict `200` response validation (Stage 7E §F.5): `version.id` must be a
 * nonblank string that exactly matches `versionId` — this button never
 * treats a response describing a different version as success for the
 * version it was rendered for, mirroring `CreateProposalPanel.tsx`'s/
 * `CreateProposalRevisionPanel.tsx`'s identical "never trust a conflicting
 * identifier" discipline.
 */
function isPublishSuccess(value: unknown, expectedVersionId: string): value is PublishSuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const version = candidate.version;
  if (!version || typeof version !== 'object' || Array.isArray(version)) return false;
  const versionCandidate = version as Record<string, unknown>;
  return isNonEmptyTrimmedString(versionCandidate.id) && versionCandidate.id === expectedVersionId;
}

export type PublishProposalVersionButtonProps = {
  versionId: string;
  versionNumber: number;
  /**
   * The observed current client-visible version id from the same rendered
   * Proposal detail snapshot this button is part of (`clientVisibleAt !==
   * null && supersededAt === null`), or `null` when no version is
   * currently client-visible — never the latest/highest-numbered version
   * merely because it appears first (D-027 §5/§6, Stage 7E §D.7-§D.10).
   * `ProposalVersionHistory` computes this once and passes the identical
   * value to every eligible draft's button on the page.
   */
  expectedCurrentVersionId: string | null;
};

/**
 * Publish action for a single eligible draft `ProposalVersion` (D-027 §5,
 * Stage 7E). Submits directly to the existing
 * `POST /api/proposals/versions/{versionId}/publish` — exactly one required
 * body key, `expectedCurrentVersionId`, sent as the caller-supplied prop
 * unchanged (present even when `null`; JSON.stringify never omits a key
 * whose value is `null`, only one whose value is `undefined`). An internal
 * `submitting` guard at the top of the submit handler, together with the
 * disabled pending button, protects this non-idempotent endpoint from a
 * duplicate in-flight request.
 *
 * On a validated `200` success, this component never navigates: it shows an
 * accessible `role="status"` confirmation, calls `router.refresh()` so the
 * Server Component reloads the authoritative version history (which will
 * stop rendering this exact button once the now-published version is no
 * longer an eligible draft), and disables itself permanently
 * (`justPublished`) so a stray extra click during the brief window before
 * that refreshed data lands can never issue a second, redundant publish
 * request — `router.push` is never called.
 *
 * `PROPOSAL_CONFLICT` (D-027 §5's own exact required refresh-and-retry
 * wording) is shown like any other controlled error message, but
 * additionally exposes a distinct, accessible "Refresh proposal" action
 * that calls only `router.refresh()` — a deliberate, user-triggered
 * re-fetch of the authoritative state, never an automatic retry and never
 * another publish request by itself. Every other controlled error
 * (`PROPOSAL_VERSION_FORBIDDEN`, `PROPOSAL_VERSION_SUPERSEDED`, a
 * role-forbidden/unauthenticated response, or a generic 500) already
 * carries a safe, server-crafted message, rendered verbatim; a malformed
 * JSON body, an incomplete/mismatched success body, or a network rejection
 * all fall back to the identical generic message. Nothing is ever logged:
 * no raw response body, version content, or exception is ever passed to
 * `console.*` anywhere in this component.
 */
export function PublishProposalVersionButton({
  versionId,
  versionNumber,
  expectedCurrentVersionId,
}: PublishProposalVersionButtonProps) {
  const router = useRouter();

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [justPublished, setJustPublished] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || justPublished) return;

    setFormError(null);
    setConflict(false);
    setSubmitting(true);

    try {
      const response = await fetch(`/api/proposals/versions/${versionId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedCurrentVersionId }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isPublishSuccess(body, versionId)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        setJustPublished(true);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      if (error.code === 'PROPOSAL_CONFLICT') {
        setConflict(true);
      }
      setFormError(error.message);
    } catch {
      setFormError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.publishAction} noValidate>
      {formError ? (
        <p role="alert" className={styles.formAlert}>
          {formError}
          {conflict ? (
            <>
              {' '}
              <button
                type="button"
                onClick={() => {
                  // A deliberate, user-triggered re-fetch only — this never
                  // resubmits the publish request on its own (Stage 7E
                  // §F.10).
                  router.refresh();
                }}
              >
                Refresh proposal
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {justPublished ? (
        <p role="status" className={styles.formSuccessAlert}>
          Version {versionNumber} published.
        </p>
      ) : null}
      <div className={styles.formActions}>
        <button type="submit" disabled={submitting || justPublished}>
          {submitting ? `Publishing Version ${versionNumber}…` : `Publish Version ${versionNumber}`}
        </button>
      </div>
    </form>
  );
}
