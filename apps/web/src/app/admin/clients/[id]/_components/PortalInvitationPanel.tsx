'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '../../clients.module.css';

// D-034 Stage 4's invitation-management panel: rendered by
// admin/clients/[id]/page.tsx for both ADMIN_MANAGER and TRAVEL_CONSULTANT
// alike — unlike ClientAssignmentPanel (ADMIN_MANAGER-only, D-025 §2), this
// component accepts no `role` prop at all and renders identical, fully
// interactive controls for either role, mirroring
// BookingStatusTransitionPanel's documented "accepts no role... trusting
// only the already server-filtered" precedent: blueprint §7.3 grants
// ADMIN_MANAGER and the assigned TRAVEL_CONSULTANT identical prepare/send/
// resend/revoke authority, and the page's own Layer 3 gate plus
// `getClientById`'s `canAccessClient` check already guarantee any
// TRAVEL_CONSULTANT reaching this page is currently assigned. Real
// authorization is enforced entirely server-side, redundantly, on every
// request this panel makes (D-035 §9) — this panel's own role-blindness is
// not itself a security boundary.

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDatetimeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNullableIsoDatetimeString(value: unknown): value is string | null {
  return value === null || isIsoDatetimeString(value);
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyTrimmedString(value);
}

// The seven blueprint §7.1 lifecycle statuses a persisted PortalInvitation
// row can hold — "Not Invited" (no row at all) is represented by this
// component's own `initialInvitation`/`displayed` being `null`, never a
// status string of its own.
const INVITATION_STATUS_VALUES = [
  'INVITATION_PREPARED',
  'INVITATION_SENT',
  'INVITATION_OPENED',
  'ACCOUNT_ACTIVATED',
  'INVITATION_EXPIRED',
  'INVITATION_REVOKED',
] as const;
type InvitationStatusValue = (typeof INVITATION_STATUS_VALUES)[number];

function isInvitationStatusValue(value: unknown): value is InvitationStatusValue {
  return (
    typeof value === 'string' && (INVITATION_STATUS_VALUES as readonly string[]).includes(value)
  );
}

const DELIVERY_METHOD_VALUES = ['AUTOMATED_EMAIL', 'MANUAL_EMAIL'] as const;
type DeliveryMethodValue = (typeof DELIVERY_METHOD_VALUES)[number];

function isNullableDeliveryMethod(value: unknown): value is DeliveryMethodValue | null {
  return value === null || (DELIVERY_METHOD_VALUES as readonly string[]).includes(value as string);
}

// D-034 §10's nine distinguished delivery-evidence states (D-035 §1 added
// AUTOMATED_UNCONFIRMED to the original eight).
const DELIVERY_STATE_VALUES = [
  'NOT_ATTEMPTED',
  'AUTOMATED_UNCONFIRMED',
  'AUTOMATED_ACCEPTED',
  'MANUALLY_CONFIRMED',
  'PROVIDER_DELIVERED',
  'PROVIDER_FAILED',
  'PROVIDER_BOUNCED',
  'PROVIDER_COMPLAINED',
  'PROVIDER_SUPPRESSED',
] as const;
type DeliveryStateValue = (typeof DELIVERY_STATE_VALUES)[number];

function isDeliveryStateValue(value: unknown): value is DeliveryStateValue {
  return typeof value === 'string' && (DELIVERY_STATE_VALUES as readonly string[]).includes(value);
}

