import type { Prisma, PortalInvitationStatus } from '@/generated/prisma/client';
import { normalizeEmail } from '@/lib/contact-normalization';
import { prisma } from '@/lib/db';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { canAccessClient } from '@/features/assignments/authorization';
import * as assignmentRepository from '@/features/assignments/repository';

import {
  INVITATION_AUDIT_ACTIONS,
  INVITATION_AUDIT_ENTITY_TYPE,
  sanitizeInvitationSnapshot,
} from './audit';
import { InvitationError } from './errors';
import * as repository from './repository';
import type { InvitationRecord } from './repository';
import {
  buildActivationUrl,
  isAutomatedDeliveryEnabled,
  sendInvitationEmail,
  verifyResendWebhook,
  type VerifiedWebhookEvent,
} from './resend-adapter';
import {
  buildResendIdempotencyKey,
  computeExpiryFromNow,
  generateInvitationToken,
  hashInvitationToken,
} from './token';

// Every mutation here mirrors D-031 F-01's exact transaction-local
// assignment-recheck pattern (features/clients/service.ts's `updateClient`):
// `canAccessClient` gates access *before* the transaction opens; a
// TRAVEL_CONSULTANT actor's active assignment is *rechecked* fresh, as the
// first operation inside `runSerializableWithRetry`'s retried callback,
// before any invitation state is read or written. ADMIN_MANAGER performs
// no such recheck. See that file's doc comment for the full race-window
// rationale this reuses unchanged.

function notFoundOrForbidden(actor: AuthenticatedUser): InvitationError {
  return actor.role === 'ADMIN_MANAGER'
    ? new InvitationError('CLIENT_NOT_FOUND', 'Client not found.')
    : new InvitationError('CLIENT_FORBIDDEN', 'You do not have access to this client.');
}

async function assertTravelConsultantAssignment(
  tx: Prisma.TransactionClient,
  actor: AuthenticatedUser,
  clientId: string,
): Promise<void> {
  if (actor.role !== 'TRAVEL_CONSULTANT') return;
  const active = await assignmentRepository.findActiveAssignmentForClient(tx, clientId);
  if (!active || active.assignedStaffId !== actor.id) {
    throw notFoundOrForbidden(actor);
  }
}

// Only ADMIN_MANAGER and TRAVEL_CONSULTANT may act on invitations (D-034
// Section 9; blueprint Section 4.2/4.3). Every other role — including
// SYSTEM_ADMINISTRATOR — is rejected outright by `canAccessClient` itself
// (features/assignments/authorization.ts), so no separate role gate is
// needed in this file beyond calling it.

export async function getInvitationForClient(
  actor: AuthenticatedUser,
  clientId: string,
): Promise<InvitationRecord | null> {
  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) throw notFoundOrForbidden(actor);
  return repository.findInvitationByClientId(prisma, clientId);
}

/**
 * Prepare (D-034 Section 3): creates the invitation row, or is an
 * idempotent no-op when one already exists in INVITATION_PREPARED
 * (D-034 Section 4: "prepare... retries are idempotent no-ops", mirroring
 * features/staff/service.ts's changeStaffRole/deactivateStaffAccount
 * no-op precedent). An invitation that already exists in any *other*
 * status cannot be re-prepared — that is a genuine conflict, not a retry.
 */
export async function prepareInvitation(
  actor: AuthenticatedUser,
  clientId: string,
): Promise<InvitationRecord> {
  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) throw notFoundOrForbidden(actor);

  return runSerializableWithRetry(async (tx) => {
    await assertTravelConsultantAssignment(tx, actor, clientId);

    const existing = await repository.findInvitationByClientId(tx, clientId);
    if (existing) {
      if (existing.status === 'INVITATION_PREPARED') {
        return existing;
      }
      throw new InvitationError(
        'INVITATION_ALREADY_EXISTS',
        'An invitation already exists for this client.',
      );
    }

    // canAccessClient's ADMIN_MANAGER branch is unconditionally `allowed`
    // regardless of whether `clientId` actually exists (see its own doc
    // comment) — a TRAVEL_CONSULTANT actor already had this proven above
    // by `assertTravelConsultantAssignment`'s active-assignment lookup,
    // but ADMIN_MANAGER needs an explicit existence check here, before
    // ever attempting to insert a PortalInvitation row against a
    // nonexistent `clientId`.
    const client = await repository.findClientById(tx, clientId);
    if (!client) {
      throw notFoundOrForbidden(actor);
    }

    const created = await repository.createInvitation(tx, clientId);
    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: INVITATION_AUDIT_ACTIONS.PREPARED,
      entityType: INVITATION_AUDIT_ENTITY_TYPE,
      entityId: created.id,
      afterState: sanitizeInvitationSnapshot(created),
    });
    return created;
  });
}

