import { randomUUID } from 'node:crypto';

import type {
  Prisma,
  PortalInvitationDeliveryMethod,
  PortalInvitationDeliveryState,
  PortalInvitationStatus,
} from '@/generated/prisma/client';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a Prisma client or transaction client as its first
// argument (named `db`, not `client` — this file's own `client.client.*`
// visual collision, mirroring features/assignments/repository.ts's
// identical rationale) so callers can run reads inside the same
// serializable transaction as the writes they gate — none of these
// functions open their own transaction.

export type InvitationRecord = {
  id: string;
  clientId: string;
  status: PortalInvitationStatus;
  tokenHash: string | null;
  expiresAt: Date | null;
  destinationEmail: string | null;
  deliveryMethod: PortalInvitationDeliveryMethod | null;
  deliveryState: PortalInvitationDeliveryState;
  sendOperationId: string | null;
  providerMessageId: string | null;
  deliveryConfirmedAt: Date | null;
  deliveryConfirmedByStaffId: string | null;
  sentAt: Date | null;
  openedAt: Date | null;
  activatedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const INVITATION_SELECT = {
  id: true,
  clientId: true,
  status: true,
  tokenHash: true,
  expiresAt: true,
  destinationEmail: true,
  deliveryMethod: true,
  deliveryState: true,
  sendOperationId: true,
  providerMessageId: true,
  deliveryConfirmedAt: true,
  deliveryConfirmedByStaffId: true,
  sentAt: true,
  openedAt: true,
  activatedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function findInvitationByClientId(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<InvitationRecord | null> {
  return db.portalInvitation.findUnique({ where: { clientId }, select: INVITATION_SELECT });
}

export async function findInvitationByProviderMessageId(
  db: Prisma.TransactionClient,
  providerMessageId: string,
): Promise<InvitationRecord | null> {
  return db.portalInvitation.findUnique({
    where: { providerMessageId },
    select: INVITATION_SELECT,
  });
}

export async function findInvitationBySendOperationId(
  db: Prisma.TransactionClient,
  sendOperationId: string,
): Promise<InvitationRecord | null> {
  return db.portalInvitation.findUnique({ where: { sendOperationId }, select: INVITATION_SELECT });
}

export async function findClientEmailById(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<{ email: string | null } | null> {
  return db.client.findUnique({ where: { id: clientId }, select: { email: true } });
}

/**
 * Existence-only Client lookup — needed because `canAccessClient` returns
 * `{ allowed: true }` unconditionally for ADMIN_MANAGER regardless of
 * whether the target Client id actually exists (see its own doc comment:
 * "this function alone cannot distinguish 'not authorized' from 'does not
 * exist'"). `prepareInvitation` (features/invitations/service.ts) is the
 * one mutation here that would otherwise attempt an insert against a
 * nonexistent `clientId` and surface a raw foreign-key-violation database
 * error instead of a clean CLIENT_NOT_FOUND — every other mutation in this
 * feature reads an existing PortalInvitation row first, which (via that
 * row's own foreign key) already proves the Client exists.
 */
export async function findClientById(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<{ id: string } | null> {
  return db.client.findUnique({ where: { id: clientId }, select: { id: true } });
}

/** Prepare (D-034 Section 3): creates the one-row-per-Client invitation, always in INVITATION_PREPARED, with no token yet generated. */
export async function createInvitation(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<InvitationRecord> {
  return db.portalInvitation.create({
    data: { id: randomUUID(), clientId, status: 'INVITATION_PREPARED' },
    select: INVITATION_SELECT,
  });
}

export type SendReservationInput = {
  tokenHash: string;
  expiresAt: Date;
  destinationEmail: string;
  sentAt: Date;
  // Only ever supplied together, for the AUTOMATED_EMAIL channel — see
  // features/invitations/service.ts's doc comment on why the MANUAL_EMAIL
  // channel leaves deliveryMethod/deliveryState/sendOperationId untouched
  // (still NOT_ATTEMPTED) until the separate confirm-manual-sent action.
  automated?: { sendOperationId: string };
};

/**
 * Records a fresh send/resend/reissue token reservation (D-034 Sections 4,
 * 6, 9). Always sets status to INVITATION_SENT and rotates the token
 * triple; for the automated channel, also reserves deliveryMethod =
 * AUTOMATED_EMAIL, deliveryState = AUTOMATED_UNCONFIRMED, and
 * sendOperationId — all inside the same transaction, before any Resend API
 * call is ever made (D-034 Section 4: no transaction may remain open
 * across that call).
 */
// Shared write-data shape for both the unconditional (`send`, first-time
// only) and the CAS-conditional (`resend`/reissue) reservation writers
// below. `providerMessageId` is unconditionally cleared to null on every
// fresh reservation, regardless of channel (Stage 3 Correction and
// Security Review Pass 1 §4): a stale providerMessageId left over from a
// prior automated attempt would otherwise let a late webhook event for
// that superseded attempt still correlate to this row via
// `findInvitationByProviderMessageId` and mutate deliveryState for an
// operation that is no longer current. Clearing it here — atomically, in
// the same write that rotates the token — closes that correlation path at
// its source; the webhook handler's own sendOperationId-tag fallback then
// naturally finds nothing for a superseded tag either, since
// `sendOperationId` is rotated in this same write for the automated
// channel.
function sendReservationData(input: SendReservationInput) {
  return {
    status: 'INVITATION_SENT' as const,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    destinationEmail: input.destinationEmail,
    sentAt: input.sentAt,
    // The entire delivery-evidence sub-record is reset to the new
    // channel's clean slate on every fresh reservation, not just
    // providerMessageId (Stage 3 Correction and Security Review Pass 1
    // §4/§7's finding, generalized): a resend/reissue can switch channel,
    // or reissue over a row that had already reached a provider-terminal
    // or MANUALLY_CONFIRMED state — leaving any of deliveryMethod,
    // deliveryState, sendOperationId, or the manual-confirmation
    // evidence fields (deliveryConfirmedAt/deliveryConfirmedByStaffId)
    // stale would violate one of
    // portal_invitation_provider_confirmed_requires_message_id,
    // portal_invitation_manual_confirmation_evidence, or
    // portal_invitation_send_operation_id_presence, all three of which
    // this codebase's own real-database integration test caught. A new
    // token means the old delivery evidence no longer describes the
    // current operation, regardless of which specific field combination
    // would have tripped a constraint.
    providerMessageId: null,
    deliveryConfirmedAt: null,
    deliveryConfirmedByStaffId: null,
    ...(input.automated
      ? {
          deliveryMethod: 'AUTOMATED_EMAIL' as const,
          deliveryState: 'AUTOMATED_UNCONFIRMED' as const,
          sendOperationId: input.automated.sendOperationId,
        }
      : {
          deliveryMethod: null,
          deliveryState: 'NOT_ATTEMPTED' as const,
          sendOperationId: null,
        }),
  };
}

export async function recordSendReservation(
  db: Prisma.TransactionClient,
  id: string,
  input: SendReservationInput,
): Promise<InvitationRecord> {
  return db.portalInvitation.update({
    where: { id },
    data: sendReservationData(input),
    select: INVITATION_SELECT,
  });
}

/**
 * The optimistic-concurrency-checked reservation writer used by
 * `resendInvitation` (Stage 3 Correction and Security Review Pass 1 §3).
 * The WHERE clause itself carries the precondition — an atomic,
 * single-statement conditional update, the same established pattern as
 * `features/clients/repository.ts`'s `updateClientFieldsIfUnstale`
 * (`WHERE id AND updatedAt`) — so a concurrent write landing between the
 * caller's own read and this write can never be silently overwritten:
 * `count === 0` means the precondition no longer held (a newer resend/
 * reissue already superseded it, or a webhook already moved the row), and
 * the caller must treat that as a stale-mismatch, never fall back to an
 * unconditional write.
 */
export async function recordSendReservationIfUnstale(
  db: Prisma.TransactionClient,
  id: string,
  precondition: { sendOperationId: string | null; updatedAt: Date },
  input: SendReservationInput,
): Promise<InvitationRecord | null> {
  const { count } = await db.portalInvitation.updateMany({
    where: { id, sendOperationId: precondition.sendOperationId, updatedAt: precondition.updatedAt },
    data: sendReservationData(input),
  });
  if (count === 0) return null;
  return db.portalInvitation.findUnique({ where: { id }, select: INVITATION_SELECT });
}

/**
 * Applies the resolved outcome of an automated send attempt
 * (D-034 Stage 3 Section 7 correction: accepted / definite failure).
 * Conditioned on the row still being AUTOMATED_UNCONFIRMED under the exact
 * `sendOperationId` this attempt reserved — if a webhook has already
 * resolved the row (or a concurrent attempt has), this is a no-op (`count
 * === 0`), never a regression. Returns null when no row matched.
 */
export async function recordAutomatedSendOutcome(
  db: Prisma.TransactionClient,
  id: string,
  sendOperationId: string,
  outcome: {
    deliveryState: 'AUTOMATED_ACCEPTED' | 'PROVIDER_FAILED';
    providerMessageId: string | null;
  },
): Promise<InvitationRecord | null> {
  const { count } = await db.portalInvitation.updateMany({
    where: { id, sendOperationId, deliveryState: 'AUTOMATED_UNCONFIRMED' },
    data: { deliveryState: outcome.deliveryState, providerMessageId: outcome.providerMessageId },
  });
  if (count === 0) return null;
  return db.portalInvitation.findUnique({ where: { id }, select: INVITATION_SELECT });
}

/**
 * Webhook-driven reconciliation of AUTOMATED_UNCONFIRMED -> AUTOMATED_ACCEPTED
 * (email.sent / email.delivery_delayed — D-034 Stage 3 Section 6). Only
 * ever transitions FROM AUTOMATED_UNCONFIRMED ("without regressing a later
 * state" — the user-authorized contract's exact wording) — a no-op
 * (`count === 0`) if the row has already moved on for any reason.
 */
export async function reconcileUnconfirmedToAccepted(
  db: Prisma.TransactionClient,
  id: string,
  providerMessageId: string,
): Promise<InvitationRecord | null> {
  const { count } = await db.portalInvitation.updateMany({
    where: { id, deliveryState: 'AUTOMATED_UNCONFIRMED' },
    data: { deliveryState: 'AUTOMATED_ACCEPTED', providerMessageId },
  });
  if (count === 0) return null;
  return db.portalInvitation.findUnique({ where: { id }, select: INVITATION_SELECT });
}

/**
 * Webhook-driven terminal/near-terminal provider states (email.delivered /
 * bounced / complained / failed / suppressed — D-034 Stage 3 Section 6).
 * Applied unconditionally (not gated to a specific prior deliveryState):
 * unlike the AUTOMATED_UNCONFIRMED reconciliation above, these represent
 * genuinely new provider information that can legitimately arrive after an
 * earlier state (e.g. a complaint filed after delivery) — D-034 does not
 * define an ordering among them to enforce, and setting an already-current
 * value is a harmless, idempotent no-op.
 *
 * `providerMessageId` is set in the same write (Stage 3 Correction and
 * Security Review Pass 1 §4 finding): the schema's own
 * `portal_invitation_provider_confirmed_requires_message_id` CHECK
 * constraint requires a non-null `providerMessageId` for every one of
 * these states except `PROVIDER_FAILED` — a value this function's only
 * caller (the webhook handler) always has, since every Resend email.*
 * event carries `email_id`. Passing it through here, rather than leaving
 * a stale or null value from an earlier write, keeps the row's own
 * evidence trail accurate and satisfies the constraint unconditionally.
 */
export async function applyProviderDeliveryState(
  db: Prisma.TransactionClient,
  id: string,
  deliveryState:
    | 'PROVIDER_DELIVERED'
    | 'PROVIDER_BOUNCED'
    | 'PROVIDER_COMPLAINED'
    | 'PROVIDER_FAILED'
    | 'PROVIDER_SUPPRESSED',
  providerMessageId: string,
): Promise<InvitationRecord> {
  return db.portalInvitation.update({
    where: { id },
    data: { deliveryState, providerMessageId },
    select: INVITATION_SELECT,
  });
}

export type ManualConfirmationInput = {
  sendOperationId: string;
  deliveryConfirmedByStaffId: string;
  deliveryConfirmedAt: Date;
};

/** Confirm-manual-sent (D-034 Sections 2(c), 9, 10) — the single atomic point at which the manual channel's deliveryMethod/deliveryState/sendOperationId/confirmation-evidence are all populated together for the first time. */
export async function recordManualConfirmation(
  db: Prisma.TransactionClient,
  id: string,
  input: ManualConfirmationInput,
): Promise<InvitationRecord> {
  return db.portalInvitation.update({
    where: { id },
    data: {
      deliveryMethod: 'MANUAL_EMAIL',
      deliveryState: 'MANUALLY_CONFIRMED',
      sendOperationId: input.sendOperationId,
      deliveryConfirmedByStaffId: input.deliveryConfirmedByStaffId,
      deliveryConfirmedAt: input.deliveryConfirmedAt,
    },
    select: INVITATION_SELECT,
  });
}

/**
 * Revoke (D-034 Section 3, 9). Clears the token triple back to null
 * together (the schema's `portal_invitation_token_triple_nullability`
 * constraint permits an all-null row for any status) — an already-revoked
 * token hash serves no purpose and is cleared as defense-in-depth, not
 * left to linger.
 */
export async function recordRevocation(
  db: Prisma.TransactionClient,
  id: string,
  revokedAt: Date,
): Promise<InvitationRecord> {
  return db.portalInvitation.update({
    where: { id },
    data: {
      status: 'INVITATION_REVOKED',
      revokedAt,
      tokenHash: null,
      expiresAt: null,
      destinationEmail: null,
    },
    select: INVITATION_SELECT,
  });
}

export async function insertAuditLog(
  db: Prisma.TransactionClient,
  entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    beforeState?: Prisma.InputJsonValue;
    afterState?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      id: randomUUID(),
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeState: entry.beforeState,
      afterState: entry.afterState,
    },
  });
}