// Local, minimal response shape for this panel's own use — deliberately not
// imported from features/invitations/repository.ts or
// features/invitations/service.ts (both server-only). This client
// component talks to the existing invitation endpoints only through
// `fetch`, mirroring EditClientForm.tsx's/ClientAssignmentPanel.tsx's
// identical discipline. `tokenHash` has no field here at all — it is never
// requested, expected, or read, matching what the server-side
// `toInvitationResponse`/`toNullableInvitationResponse` (D-035 §8) already
// excludes from every response.
export type InvitationView = {
  id: string;
  clientId: string;
  status: InvitationStatusValue;
  expiresAt: string | null;
  destinationEmail: string | null;
  deliveryMethod: DeliveryMethodValue | null;
  deliveryState: DeliveryStateValue;
  sendOperationId: string | null;
  providerMessageId: string | null;
  deliveryConfirmedAt: string | null;
  deliveryConfirmedByStaffId: string | null;
  sentAt: string | null;
  openedAt: string | null;
  activatedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function isInvitationView(value: unknown): value is InvitationView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyTrimmedString(candidate.id) &&
    isNonEmptyTrimmedString(candidate.clientId) &&
    isInvitationStatusValue(candidate.status) &&
    isNullableIsoDatetimeString(candidate.expiresAt) &&
    isNullableNonEmptyString(candidate.destinationEmail) &&
    isNullableDeliveryMethod(candidate.deliveryMethod) &&
    isDeliveryStateValue(candidate.deliveryState) &&
    isNullableNonEmptyString(candidate.sendOperationId) &&
    isNullableNonEmptyString(candidate.providerMessageId) &&
    isNullableIsoDatetimeString(candidate.deliveryConfirmedAt) &&
    isNullableNonEmptyString(candidate.deliveryConfirmedByStaffId) &&
    isNullableIsoDatetimeString(candidate.sentAt) &&
    isNullableIsoDatetimeString(candidate.openedAt) &&
    isNullableIsoDatetimeString(candidate.activatedAt) &&
    isNullableIsoDatetimeString(candidate.revokedAt) &&
    isIsoDatetimeString(candidate.createdAt) &&
    isIsoDatetimeString(candidate.updatedAt)
  );
}

type SendOrResendSuccess = {
  invitation: InvitationView;
  delivery:
    'reserved-only' | 'unconfirmed' | 'AUTOMATED_ACCEPTED' | 'PROVIDER_FAILED' | 'already-reserved';
  manualInvitationUrl?: string;
};

function isSendOrResendSuccess(
  value: unknown,
  expectedClientId: string,
): value is SendOrResendSuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isInvitationView(candidate.invitation)) return false;
  if (candidate.invitation.clientId !== expectedClientId) return false;
  if (
    candidate.delivery !== 'reserved-only' &&
    candidate.delivery !== 'unconfirmed' &&
    candidate.delivery !== 'AUTOMATED_ACCEPTED' &&
    candidate.delivery !== 'PROVIDER_FAILED' &&
    candidate.delivery !== 'already-reserved'
  ) {
    return false;
  }
  if (
    candidate.manualInvitationUrl !== undefined &&
    !isNonEmptyTrimmedString(candidate.manualInvitationUrl)
  ) {
    return false;
  }
  return true;
}

type InvitationOnlySuccess = { invitation: InvitationView };

function isInvitationOnlySuccess(
  value: unknown,
  expectedClientId: string,
): value is InvitationOnlySuccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isInvitationView(candidate.invitation) && candidate.invitation.clientId === expectedClientId
  );
}

type ApiErrorDetail = { path: string; message: string };
type ApiErrorBody = { error: { code: string; message: string; details?: ApiErrorDetail[] } };

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

const GENERIC_ERROR_MESSAGE =
  'Something went wrong while managing this invitation. Please check your connection and try again.';
const FORBIDDEN_ERROR_MESSAGE = 'You no longer have access to manage this client’s invitation.';
const DELIVERY_DISABLED_MESSAGE_FALLBACK =
  'Automated email delivery is not yet configured for this environment. Use Manual Email instead.';

const STATUS_LABELS: Record<InvitationStatusValue, string> = {
  INVITATION_PREPARED: 'Invitation Prepared',
  INVITATION_SENT: 'Invitation Sent',
  INVITATION_OPENED: 'Invitation Opened',
  ACCOUNT_ACTIVATED: 'Account Activated',
  INVITATION_EXPIRED: 'Invitation Expired',
  INVITATION_REVOKED: 'Invitation Revoked',
};