export type SendOrResendInput = {
  deliveryMethod: 'AUTOMATED_EMAIL' | 'MANUAL_EMAIL';
  idempotencyKey: string;
};

/**
 * The stale-resend optimistic-concurrency precondition (Stage 3
 * Correction and Security Review Pass 1 §3) — supplied only by
 * `resendInvitation`. `sendInvitation` needs no equivalent: it only ever
 * fires once, from INVITATION_PREPARED, so a later retry with a different
 * idempotency key already fails the status check below instead of
 * silently rotating anything.
 */
export type ResendConcurrencyPrecondition = {
  expectedCurrentSendOperationId: string | null;
  expectedUpdatedAt: Date;
};

type ReservationOutcome =
  | { kind: 'already-reserved'; invitation: InvitationRecord }
  | { kind: 'fresh'; invitation: InvitationRecord; rawToken: string };

/**
 * Shared reservation step for both the first send and an explicit
 * resend/reissue (D-034 Sections 4, 6, 9) — the only difference between
 * the two callers is which source `status` values are accepted, which
 * audit action is written, and whether a concurrency precondition is
 * enforced. Runs entirely inside one serializable transaction, committed
 * before this function returns; the caller (never this function) makes
 * the actual Resend API call afterward — D-034 Section 4's "no
 * transaction may remain open across that call".
 */
async function reserveSendOperation(
  actor: AuthenticatedUser,
  clientId: string,
  input: SendOrResendInput,
  allowedStatuses: readonly PortalInvitationStatus[],
  auditAction: string,
  concurrency?: ResendConcurrencyPrecondition,
): Promise<ReservationOutcome> {
  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) throw notFoundOrForbidden(actor);

  if (input.deliveryMethod === 'AUTOMATED_EMAIL' && !isAutomatedDeliveryEnabled()) {
    throw new InvitationError(
      'DELIVERY_DISABLED',
      'Automated email delivery is currently disabled.',
    );
  }

  return runSerializableWithRetry(async (tx) => {
    await assertTravelConsultantAssignment(tx, actor, clientId);

    const invitation = await repository.findInvitationByClientId(tx, clientId);
    if (!invitation) {
      throw new InvitationError(
        'INVITATION_NOT_FOUND',
        'No invitation exists for this client yet — prepare one first.',
      );
    }

    // Cross-request retry of an already-reserved AUTOMATED operation: the
    // raw token is never persisted and cannot be safely reconstructed, so
    // this never re-derives or re-sends email content — it returns the
    // current, authoritative row unchanged. If still AUTOMATED_UNCONFIRMED,
    // the caller must wait for webhook reconciliation or issue a genuinely
    // new resend (D-034 Section 4's explicit "reconciliation... or an
    // explicit resend").
    if (
      invitation.deliveryMethod === 'AUTOMATED_EMAIL' &&
      invitation.sendOperationId === input.idempotencyKey
    ) {
      return { kind: 'already-reserved', invitation };
    }

    // No equivalent cross-request-retry short-circuit exists for the
    // MANUAL_EMAIL channel: nothing is rotated or sent to a provider on
    // that channel until confirm-manual-sent, and the schema forbids
    // persisting a sendOperationId while deliveryState stays NOT_ATTEMPTED
    // (portal_invitation_send_operation_id_presence), so there is no safe
    // place to record a manual send's idempotency key to compare against.
    // A manual retry that lands after the invitation has already left the
    // status this action requires simply falls through to the
    // INVITATION_NOT_SENDABLE error below — safe (nothing was rotated or
    // externally sent twice), just not silently absorbed. The concurrency
    // precondition below closes the remaining manual-channel race (two
    // concurrent resends both observing the same pre-rotation state).
    if (!allowedStatuses.includes(invitation.status)) {
      throw new InvitationError(
        'INVITATION_NOT_SENDABLE',
        `This invitation is currently ${invitation.status} and cannot be sent from this action.`,
      );
    }

    // Explicit precondition check (clear error attribution) — and, below,
    // the same precondition re-enforced atomically in the write's own
    // WHERE clause (defense-in-depth against the narrow window between
    // this read and that write) — mirrors
    // features/clients/service.ts's updateClient exactly (its own
    // `expectedUpdatedAt` check followed by
    // `updateClientFieldsIfUnstale`'s atomic `WHERE id AND updatedAt`).
    if (
      concurrency &&
      (invitation.sendOperationId !== concurrency.expectedCurrentSendOperationId ||
        invitation.updatedAt.getTime() !== concurrency.expectedUpdatedAt.getTime())
    ) {
      throw new InvitationError(
        'INVITATION_SEND_OPERATION_STALE',
        'This invitation has changed since you last loaded it. Refresh and try again.',
      );
    }

    const client = await repository.findClientEmailById(tx, clientId);
    if (!client?.email) {
      throw new InvitationError(
        'CLIENT_EMAIL_MISSING',
        'This client has no email address on file.',
      );
    }

    const rawToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = computeExpiryFromNow();
    const destinationEmail = normalizeEmail(client.email);
    const reservationInput = {
      tokenHash,
      expiresAt,
      destinationEmail,
      sentAt: new Date(),
      ...(input.deliveryMethod === 'AUTOMATED_EMAIL'
        ? { automated: { sendOperationId: input.idempotencyKey } }
        : {}),
    };

    let updated: InvitationRecord;
    if (concurrency) {
      const conditional = await repository.recordSendReservationIfUnstale(
        tx,
        invitation.id,
        {
          sendOperationId: concurrency.expectedCurrentSendOperationId,
          updatedAt: concurrency.expectedUpdatedAt,
        },
        reservationInput,
      );
      if (!conditional) {
        throw new InvitationError(
          'INVITATION_SEND_OPERATION_STALE',
          'This invitation has changed since you last loaded it. Refresh and try again.',
        );
      }
      updated = conditional;
    } else {
      updated = await repository.recordSendReservation(tx, invitation.id, reservationInput);
    }

    if (input.deliveryMethod === 'AUTOMATED_EMAIL') {
      await repository.insertAuditLog(tx, {
        actorId: actor.id,
        action: auditAction,
        entityType: INVITATION_AUDIT_ENTITY_TYPE,
        entityId: updated.id,
        beforeState: sanitizeInvitationSnapshot(invitation),
        afterState: sanitizeInvitationSnapshot(updated),
      });
    }

    return { kind: 'fresh', invitation: updated, rawToken };
  });
}

