'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../clients.module.css';

// D-027 §8's sole first-Proposal creation entry point: rendered by
// admin/clients/[id]/page.tsx only for a TRAVEL_CONSULTANT viewing a Client
// they are already authorized to see (that page's own existing Layer 3
// `canAccessClient`-backed read already establishes this). `ADMIN_MANAGER`
// never reaches this component at all — the page itself never renders it
// for that role (D-027 §3: Admin/Manager "may not create a Proposal").
// `clientId` is always the page's own already-validated route param, passed
// down as a plain prop — this component never asks for or accepts a
// Client id from the user, and never offers any Client search/picker.

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Local, minimal response shapes for this panel's own use — deliberately
// not imported from features/proposals/repository.ts or
// features/proposals/service.ts (both server-only). This client component
// talks to `POST /api/proposals` only through `fetch`, mirroring
// EditClientForm.tsx's/ConvertToClientPanel.tsx's identical discipline.
type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while creating this proposal. Please check your connection and try again.';

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

type CreateProposalSuccess = { proposal: { id: string; clientId: string } };

/**
 * Strict `201` response validation, mirroring
 * ConvertToClientPanel.tsx's `isConvertedLead`'s identical
 * prop-cross-check discipline: a response whose `proposal.clientId` doesn't
 * exactly match this panel's own `clientId` prop is never trusted, however
 * well-formed it otherwise looks — this panel navigates only on a response
 * it can prove actually describes a Proposal for the Client it was
 * rendered for. `version` is part of the documented `{ proposal, version }`
 * envelope (D-027 §6) but is never read here — this component navigates
 * away immediately and never renders any version data itself.
 */
function isCreateProposalSuccess(
  value: unknown,
  expectedClientId: string,
): value is CreateProposalSuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const proposal = candidate.proposal;
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false;
  const proposalCandidate = proposal as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(proposalCandidate.id) && proposalCandidate.clientId === expectedClientId
  );
}

export type CreateProposalPanelProps = {
  clientId: string;
};

/**
 * The sole first-Proposal creation form (D-027 §2/§3/§6/§8/§10). Submits
 * directly to the existing `POST /api/proposals` — `{ clientId, content }`
 * only, never a title, reference, price, currency, status, or assignment
 * field, matching `createProposalSchema`'s exact `.strict()` two-key
 * contract exactly. This endpoint is deliberately not idempotent (D-027
 * §6): a rapid double submit must never produce two Proposals, so
 * `submitting` gates the very first line of `handleSubmit`, before any
 * validation or `fetch` call.
 *
 * Client-side validation mirrors `features/proposals/schemas.ts`'s
 * `contentSchema` exactly — required, non-blank after trimming, at most
 * 20,000 characters after trimming — and rejects locally (no `fetch` call
 * at all) before ever reaching the server; this is advisory only, the
 * server's own schema remains authoritative. The textarea's own visible
 * value is never silently trimmed or mutated by this validation — only the
 * value placed in the request body is `.trim()`-ed, exactly once, so a
 * user's raw input (including any leading/trailing whitespace they're still
 * editing) is preserved untouched in the UI both before and after a failed
 * submission (D-027 Stage 7C §E.13/§E.14).
 *
 * On a validated `201` response, this panel navigates immediately to
 * `/admin/proposals/{proposal.id}` (`router.push`, then `router.refresh()`,
 * mirroring `app/login/page.tsx`'s/`app/dashboard/sign-out-button.tsx`'s
 * identical established navigate-then-refresh convention) — the textarea is
 * never cleared beforehand, since this component unmounts as part of that
 * same navigation. A malformed or incomplete success body (missing/blank
 * `proposal.id`, or a `proposal.clientId` that doesn't match this panel's
 * own `clientId` prop) is treated as unsafe and never navigates. Once a
 * response has been validated as a genuine success, this panel disables
 * itself permanently (`justCreated`), mirroring
 * `PublishProposalVersionButton.tsx`'s/`RecordProposalResponsePanel.tsx`'s
 * identical post-success latch — so a stray direct submit during the brief
 * window before that navigation actually unmounts the component can never
 * issue a second, redundant `POST /api/proposals` request.
 *
 * Every controlled `ProposalError` code (`VALIDATION_ERROR`,
 * `CLIENT_NOT_FOUND`, `CLIENT_FORBIDDEN`, `ROLE_NOT_PERMITTED`, an
 * unauthenticated/session-expired response, or any other) already carries a
 * safe, server-crafted message — rendered verbatim as the form-level alert,
 * mirroring `EditClientForm.tsx`'s/`ConvertToClientPanel.tsx`'s identical
 * catch-all fallback — except `VALIDATION_ERROR` specifically naming the
 * `content` field, which is shown as a field-level error instead. Nothing
 * is ever logged: no raw response body, submitted content, or exception is
 * ever passed to `console.*` anywhere in this component.
 */
export function CreateProposalPanel({ clientId }: CreateProposalPanelProps) {
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
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || justCreated) return;

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
    setSubmitting(true);

    try {
      const response = await fetch('/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, content: trimmed }),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isCreateProposalSuccess(body, clientId)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        setJustCreated(true);
        router.push(`/admin/proposals/${body.proposal.id}`);
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
    <div className={styles.assignmentPanel}>
      <h2>Proposal / ROS</h2>
      <p>This creates the first version of a new Proposal / ROS for this client.</p>

      <form onSubmit={handleSubmit} className={styles.clientForm} noValidate>
        {formError ? (
          <p role="alert" className={styles.formAlert}>
            {formError}
          </p>
        ) : null}

        <div className={styles.filterField}>
          <label htmlFor={contentId}>Proposal content</label>
          <textarea
            id={contentId}
            name="content"
            value={content}
            onChange={(event) => updateContent(event.target.value)}
            rows={10}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${hintId} ${errorId}` : hintId}
            disabled={submitting || justCreated}
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
          <button type="submit" disabled={submitting || justCreated}>
            {submitting ? 'Creating…' : 'Create Proposal / ROS'}
          </button>
        </div>
      </form>
    </div>
  );
}