// blueprint §7.1: "'Sent' and 'delivered' are deliberately distinct
// claims: this platform never represents provider acceptance of a send
// request as confirmed recipient delivery." Every label below preserves
// that distinction explicitly rather than implying delivery from
// acceptance.
const DELIVERY_STATE_LABELS: Record<DeliveryStateValue, string> = {
  NOT_ATTEMPTED: 'Not yet attempted',
  AUTOMATED_UNCONFIRMED: 'Send in progress — outcome not yet confirmed',
  AUTOMATED_ACCEPTED: 'Accepted by provider — delivery not yet confirmed',
  MANUALLY_CONFIRMED: 'Manually confirmed sent',
  PROVIDER_DELIVERED: 'Delivered',
  PROVIDER_FAILED: 'Failed',
  PROVIDER_BOUNCED: 'Bounced',
  PROVIDER_COMPLAINED: 'Recipient marked as spam',
  PROVIDER_SUPPRESSED: 'Suppressed by provider',
};

const RESENDABLE_STATUSES: readonly InvitationStatusValue[] = [
  'INVITATION_SENT',
  'INVITATION_OPENED',
  'INVITATION_EXPIRED',
  'INVITATION_REVOKED',
];
const REVOCABLE_STATUSES: readonly InvitationStatusValue[] = [
  'INVITATION_PREPARED',
  'INVITATION_SENT',
  'INVITATION_OPENED',
  'INVITATION_EXPIRED',
];

/** A stable primitive key for an `InvitationView`, used only to detect whether the `initialInvitation` prop has genuinely changed value between renders — never persisted, displayed, or sent anywhere. */
function invitationKey(invitation: InvitationView | null): string {
  return invitation ? `${invitation.id}:${invitation.updatedAt}` : '';
}

function isEffectivelyExpired(invitation: InvitationView): boolean {
  if (!invitation.expiresAt) return false;
  if (invitation.status !== 'INVITATION_SENT' && invitation.status !== 'INVITATION_OPENED') {
    return false;
  }
  return new Date(invitation.expiresAt).getTime() < Date.now();
}

type PendingAction = 'prepare' | 'send' | 'resend' | 'confirm' | 'revoke' | null;

export type PortalInvitationPanelProps = {
  clientId: string;
  initialInvitation: InvitationView | null;
};

/**
 * Portal invitation lifecycle management for a single Client (D-034 §§2–
 * 4, 9–10; D-035; Stage 4's own corrected reissue-from-REVOKED
 * transition). Submits directly to the existing, unmodified
 * `/api/clients/[id]/invitation` family of routes — no invitation
 * repository, service, schema, route, or audit behavior is introduced or
 * altered by this component.
 *
 * `manualInvitationUrl` (D-035 §5, Stage 4 §5) is held only in this
 * component's own React state, never persisted to `localStorage`/
 * `sessionStorage`/a cookie/the URL, and is cleared: when a new send/resend
 * attempt begins, immediately after a successful manual-send confirmation,
 * and on a `clientId` change. It is the one and only place this component
 * ever renders a complete invitation URL.
 *
 * The resend/reissue action alone carries D-035 §6's optimistic-concurrency
 * precondition (`expectedCurrentSendOperationId`/`expectedUpdatedAt`, read
 * fresh from `displayed` at submit time) — prepare/revoke/confirm are all
 * idempotent no-ops server-side and need no equivalent client-side stale
 * guard. On `INVITATION_SEND_OPERATION_STALE`, this mirrors
 * EditClientForm.tsx's `CLIENT_CONFLICT` recovery exactly: the resend
 * action locks, the server's message is shown alongside a "Refresh and try
 * again" button that only calls `router.refresh()`, and a render-time
 * guard (never `useEffect`) clears the lock only once the user has clicked
 * that button *and* the parent's fresh `initialInvitation` prop
 * demonstrably differs from what was rejected.
 *
 * A synchronous `pendingActionRef` (not `pendingAction` React state alone)
 * guards every submit handler against a second submission dispatched
 * before React commits state, mirroring BookingStatusTransitionPanel.tsx's
 * identical discipline.
 */