export type SendResult = {
  invitation: InvitationRecord;
  delivery:
    'reserved-only' | 'unconfirmed' | 'AUTOMATED_ACCEPTED' | 'PROVIDER_FAILED' | 'already-reserved';
  // The raw, one-time manual invitation URL (Stage 3 Correction and
  // Security Review Pass 1 §2) — present *only* for a freshly reserved
  // MANUAL_EMAIL send/resend (`delivery: 'reserved-only'` on that
  // channel). Never present for AUTOMATED_EMAIL (the client never needs
  // it — Resend delivers the link directly) and never present on an
  // 'already-reserved' cross-request retry (the raw token was never
  // persisted and cannot be safely reconstructed — see
  // `reserveSendOperation`'s doc comment). This is the one and only
  // response, from the one and only code path, that ever returns a
  // complete invitation URL; it is never persisted, logged, audited, or
  // returned by a later GET.
  manualInvitationUrl?: string;
};

/**
 * Attempts the Resend API call for a freshly reserved automated send and
 * records the classified outcome (D-034 Stage 3 Section 7 correction).
 * Never called with a stale/reused raw token — only from the same
 * request/execution that just generated one.
 */
async function attemptAutomatedDelivery(
  invitation: InvitationRecord,
  rawToken: string,
  sendOperationId: string,
): Promise<SendResult> {
  const providerResult = await sendInvitationEmail(
    { to: invitation.destinationEmail!, rawToken, sendOperationId },
    { idempotencyKey: buildResendIdempotencyKey(sendOperationId) },
  );

  if (providerResult.outcome === 'ambiguous') {
    // Leave AUTOMATED_UNCONFIRMED as-is — never guess (D-034 Stage 3
    // Section 3/7 correction).
    return { invitation, delivery: 'unconfirmed' };
  }

  const resolved =
    providerResult.outcome === 'accepted'
      ? {
          deliveryState: 'AUTOMATED_ACCEPTED' as const,
          providerMessageId: providerResult.messageId,
        }
      : { deliveryState: 'PROVIDER_FAILED' as const, providerMessageId: null };

  const finalInvitation = await prisma.$transaction((tx) =>
    repository.recordAutomatedSendOutcome(tx, invitation.id, sendOperationId, resolved),
  );

  return { invitation: finalInvitation ?? invitation, delivery: resolved.deliveryState };
}

