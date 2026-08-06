'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../proposals.module.css';

// D-027 §8's revision-creation control: rendered by
// admin/proposals/[id]/page.tsx only for a TRAVEL_CONSULTANT viewing a
// Proposal they are already authorized to see (that page's own existing
// Layer 3 `getProposalById` read already establishes this). `ADMIN_MANAGER`
// never reaches this component at all — the page itself never renders it
// for that role (D-027 §3: Admin/Manager "may not create a Proposal, create
// a revision, or publish a version"). `proposalId` is always the page's own
// already-validated route param, passed down as a plain prop — this
// component never offers a Proposal picker, a Client picker, or any
// free-text identifier input.

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Local, minimal response shapes for this panel's own use — deliberately
// not imported from features/proposals/repository.ts or
// features/proposals/service.ts (both server-only). This client component
// talks to `POST /api/proposals/[id]/versions` only through `fetch`,
// mirroring admin/clients/[id]/_components/CreateProposalPanel.tsx's
// identical discipline.
type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while creating this revision. Please check your connection and try again.';

const CONTENT_MAX_LENGTH = 20000;

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

type CreateRevisionSuccess = { version: { id: string; proposalId?: string } };

/**
 * Minimally safe `201` response validation (Stage 7D §E.1-3): only
 * `version.id` (nonblank) is strictly required — this panel never renders
 * or otherwise depends on any other field of the created version. When the
 * response shape does expose `version.proposalId`, it is cross-checked
 * against this panel's own `proposalId` prop and rejected on any mismatch —
 * mirroring `CreateProposalPanel.tsx`'s `isCreateProposalSuccess`'s
 * identical "never trust a conflicting identifier" discipline — but its
 * absence alone is never treated as a failure, since the accepted contract
 * does not require the field to be present at all.
 */
function isCreateRevisionSuccess(
  value: unknown,
  expectedProposalId: string,
): value is CreateRevisionSuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const version = candidate.version;
  if (!version || typeof version !== 'object' || Array.isArray(version)) return false;
  const versionCandidate = version as Record<string, unknown>;
  if (!isNonEmptyTrimmedString(versionCandidate.id)) return false;
  if (
    versionCandidate.proposalId !== undefined &&
    versionCandidate.proposalId !== expectedProposalId
  ) {
    return false;
  }
  return true;
}

export type CreateProposalRevisionPanelProps = {
  proposalId: string;
};

/**
 * Revision-creation form (D-027 §2/§3/§4/§6/§8/§10, Stage 7D). Submits
 * directly to the existing `POST /api/proposals/{proposalId}/versions` —
 * `{ content }` only, never `clientId`, a title, a reference, a
 * versionNumber, or any lifecycle/price/currency/status/assignment field,
 * matching `createProposalRevisionSchema`'s exact `.strict()` single-key
 * contract. This endpoint is deliberately not idempotent (D-027 §6):
 * multiple coexisting unpublished drafts are permitted, so no client-side
 * lifecycle restriction (e.g. blocking a new revision because an earlier
 * version was Accepted/Declined/had Changes Requested, or because an
 * unpublished draft already exists) is ever applied here — `submitting`
 * gates only against a genuine duplicate in-flight request, checked at the
 * very first line of `handleSubmit`, before any validation or `fetch` call.
 *
 * Client-side validation mirrors `features/proposals/schemas.ts`'s
 * `contentSchema` exactly — required, non-blank after trimming, at most
 * 20,000 characters after trimming — and rejects locally (no `fetch` call
 * at all) before ever reaching the server; this is advisory only, the
 * server's own schema remains authoritative. The textarea's own visible
 * value is never silently trimmed or mutated by this validation — only the
 * value placed in the request body is `.trim()`-ed, exactly once.
 *
 * Unlike `CreateProposalPanel.tsx` (which navigates to the newly created
 * Proposal's own detail page), this panel never navigates anywhere: the
 * actor is already on `/admin/proposals/{proposalId}`, which is exactly
 * where a new revision belongs. On a validated `201`, the textarea is
 * cleared, an accessible `role="status"` confirmation is shown, and
 * `router.refresh()` re-fetches this same Server Component so the
 * authoritative version history (rendered by `ProposalVersionHistory`)
 * reflects the new draft — `router.push` is never called. A malformed or
 * incomplete success body never clears the textarea and never shows
 * success.
 *
 * Every controlled `ProposalError` code (`VALIDATION_ERROR` naming
 * `content`, `PROPOSAL_FORBIDDEN`, `PROPOSAL_NOT_FOUND`,
 * `ROLE_NOT_PERMITTED`, an unauthenticated/session-expired response, a
 * generic 500, or any other) already carries a safe, server-crafted
 * message — rendered verbatim as the form-level alert, mirroring
 * `CreateProposalPanel.tsx`'s identical catch-all fallback. Nothing is ever
 * logged: no raw response body, submitted content, or exception is ever
 * passed to `console.*` anywhere in this component.
 */
export function CreateProposalRevisionPanel({ proposalId }: CreateProposalRevisionPanelProps) {
  const router = useRouter();

  const [content, setContent] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [justCreated, setJustCreated] = useState(false);

  const contentId = useId();
  const hintId = `${contentId}-hint`;
  const errorId = `${contentId}-error`;

  function updateContent(value: string) {
    setContent(value);
    setFieldError(null);
    setFormError(null);
    setJustCreated(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      setFieldError('Content is required.');
      setFormError(null);
      return;
    }
    if (trimmed.length > CONTENT_MAX_LENGTH) {
      setFieldError('Content must be at most 20,000 characters.');
      setFormError(null);
      return;
    }

    setFieldError(null);
    setFormError(null);
    setJustCreated(false);
    setSubmitting(true);

    try {
      const response = await fetch(`/api/proposals/${proposalId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isCreateRevisionSuccess(body, proposalId)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        // Never assume success from the submitted value alone — the
        // textarea is cleared only now, after the response has been
        // validated (Stage 7D §E.7).
        setContent('');
        setJustCreated(true);
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      const { error } = body;
      if (error.code === 'VALIDATION_ERROR') {
        const contentDetail = error.details?.find((detail) => detail.path === 'content');
        if (contentDetail) {
          setFieldError(contentDetail.message);
          return;
        }
      }
      setFormError(error.message);
    } catch {
      setFormError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.revisionPanel}>
      <h2>Create Revision</h2>
      <p>
        This creates a new draft version of this proposal. It is not published to the client until
        explicitly published.
      </p>

      <form onSubmit={handleSubmit} className={styles.revisionForm} noValidate>
        {formError ? (
          <p role="alert" className={styles.formAlert}>
            {formError}
          </p>
        ) : null}
        {justCreated ? (
          <p role="status" className={styles.formSuccessAlert}>
            Revision created.
          </p>
        ) : null}

        <div className={styles.formField}>
          <label htmlFor={contentId}>Revision content</label>
          <textarea
            id={contentId}
            name="content"
            value={content}
            onChange={(event) => updateContent(event.target.value)}
            rows={10}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${hintId} ${errorId}` : hintId}
            disabled={submitting}
            required
          />
          <p id={hintId}>Plain text only, up to 20,000 characters.</p>
          {fieldError ? (
            <p id={errorId} className={styles.fieldError}>
              {fieldError}
            </p>
          ) : null}
        </div>

        <div className={styles.formActions}>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Revision'}
          </button>
        </div>
      </form>
    </div>
  );
}
