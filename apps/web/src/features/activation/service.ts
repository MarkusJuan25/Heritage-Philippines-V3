import { Prisma } from '@/generated/prisma/client';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';

import {
  INVITATION_AUDIT_ACTIONS,
  INVITATION_AUDIT_ENTITY_TYPE,
  sanitizeInvitationSnapshot,
} from '@/features/invitations/audit';
import * as invitationRepository from '@/features/invitations/repository';
import type { InvitationRecord } from '@/features/invitations/repository';
import { hashInvitationToken } from '@/features/invitations/token';

import { ActivationError } from './errors';
import * as repository from './repository';

// D-037 Section 5: eligibility for both Continue and Activate is
// `status ∈ {INVITATION_SENT, INVITATION_OPENED}` AND `expiresAt >=
// now()`, evaluated fresh at the moment of each request — never from a
// cached prior read. Effective expiry is always computed from
// `expiresAt` directly, independent of what `status` currently reads
// (D-034 Section 4) — a persisted status can lag effective expiry.
function isEligible(invitation: InvitationRecord, now: Date): boolean {
  if (invitation.status !== 'INVITATION_SENT' && invitation.status !== 'INVITATION_OPENED') {
    return false;
  }
  return invitation.expiresAt !== null && invitation.expiresAt.getTime() >= now.getTime();
}

/**
 * D-037 Section 9's complete `emailVerified` matrix, reproduced exactly —
 * a pure function of `deliveryMethod`/`deliveryState` alone. Activation
 * never collects an email field from the caller (the new `User.email` is
 * always the invitation's own frozen `destinationEmail`, never
 * client-supplied input — see `activateAccount` below), so D-034 §7's
 * "activation-collected email differing from the recorded destination"
 * disqualifying case is structurally unreachable under this
 * implementation and needs no separate handling here.
 */
export function computeEmailVerified(
  deliveryMethod: InvitationRecord['deliveryMethod'],
  deliveryState: InvitationRecord['deliveryState'],
): boolean {
  if (deliveryMethod === 'AUTOMATED_EMAIL') {
    return deliveryState === 'AUTOMATED_ACCEPTED' || deliveryState === 'PROVIDER_DELIVERED';
  }
  if (deliveryMethod === 'MANUAL_EMAIL') {
    return deliveryState === 'MANUALLY_CONFIRMED';
  }
  return false;
}

// D-038 Section 3/§7 (superseding D-037 Sections 3, 5, 14): `GET
// /activate` no longer performs any server-side invitation lookup at
// all — the raw token now travels only in the URL fragment (D-038
// Section 2), which no server-side code, including this module, ever
// receives. The function that used to back that lookup,
// `getActivationPageState`, is removed as dead code rather than kept
// unused — nothing calls it any longer.

export type ContinueResult = { opened: true };

/**
 * The explicit Continue transition (D-037 Section 6) — the exactly-once
 * core invariant. Inside one `runSerializableWithRetry` transaction, the
 * invitation is re-fetched fresh by token digest as the first operation.
 * `INVITATION_SENT → INVITATION_OPENED` sets `openedAt` once and inserts
 * exactly one `PORTAL_INVITATION_OPENED` AuditLog row with
 * `actorKind: 'ANONYMOUS'`/`actorId: null`; an already-`INVITATION_OPENED`
 * row is an idempotent no-op — no update, no additional audit row; every
 * ineligible condition is rejected with the generic `ActivationError` and
 * creates no audit row at all.
 */
export async function continueInvitation(rawToken: string): Promise<ContinueResult> {
  const tokenHash = hashInvitationToken(rawToken);

  return runSerializableWithRetry(async (tx) => {
    const invitation = await invitationRepository.findInvitationByTokenHash(tx, tokenHash);
    if (!invitation || !isEligible(invitation, new Date())) {
      throw new ActivationError();
    }

    if (invitation.status === 'INVITATION_OPENED') {
      return { opened: true };
    }

    const updated = await invitationRepository.markInvitationOpened(tx, invitation.id, new Date());
    if (!updated) {
      // Structurally shouldn't happen: this transaction just confirmed
      // status === INVITATION_SENT moments ago, in the same SERIALIZABLE
      // transaction — no concurrent write could change it without this
      // transaction itself aborting with a serialization conflict first
      // (retried by runSerializableWithRetry, never silently missed
      // here). Defensive only: the safe, generic rejection, never a raw
      // crash, if this invariant were ever violated.
      throw new ActivationError();
    }

    await invitationRepository.insertAuditLog(tx, {
      actorKind: 'ANONYMOUS',
      action: INVITATION_AUDIT_ACTIONS.OPENED,
      entityType: INVITATION_AUDIT_ENTITY_TYPE,
      entityId: updated.id,
      beforeState: sanitizeInvitationSnapshot(invitation),
      afterState: sanitizeInvitationSnapshot(updated),
    });

    return { opened: true };
  });
}

