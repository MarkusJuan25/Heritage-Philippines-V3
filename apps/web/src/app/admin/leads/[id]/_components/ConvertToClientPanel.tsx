'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../leads.module.css';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type MatchedChannel = 'EMAIL' | 'PHONE';

// The exact client-safe shape `getConversionOptions` returns per candidate
// (D-024 §3/§10) — id, fullName, and matched channel(s) only, never email,
// phone, notes, or assignment data. Deliberately a local type, not imported
// from features/leads/service.ts (server-only).
export type ConversionCandidate = {
  id: string;
  fullName: string;
  matchedOn: MatchedChannel[];
};

const CHANNEL_LABELS: Record<MatchedChannel, string> = { EMAIL: 'Email', PHONE: 'Phone' };

function formatMatchedOn(channels: MatchedChannel[]): string {
  return channels.map((channel) => CHANNEL_LABELS[channel]).join(' and ');
}

// A sentinel radio value for "create a new Client" — distinct from any real
// Client id (a UUID), so it can never collide with an accessible candidate.
const CREATE_NEW_VALUE = '__create_new__';

type ChosenAction = { type: 'create' } | { type: 'link'; clientId: string; fullName: string };

// The converted Lead's own shape once validated (Stage F review correction
// 1) — `status` narrowed to the exact literal, `clientId` narrowed to a
// non-empty string, never the wider LeadRecord shape.
type ConvertedLead = { id: string; status: 'CONVERTED_TO_CLIENT'; clientId: string };
type ClientSummary = { id: string; fullName: string };

// The exact Stage D success shape (D-024 §9): the mutation-style,
// assignment-free Lead, a minimal Client summary, and clientCreated.
type ConvertLeadSuccess = { lead: ConvertedLead; client: ClientSummary; clientCreated: boolean };

type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while converting this lead to a client. Please check your connection and try again.';

// `leadId` is the panel's own prop — a converted Lead whose `id` doesn't
// match it is never trusted, however well-formed it otherwise looks (Stage
// F review correction 1).
function isConvertedLead(value: unknown, leadId: string): value is ConvertedLead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.id === leadId &&
    candidate.status === 'CONVERTED_TO_CLIENT' &&
    isNonEmptyTrimmedString(candidate.clientId)
  );
}

function isClientSummary(value: unknown): value is ClientSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isNonEmptyTrimmedString(candidate.id) && isNonEmptyTrimmedString(candidate.fullName);
}

/**
 * Strict confirmed-conversion response validation (Stage F review
 * correction 1): accepted only when `lead.id` exactly equals this panel's
 * `leadId`, `lead.status` is exactly `CONVERTED_TO_CLIENT`, `lead.clientId`
 * is a non-empty string, `client.id` is a non-empty string, `lead.clientId`
 * exactly equals `client.id`, `client.fullName` is non-empty, and
 * `clientCreated` is a boolean. Any valid-but-wrong status, null/blank
 * `clientId`, wrong Lead id, or mismatched Client ids is rejected outright
 * — never shown as success, never triggering `router.refresh()`.
 */
function isConvertLeadSuccess(value: unknown, leadId: string): value is ConvertLeadSuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const lead = candidate.lead;
  const client = candidate.client;
  if (!isConvertedLead(lead, leadId)) return false;
  if (!isClientSummary(client)) return false;
  if (typeof candidate.clientCreated !== 'boolean') return false;
  return lead.clientId === client.id;
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

export type ConvertToClientPanelProps = {
  leadId: string;
  accessibleMatches: ConversionCandidate[];
  restrictedMatchDetected: boolean;
};