export function PortalInvitationPanel({ clientId, initialInvitation }: PortalInvitationPanelProps) {
  const router = useRouter();

  const [displayed, setDisplayed] = useState<InvitationView | null>(initialInvitation);
  const [lastPropKey, setLastPropKey] = useState(() => invitationKey(initialInvitation));
  const [priorClientId, setPriorClientId] = useState(clientId);

  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethodValue>('MANUAL_EMAIL');
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeReasonError, setRevokeReasonError] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const pendingActionRef = useRef<PendingAction>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [staleConflict, setStaleConflict] = useState(false);
  const [staleConflictRefreshRequested, setStaleConflictRefreshRequested] = useState(false);

  // Navigated to a different Client without this component remounting —
  // every piece of transient state describes the PREVIOUS Client. Mirrors
  // ClientAssignmentPanel.tsx's identical guard, extended to also clear
  // the one-time manual link.
  if (clientId !== priorClientId) {
    setPriorClientId(clientId);
    setLastPropKey(invitationKey(initialInvitation));
    setDisplayed(initialInvitation);
    setManualUrl(null);
    setCopyStatus('idle');
    setDeliveryMethod('MANUAL_EMAIL');
    setRevokeReason('');
    setRevokeReasonError(null);
    setPendingAction(null);
    setActionError(null);
    setActionSuccess(null);
    setStaleConflict(false);
    setStaleConflictRefreshRequested(false);
  } else if (invitationKey(initialInvitation) !== lastPropKey) {
    // Same Client — the authoritative prop itself changed (typically
    // `router.refresh()` finally resolving). Re-syncs the displayed
    // invitation only; never touches in-progress action state.
    setLastPropKey(invitationKey(initialInvitation));
    setDisplayed(initialInvitation);
    // A genuinely fresh read has arrived — exactly the condition
    // EditClientForm.tsx's own conflict-recovery guard requires before a
    // stale-locked resend may unlock again.
    if (staleConflict && staleConflictRefreshRequested) {
      setStaleConflict(false);
      setStaleConflictRefreshRequested(false);
      setActionError(null);
    }
  }

  const manualUrlId = useId();
  const deliveryMethodId = useId();
  const revokeReasonId = useId();

  const isPending = pendingAction !== null;

  function classifyError(error: ApiErrorBody['error']): { message: string; stale: boolean } {
    if (error.code === 'INVITATION_SEND_OPERATION_STALE') {
      return { message: error.message, stale: true };
    }
    if (error.code === 'CLIENT_FORBIDDEN' || error.code === 'CLIENT_NOT_FOUND') {
      return { message: FORBIDDEN_ERROR_MESSAGE, stale: false };
    }
    if (error.code === 'DELIVERY_DISABLED') {
      return { message: error.message || DELIVERY_DISABLED_MESSAGE_FALLBACK, stale: false };
    }
    return { message: error.message, stale: false };
  }

  async function runAction(
    action: Exclude<PendingAction, null>,
    request: () => Promise<Response>,
    onSuccess: (body: unknown) => boolean,
  ): Promise<void> {
    if (pendingActionRef.current) return;
    pendingActionRef.current = action;

    setActionError(null);
    setActionSuccess(null);
    setPendingAction(action);

    try {
      const response = await request();

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setActionError(GENERIC_ERROR_MESSAGE);
        return;
      }

      if (response.ok) {
        if (!onSuccess(body)) {
          setActionError(GENERIC_ERROR_MESSAGE);
        }
        return;
      }

      if (!isApiErrorBody(body)) {
        setActionError(GENERIC_ERROR_MESSAGE);
        return;
      }

      const { message, stale } = classifyError(body.error);
      setActionError(message);
      if (stale) {
        setStaleConflict(true);
        setStaleConflictRefreshRequested(false);
      }
    } catch {
      setActionError(GENERIC_ERROR_MESSAGE);
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }

  async function handlePrepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(
      'prepare',
      () =>
        fetch(`/api/clients/${clientId}/invitation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      (body) => {
        if (!isInvitationOnlySuccess(body, clientId)) return false;
        setDisplayed(body.invitation);
        setActionSuccess('Invitation prepared.');
        router.refresh();
        return true;
      },
    );
  }

  async function handleSendOrResend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!displayed) return;

    const isReissue = RESENDABLE_STATUSES.includes(displayed.status);
    const path = isReissue ? 'resend' : 'send';
    const idempotencyKey = crypto.randomUUID();
    setManualUrl(null);
    setCopyStatus('idle');

    await runAction(
      isReissue ? 'resend' : 'send',
      () =>
        fetch(`/api/clients/${clientId}/invitation/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({
            deliveryMethod,
            ...(isReissue
              ? {
                  expectedCurrentSendOperationId: displayed.sendOperationId,
                  expectedUpdatedAt: displayed.updatedAt,
                }
              : {}),
          }),
        }),
      (body) => {
        if (!isSendOrResendSuccess(body, clientId)) return false;
        setDisplayed(body.invitation);
        if (body.manualInvitationUrl) {
          setManualUrl(body.manualInvitationUrl);
        }
        setActionSuccess(isReissue ? 'Invitation resent.' : 'Invitation sent.');
        router.refresh();
        return true;
      },
    );
  }

  async function handleConfirmManualSent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const idempotencyKey = crypto.randomUUID();

    await runAction(
      'confirm',
      () =>
        fetch(`/api/clients/${clientId}/invitation/confirm-manual-sent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        }),
      (body) => {
        if (!isInvitationOnlySuccess(body, clientId)) return false;
        setDisplayed(body.invitation);
        // The manual link's job is done — continuing to display it past
        // confirmation only widens its exposure window for no benefit.
        setManualUrl(null);
        setCopyStatus('idle');
        setActionSuccess('Manual send confirmed.');
        router.refresh();
        return true;
      },
    );
  }

  async function handleRevoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedReason = revokeReason.trim();
    if (trimmedReason.length === 0) {
      setRevokeReasonError('A reason is required to revoke this invitation.');
      return;
    }
    setRevokeReasonError(null);

    await runAction(
      'revoke',
      () =>
        fetch(`/api/clients/${clientId}/invitation/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: trimmedReason }),
        }),
      (body) => {
        if (!isInvitationOnlySuccess(body, clientId)) return false;
        setDisplayed(body.invitation);
        setManualUrl(null);
        setCopyStatus('idle');
        setRevokeReason('');
        setActionSuccess('Invitation revoked.');
        router.refresh();
        return true;
      },
    );
  }

  async function handleCopyLink() {
    if (!manualUrl) return;
    try {
      await navigator.clipboard.writeText(manualUrl);
      setCopyStatus('copied');
    } catch {
      // Clipboard API unavailable/denied — the read-only text field below
      // remains the accessible fallback (select-all, then a manual copy).
      setCopyStatus('failed');
    }
  }

  const status = displayed?.status ?? null;
  const canPrepare = displayed === null;
  const canSend = status === 'INVITATION_PREPARED';
  const canResend = status !== null && RESENDABLE_STATUSES.includes(status);
  const canConfirmManual = status === 'INVITATION_SENT' && displayed?.deliveryMethod === null;
  const canRevoke = status !== null && REVOCABLE_STATUSES.includes(status);
  const resendDisabled = isPending || staleConflict;

  return (
    <div className={styles.invitationPanel}>
      <h2>Portal Invitation</h2>

      {actionError ? (
        <p role="alert" className={styles.formAlert}>
          {actionError}
          {staleConflict ? (
            <>
              {' '}
              <button
                type="button"
                onClick={() => {
                  setStaleConflictRefreshRequested(true);
                  router.refresh();
                }}
              >
                Refresh and try again
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {actionSuccess ? (
        <p role="status" className={styles.formSuccessAlert}>
          {actionSuccess}
        </p>
      ) : null}

      <dl className={styles.detailFields}>
        <div className={styles.detailField}>
          <dt>Status</dt>
          <dd>
            {displayed === null ? 'Not Invited' : STATUS_LABELS[displayed.status]}
            {displayed && isEffectivelyExpired(displayed) ? ' (expired)' : ''}
          </dd>
        </div>
        {displayed ? (
          <>
            <div className={styles.detailField}>
              <dt>Delivery</dt>
              <dd>{DELIVERY_STATE_LABELS[displayed.deliveryState]}</dd>
            </div>
            {displayed.destinationEmail ? (
              <div className={styles.detailField}>
                <dt>Sent to</dt>
                <dd>{displayed.destinationEmail}</dd>
              </div>
            ) : null}
            {displayed.expiresAt ? (
              <div className={styles.detailField}>
                <dt>Expires</dt>
                <dd>
                  <time dateTime={displayed.expiresAt}>
                    {new Date(displayed.expiresAt).toLocaleString('en-PH')}
                  </time>
                </dd>
              </div>
            ) : null}
          </>
        ) : null}
      </dl>

      {manualUrl ? (
        <div className={styles.manualLinkBox}>
          <p>
            This link is shown only once. If lost, reissue to generate a new one — the previous link
            stops working.
          </p>
          <div className={styles.filterField}>
            <label htmlFor={manualUrlId}>One-time invitation link</label>
            <input
              id={manualUrlId}
              type="text"
              readOnly
              value={manualUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
          <div className={styles.formActions}>
            <button type="button" onClick={handleCopyLink}>
              Copy invitation link
            </button>
            {copyStatus === 'copied' ? <span role="status">Link copied to clipboard.</span> : null}
            {copyStatus === 'failed' ? (
              <span role="status">
                Could not copy automatically — select the link text above and copy it manually.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {canPrepare ? (
        <form onSubmit={handlePrepare} className={styles.clientForm} noValidate>
          <div className={styles.formActions}>
            <button type="submit" disabled={isPending}>
              {pendingAction === 'prepare' ? 'Preparing…' : 'Prepare Invitation'}
            </button>
          </div>
        </form>
      ) : null}

      {canSend || canResend ? (
        <form onSubmit={handleSendOrResend} className={styles.clientForm} noValidate>
          <div className={styles.filterField}>
            <label htmlFor={deliveryMethodId}>Delivery method</label>
            <select
              id={deliveryMethodId}
              value={deliveryMethod}
              onChange={(event) => setDeliveryMethod(event.target.value as DeliveryMethodValue)}
              disabled={resendDisabled}
            >
              <option value="MANUAL_EMAIL">Manual email</option>
              <option value="AUTOMATED_EMAIL">Automated email</option>
            </select>
          </div>
          <div className={styles.formActions}>
            <button type="submit" disabled={resendDisabled}>
              {pendingAction === 'send'
                ? 'Sending…'
                : pendingAction === 'resend'
                  ? 'Sending…'
                  : canSend
                    ? 'Send Invitation'
                    : status === 'INVITATION_EXPIRED' || status === 'INVITATION_REVOKED'
                      ? 'Reissue Invitation'
                      : 'Resend Invitation'}
            </button>
          </div>
        </form>
      ) : null}

      {canConfirmManual ? (
        <form onSubmit={handleConfirmManualSent} className={styles.clientForm} noValidate>
          <div className={styles.formActions}>
            <button type="submit" disabled={isPending}>
              {pendingAction === 'confirm' ? 'Confirming…' : 'Confirm Manual Sent'}
            </button>
          </div>
        </form>
      ) : null}

      {canRevoke ? (
        <form onSubmit={handleRevoke} className={styles.clientForm} noValidate>
          <div className={styles.filterField}>
            <label htmlFor={revokeReasonId}>Reason for revoking</label>
            <textarea
              id={revokeReasonId}
              value={revokeReason}
              onChange={(event) => {
                setRevokeReason(event.target.value);
                setRevokeReasonError(null);
              }}
              maxLength={500}
              rows={3}
              aria-invalid={revokeReasonError ? true : undefined}
              aria-describedby={revokeReasonError ? `${revokeReasonId}-error` : undefined}
              disabled={isPending}
              required
            />
            {revokeReasonError ? (
              <p id={`${revokeReasonId}-error`} className={styles.fieldError}>
                {revokeReasonError}
              </p>
            ) : null}
          </div>
          <div className={styles.formActions}>
            <button type="submit" disabled={isPending}>
              {pendingAction === 'revoke' ? 'Revoking…' : 'Revoke Invitation'}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