export type ActivateResult = { activated: true };

/**
 * The activation transaction (D-037 Section 8). Steps (a)-(c) — Origin/
 * media-type gates (Stage 5d), and password hashing — happen in the
 * caller before this function is ever invoked: `passwordHash` arrives
 * already computed, outside this (or any) transaction, so the deliberately
 * slow hashing step never extends this transaction's wall-clock duration.
 * Steps (d)-(l) happen here, in exact order: (d) fresh eligibility
 * recheck, first, inside `tx`; (e) any-role normalized-email collision
 * check; (f) `ClientProfile` consistency check; (g)-(i) atomic `User` +
 * `Account` + `ClientProfile` creation; (j) no `Client` field is ever
 * modified (this function never writes to the `client` table); (k)
 * `PortalInvitation → ACCOUNT_ACTIVATED`; (l) the `PORTAL_INVITATION_ACTIVATED`
 * audit insert, after the new `User` row exists, since its `actorId`
 * foreign key requires it. Any failure at (d)-(f) rolls the whole
 * transaction back with zero business-domain mutation. If two concurrent
 * activation requests race past the pre-checks, the database's own unique
 * constraints (`user_email_key`, `user_email_lower_key`,
 * `client_profile_userId_key`, `client_profile_clientId_key`) are the
 * final backstop — caught below and translated to the identical generic
 * rejection, never a raw database error.
 */
export async function activateAccount(
  rawToken: string,
  passwordHash: string,
): Promise<ActivateResult> {
  const tokenHash = hashInvitationToken(rawToken);

  try {
    return await runSerializableWithRetry(async (tx) => {
      const invitation = await invitationRepository.findInvitationByTokenHash(tx, tokenHash);
      if (!invitation || !isEligible(invitation, new Date())) {
        throw new ActivationError();
      }

      if (!invitation.destinationEmail) {
        // Structurally unreachable — isEligible() above already confirmed
        // a non-null expiresAt, and the schema's own token-triple CHECK
        // constraint guarantees destinationEmail is non-null whenever
        // expiresAt is. Defensive only.
        throw new ActivationError();
      }

      const existingUser = await repository.findUserByEmail(tx, invitation.destinationEmail);
      if (existingUser) {
        throw new ActivationError();
      }

      const existingProfile = await repository.findClientProfileByClientId(tx, invitation.clientId);
      if (existingProfile) {
        throw new ActivationError();
      }

      const client = await repository.findClientNameById(tx, invitation.clientId);
      if (!client) {
        // Structurally unreachable — PortalInvitation.clientId is a
        // required foreign key to an existing Client — but never assumed.
        throw new ActivationError();
      }

      const emailVerified = computeEmailVerified(
        invitation.deliveryMethod,
        invitation.deliveryState,
      );

      const created = await repository.createActivatedAccount(tx, {
        clientId: invitation.clientId,
        name: client.fullName,
        email: invitation.destinationEmail,
        passwordHash,
        emailVerified,
      });

      const updatedInvitation = await invitationRepository.markInvitationActivated(
        tx,
        invitation.id,
        new Date(),
      );

      await invitationRepository.insertAuditLog(tx, {
        actorKind: 'USER',
        actorId: created.userId,
        action: INVITATION_AUDIT_ACTIONS.ACTIVATED,
        entityType: INVITATION_AUDIT_ENTITY_TYPE,
        entityId: updatedInvitation.id,
        beforeState: sanitizeInvitationSnapshot(invitation),
        afterState: sanitizeInvitationSnapshot(updatedInvitation),
      });

      return { activated: true };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ActivationError();
    }
    throw error;
  }
}