/** First send (D-034 Sections 2, 4, 9) — only from INVITATION_PREPARED. */
export async function sendInvitation(
  actor: AuthenticatedUser,
  clientId: string,
  input: SendOrResendInput,
): Promise<SendResult> {
  const outcome = await reserveSendOperation(
    actor,
    clientId,
    input,
    ['INVITATION_PREPARED'],
    INVITATION_AUDIT_ACTIONS.SENT_AUTOMATED,
  );

  if (outcome.kind === 'already-reserved') {
    return { invitation: outcome.invitation, delivery: 'already-reserved' };
  }
  if (input.deliveryMethod !== 'AUTOMATED_EMAIL') {
    return {
      invitation: outcome.invitation,
      delivery: 'reserved-only',
      manualInvitationUrl: buildActivationUrl(outcome.rawToken),
    };
  }
  return attemptAutomatedDelivery(outcome.invitation, outcome.rawToken, input.idempotencyKey);
}

/**
 * Explicit resend/reissue (D-034 Sections 4, 9) — always rotates the
 * token; shares one audit action (RESENT) for both the plain-resend and
 * reissue-after-expiry cases. `concurrency` is required (Stage 3
 * Correction and Security Review Pass 1 §3): the caller must supply the
 * `sendOperationId`/`updatedAt` it last observed via `GET
 * /api/clients/[id]/invitation`, so a delayed retry of a superseded
 * resend can never silently rotate the token again or clobber a newer
 * resend's delivery evidence.
 */
export async function resendInvitation(
  actor: AuthenticatedUser,
  clientId: string,
  input: SendOrResendInput,
  concurrency: ResendConcurrencyPrecondition,
): Promise<SendResult> {
  const outcome = await reserveSendOperation(
    actor,
    clientId,
    input,
    ['INVITATION_SENT', 'INVITATION_OPENED', 'INVITATION_EXPIRED'],
    INVITATION_AUDIT_ACTIONS.RESENT,
    concurrency,
  );

  if (outcome.kind === 'already-reserved') {
    return { invitation: outcome.invitation, delivery: 'already-reserved' };
  }
  if (input.deliveryMethod !== 'AUTOMATED_EMAIL') {
    return {
      invitation: outcome.invitation,
      delivery: 'reserved-only',
      manualInvitationUrl: buildActivationUrl(outcome.rawToken),
    };
  }
  return attemptAutomatedDelivery(outcome.invitation, outcome.rawToken, input.idempotencyKey);
}

/**
 * Confirm-manual-sent (D-034 Sections 2(c), 9, 10) — the explicit,
 * separate staff action attesting a manually-copied link was actually
 * emailed. Idempotent no-op if already MANUALLY_CONFIRMED, regardless of
 * which `idempotencyKey` a retry supplies — this action never rotates a
 * token and is safe to repeat unconditionally, so no further precondition
 * is needed beyond that no-op. `idempotencyKey` (Stage 3 Correction and
 * Security Review Pass 1 §2: a client-supplied, validated UUID, required
 * exactly like send/resend) is stored as `sendOperationId` — this is the
 * confirmation's own idempotency ticket, not a provider-retry token; the
 * manual channel has no provider call to reconcile against, but still
 * benefits from the same "one UUID per deliberate action" discipline the
 * automated channel uses.
 */