/**
 * Minimal Lead-to-Client conversion panel (D-024 §10). Rendered by page.tsx
 * only for a QUALIFIED Lead, using only the client-safe candidates
 * `getConversionOptions` already computed server-side — this component
 * never re-derives eligibility, authorization, or duplicate-matching
 * itself, and never offers a free-text Client-id input (every selectable
 * choice comes from `accessibleMatches`). Two explicit steps
 * (`mode: 'choose' | 'confirm'`) gate the irreversible mutation behind a
 * distinct confirmation screen (`.claude/rules/admin-dashboard.md`'s
 * Destructive and Irreversible Actions rule) — the initial choice never
 * itself calls `fetch`. Submits directly to the existing
 * `POST /api/leads/[id]/conversion`, parses the standard controlled error
 * envelope exactly as `EditLeadForm`/`StatusTransitionPanel` already do,
 * and calls `router.refresh()` only after the server confirms success —
 * never optimistically. Once that success is recorded, this component
 * permanently shows only the confirmation message: the refreshed
 * server-rendered Lead state (no longer QUALIFIED) is what actually
 * removes this panel from the page, so this instance must never offer
 * another submission in the meantime.
 */
export function ConvertToClientPanel({
  leadId,
  accessibleMatches,
  restrictedMatchDetected,
}: ConvertToClientPanelProps) {
  const router = useRouter();

  const hasAccessibleMatches = accessibleMatches.length > 0;
  const isRestrictedOnly = !hasAccessibleMatches && restrictedMatchDetected;
  const isCreateNewAvailable = !hasAccessibleMatches && !restrictedMatchDetected;

  const [mode, setMode] = useState<'choose' | 'confirm'>('choose');
  const [selected, setSelected] = useState('');
  const [chosenAction, setChosenAction] = useState<ChosenAction | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{ fullName: string; clientCreated: boolean } | null>(null);

  const groupName = useId();

  // `selected` alone is never trusted for rendering or submission — it is
  // only ever a record of the last radio the user clicked, and can go
  // stale the instant `accessibleMatches`/`restrictedMatchDetected` change
  // on a later render (e.g. another panel's `router.refresh()` while this
  // one stays mounted). `effectiveSelected` is re-derived from the CURRENT
  // props on every render instead (Stage F review correction 2): whenever
  // create-new is the only available action, it is always the effective
  // selection, regardless of any earlier candidate pick; otherwise, a
  // stored candidate id only counts while that exact candidate is still
  // present in the current `accessibleMatches` — a removed/renamed
  // candidate, or a stale create-new pick that matches now make untrue,
  // collapses back to "nothing selected", correctly disabling Continue.
  const effectiveSelected = isCreateNewAvailable
    ? CREATE_NEW_VALUE
    : accessibleMatches.some((candidate) => candidate.id === selected)
      ? selected
      : '';

  function handleContinue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!effectiveSelected) return;

    const action: ChosenAction | null =
      effectiveSelected === CREATE_NEW_VALUE
        ? { type: 'create' }
        : (() => {
            const match = accessibleMatches.find((candidate) => candidate.id === effectiveSelected);
            return match ? { type: 'link', clientId: match.id, fullName: match.fullName } : null;
          })();
    // Unreachable given `effectiveSelected` is only ever the sentinel or a
    // candidate id already confirmed present above — defensive only.
    if (!action) return;

    setChosenAction(action);
    setFormError(null);
    setMode('confirm');
  }

  function handleCancel() {
    if (submitting) return;
    setFormError(null);
    setMode('choose');
  }

  async function handleConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !chosenAction) return;

    // Re-validate the confirmed choice against CURRENT props before ever
    // submitting — the confirmation screen can go stale exactly like the
    // choose screen can (Stage F review correction 2). A stale
    // confirmation is never submitted; it bounces back to the choose step,
    // which `effectiveSelected` above will already render correctly for
    // the current options.
    const stillAuthorized =
      chosenAction.type === 'create'
        ? isCreateNewAvailable
        : accessibleMatches.some((candidate) => candidate.id === chosenAction.clientId);
    if (!stillAuthorized) {
      setChosenAction(null);
      setSelected('');
      setFormError(null);
      setMode('choose');
      return;
    }

    setFormError(null);
    setSubmitting(true);

    try {
      const response = await fetch(`/api/leads/${leadId}/conversion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          chosenAction.type === 'create'
            ? { expectedStatus: 'QUALIFIED' }
            : { expectedStatus: 'QUALIFIED', clientId: chosenAction.clientId },
        ),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!isConvertLeadSuccess(body, leadId)) {
          setFormError(GENERIC_ERROR_MESSAGE);
          return;
        }
        // Never assume success or invent the outcome from the submitted
        // choice alone — only the confirmed response is shown.
        setSuccess({ fullName: body.client.fullName, clientCreated: body.clientCreated });
        router.refresh();
        return;
      }

      if (!isApiErrorBody(body)) {
        setFormError(GENERIC_ERROR_MESSAGE);
        return;
      }
      // Every controlled LeadError code (CLIENT_MATCH_REQUIRES_LINK,
      // CLIENT_LINK_NOT_AVAILABLE, LEAD_CONFLICT, LEAD_FORBIDDEN,
      // LEAD_NOT_FOUND, ROLE_NOT_PERMITTED, VALIDATION_ERROR, and any other)
      // already carries a safe, server-crafted message — rendered verbatim,
      // never a raw response body or exception.
      setFormError(body.error.message);
    } catch {
      setFormError(GENERIC_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className={styles.statusPanel}>
        <h2>Convert to Client</h2>
        <p role="status" className={styles.formSuccessAlert}>
          {success.clientCreated
            ? `Converted. A new client, "${success.fullName}", was created.`
            : `Converted. This lead is now linked to the existing client "${success.fullName}".`}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.statusPanel}>
      <h2>Convert to Client</h2>

      {isRestrictedOnly ? (
        <p className={styles.duplicateRestrictedNotice}>
          A possible matching client already exists, but its details are unavailable to you. Please
          request Admin/Manager assistance to convert this lead.
        </p>
      ) : mode === 'choose' ? (
        <form onSubmit={handleContinue} className={styles.leadForm} noValidate>
          <fieldset className={styles.conversionChoices}>
            <legend>Choose how to convert this lead</legend>

            {isCreateNewAvailable ? (
              <div className={styles.conversionChoiceOption}>
                <input
                  type="radio"
                  id={`${groupName}-create`}
                  name={groupName}
                  value={CREATE_NEW_VALUE}
                  checked={effectiveSelected === CREATE_NEW_VALUE}
                  onChange={() => setSelected(CREATE_NEW_VALUE)}
                />
                <label htmlFor={`${groupName}-create`}>Create a new Client</label>
              </div>
            ) : null}

            {hasAccessibleMatches
              ? accessibleMatches.map((match) => (
                  <div key={match.id} className={styles.conversionChoiceOption}>
                    <input
                      type="radio"
                      id={`${groupName}-${match.id}`}
                      name={groupName}
                      value={match.id}
                      checked={effectiveSelected === match.id}
                      onChange={() => setSelected(match.id)}
                    />
                    <label htmlFor={`${groupName}-${match.id}`}>
                      {match.fullName} — matched on {formatMatchedOn(match.matchedOn)}
                    </label>
                  </div>
                ))
              : null}
          </fieldset>

          {restrictedMatchDetected && hasAccessibleMatches ? (
            <p className={styles.duplicateRestrictedNotice}>
              Another possible matching client exists, but its details are unavailable to you.
            </p>
          ) : null}

          <div className={styles.formActions}>
            <button type="submit" disabled={!effectiveSelected}>
              Continue
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleConfirm} className={styles.leadForm} noValidate>
          <p>
            {chosenAction?.type === 'create'
              ? "This will create a new Client from this lead's information."
              : `This will link this lead to the existing client "${chosenAction?.fullName}".`}
          </p>

          {formError ? (
            <p role="alert" className={styles.formAlert}>
              {formError}
            </p>
          ) : null}

          <div className={styles.formActions}>
            <button type="submit" disabled={submitting}>
              {submitting ? 'Converting…' : 'Confirm'}
            </button>
            <button type="button" onClick={handleCancel} disabled={submitting}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