export async function confirmManualSend(
  actor: AuthenticatedUser,
  clientId: string,
  idempotencyKey: string,
): Promise<InvitationRecord> {
  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) throw notFoundOrForbidden(actor);

  return runSerializableWithRetry(async (tx) => {
    await assertTravelConsultantAssignment(tx, actor, clientId);

    const invitation = await repository.findInvitationByClientId(tx, clientId);
    if (!invitation) {
      throw new InvitationError(
        'INVITATION_NOT_FOUND',
        'No invitation exists for this client yet.',
      );
    }

    if (invitation.deliveryState === 'MANUALLY_CONFIRMED') {
      return invitation;
    }

    if (invitation.status !== 'INVITATION_SENT' || invitation.deliveryMethod !== null) {
      throw new InvitationError(
        'INVITATION_NOT_SENDABLE',
        'This invitation is not in a state that can be manually confirmed — send it first.',
      );
    }

    const updated = await repository.recordManualConfirmation(tx, invitation.id, {
      sendOperationId: idempotencyKey,
      deliveryConfirmedByStaffId: actor.id,
      deliveryConfirmedAt: new Date(),
    });

    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: INVITATION_AUDIT_ACTIONS.SENT_MANUAL_CONFIRMED,
      entityType: INVITATION_AUDIT_ENTITY_TYPE,
      entityId: updated.id,
      beforeState: sanitizeInvitationSnapshot(invitation),
      afterState: sanitizeInvitationSnapshot(updated),
    });

    return updated;
  });
}

/** Revoke (D-034 Sections 3, 9). Idempotent no-op if already revoked. */
export async function revokeInvitation(
  actor: AuthenticatedUser,
  clientId: string,
  reason: string,
): Promise<InvitationRecord> {
  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) throw notFoundOrForbidden(actor);

  return runSerializableWithRetry(async (tx) => {
    await assertTravelConsultantAssignment(tx, actor, clientId);

    const invitation = await repository.findInvitationByClientId(tx, clientId);
    if (!invitation) {
      throw new InvitationError('INVITATION_NOT_FOUND', 'No invitation exists for this client.');
    }

    if (invitation.status === 'INVITATION_REVOKED') {
      return invitation;
    }
    if (invitation.status === 'ACCOUNT_ACTIVATED') {
      throw new InvitationError(
        'INVITATION_ALREADY_ACTIVATED',
        'This invitation has already been activated and cannot be revoked.',
      );
    }

    const updated = await repository.recordRevocation(tx, invitation.id, new Date());
    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: INVITATION_AUDIT_ACTIONS.REVOKED,
      entityType: INVITATION_AUDIT_ENTITY_TYPE,
      entityId: updated.id,
      beforeState: sanitizeInvitationSnapshot(invitation),
      afterState: { ...sanitizeInvitationSnapshot(updated), reason },
    });

    return updated;
  });
}

// --- Webhook handling (D-034 Section 2(b), Stage 3 Section 6 correction) ---

function extractSendOperationTag(data: VerifiedWebhookEvent['data']): string | undefined {
  return data.tags?.sendOperationId;
}

/**
 * Correlates a webhook event to exactly one invitation, by
 * `providerMessageId` (`@unique`) and by the signed `sendOperationId` tag
 * — both lookups are attempted whenever both identifiers are present
 * (Stage 3 Correction and Security Review Pass 1 §4: "if providerMessageId
 * and the signed sendOperationId tag resolve to different rows, reject
 * without mutation" — a requirement neither lookup alone can satisfy; an
 * earlier version of this function only consulted the tag as a fallback
 * when the messageId lookup failed, which could never detect two
 * independently-successful lookups disagreeing). Two independent
 * successful lookups resolving to different row ids, or a tag-resolved
 * row whose own `providerMessageId` already disagrees with this event's
 * (the messageId-lookup-failed case — e.g. a data anomaly predating the
 * `providerMessageId` unique index), are both treated as an unresolvable
 * ambiguity: return `'ambiguous'` and the caller must not mutate
 * anything. The `sendOperationId` tag alone is used only when no
 * `providerMessageId` lookup was possible at all (event carries no
 * `email_id`) or found nothing (the initial provider response timed out
 * and providerMessageId was never captured) — the primary correlation
 * signal is always `providerMessageId` when available.
 *
 * Takes `tx` (a transaction client), never the module-level `prisma`
 * singleton (Stage 3 Correction and Security Review Pass 1 §4): every
 * caller runs this *inside* the same `runSerializableWithRetry`
 * transaction as the mutation that follows it, so a concurrent
 * resend/revoke racing against this exact row is either serialized before
 * this read (this correlation then sees the fresh state) or causes a
 * genuine PostgreSQL serialization conflict that aborts and retries this
 * whole read-then-write unit — never a read here followed by a stale
 * write landing after an intervening resend/revoke has already moved the
 * row on. This is the same transactional-recheck discipline D-031 F-01
 * already established for every other mutation in this codebase, applied
 * here to a read-then-conditionally-write sequence instead of an
 * authorization recheck.
 */
async function correlateWebhookEvent(
  tx: Prisma.TransactionClient,
  messageId: string | undefined,
  sendOperationTag: string | undefined,
): Promise<InvitationRecord | 'ambiguous' | null> {
  const byMessageId = messageId
    ? await repository.findInvitationByProviderMessageId(tx, messageId)
    : null;
  const byOperation = sendOperationTag
    ? await repository.findInvitationBySendOperationId(tx, sendOperationTag)
    : null;

  if (byMessageId && byOperation && byMessageId.id !== byOperation.id) {
    return 'ambiguous';
  }
  if (
    byOperation &&
    byOperation.providerMessageId &&
    messageId &&
    byOperation.providerMessageId !== messageId
  ) {
    return 'ambiguous';
  }

  return byMessageId ?? byOperation ?? null;
}

const PROVIDER_TERMINAL_STATES = {
  'email.delivered': 'PROVIDER_DELIVERED',
  'email.bounced': 'PROVIDER_BOUNCED',
  'email.complained': 'PROVIDER_COMPLAINED',
  'email.failed': 'PROVIDER_FAILED',
  'email.suppressed': 'PROVIDER_SUPPRESSED',
} as const;

const RECONCILING_EVENTS = new Set(['email.sent', 'email.delivery_delayed']);

// Events that intentionally result in acknowledgement with no invitation
// lifecycle mutation (user-authorized Stage 3 Section 6 contract):
// email.opened / email.clicked are recipient-engagement signals that must
// never substitute for Stage 5's own token-bearing OPENED transition;
// email.received / email.scheduled are not meaningful for outbound
// invitation sending. Any other/unknown event type is likewise
// acknowledged and ignored, never treated as an error.

/**
 * Verifies and applies one Resend webhook request (D-034 Stage 3 Section
 * 6/8). Returns the HTTP status the route should respond with — 401 on an
 * invalid/missing signature (never processed), 200 for every
 * successfully-verified event regardless of whether it produced a
 * mutation (acknowledged-but-ignored event types, or a correlation that
 * found nothing / was ambiguous, still return 200 so the provider does not
 * retry a request it did nothing wrong to send).
 */
export async function handleResendWebhookEvent(
  rawBody: string,
  headers: { id: string; timestamp: string; signature: string },
): Promise<{ status: 200 | 401 }> {
  let event: VerifiedWebhookEvent;
  try {
    event = verifyResendWebhook(rawBody, headers);
  } catch {
    return { status: 401 };
  }

  const messageId = event.data.email_id;
  const sendOperationTag = extractSendOperationTag(event.data);

  if (RECONCILING_EVENTS.has(event.type)) {
    if (!messageId) return { status: 200 };
    await runSerializableWithRetry(async (tx) => {
      const target = await correlateWebhookEvent(tx, messageId, sendOperationTag);
      if (!target || target === 'ambiguous') return;
      await repository.reconcileUnconfirmedToAccepted(tx, target.id, messageId);
    });
    return { status: 200 };
  }

  const terminalState =
    PROVIDER_TERMINAL_STATES[event.type as keyof typeof PROVIDER_TERMINAL_STATES];
  if (terminalState) {
    // Every Resend email.* event carries `email_id` (the SDK's own
    // BaseEmailEventData types it as required, non-optional) — required
    // here defensively, and because
    // `portal_invitation_provider_confirmed_requires_message_id` demands
    // a non-null providerMessageId for every one of these states except
    // PROVIDER_FAILED (Stage 3 Correction and Security Review Pass 1 §4).
    if (!messageId) return { status: 200 };
    await runSerializableWithRetry(async (tx) => {
      const target = await correlateWebhookEvent(tx, messageId, sendOperationTag);
      if (!target || target === 'ambiguous') return;
      await repository.applyProviderDeliveryState(tx, target.id, terminalState, messageId);
    });
    return { status: 200 };
  }

  // email.opened, email.clicked, email.received, email.scheduled, and any
  // unrecognized future event type: acknowledge, no mutation.
  return { status: 200 };
}

// Re-exported so Stage 5's activation endpoint (a separate stage) can build
// the identical activation link shape from a raw token without duplicating
// this feature's own URL-construction logic.
export { buildActivationUrl };
