import { randomUUID } from 'node:crypto';

import { generateRandomString, hashPassword } from 'better-auth/crypto';

import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';
import type { AuthenticatedUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { sanitizeAccountSnapshot, STAFF_AUDIT_ACTIONS, STAFF_AUDIT_ENTITY_TYPE } from './audit';
import { StaffManagementError } from './errors';
import * as repository from './repository';
import type { StaffAccountRecord } from './repository';
import type { CreateStaffAccountInput, ListStaffAccountsQuery } from './schemas';

// SERIALIZABLE-transaction-with-retry is a shared utility
// (@/lib/serializable-transaction) — see its doc comment for why. Required
// here by apps/web/prisma/schema.prisma invariant #1: the "is this the
// last active SYSTEM_ADMINISTRATOR" check and the change it gates must run
// in one serializable transaction with retry handling, so two concurrent
// requests can't both read "2 admins remain" and both proceed to
// demote/deactivate one each, leaving zero.

function assertNotSelfAction(actor: AuthenticatedUser, targetId: string): void {
  if (actor.id === targetId) {
    throw new StaffManagementError(
      'SELF_ACTION_FORBIDDEN',
      'You cannot perform this action on your own account.',
    );
  }
}

function notFound(): never {
  throw new StaffManagementError('STAFF_ACCOUNT_NOT_FOUND', 'Staff account not found.');
}

/**
 * Rejects a role change or deactivation that would leave zero active
 * SYSTEM_ADMINISTRATOR accounts (apps/web/prisma/schema.prisma invariant
 * #1; blueprint Section 4.1). Only relevant when the target is currently
 * an active SYSTEM_ADMINISTRATOR — callers check that before calling this.
 */
async function assertLastAdministratorRemains(
  tx: Prisma.TransactionClient,
  targetId: string,
): Promise<void> {
  const remaining = await repository.countActiveSystemAdministrators(tx, targetId);
  if (remaining < 1) {
    throw new StaffManagementError(
      'LAST_ADMINISTRATOR_PROTECTED',
      'This action would leave no active System Administrator account. Promote another account to System Administrator first.',
    );
  }
}

export type ListStaffAccountsResult = {
  items: StaffAccountRecord[];
  page: number;
  pageSize: number;
  total: number;
};

// Read-only — no assignment scoping applies (blueprint Section 4.1's
// staff-account management is a platform-wide System Administrator
// capability, not assignment-based like a Travel Consultant's leads), so
// no `actor` argument is needed beyond the route-level role gate.
export async function listStaffAccounts(
  query: ListStaffAccountsQuery,
): Promise<ListStaffAccountsResult> {
  const skip = (query.page - 1) * query.pageSize;
  const { items, total } = await repository.listStaffAccounts(prisma, {
    role: query.role,
    isActive: query.isActive,
    search: query.search,
    skip,
    take: query.pageSize,
  });
  return { items, page: query.page, pageSize: query.pageSize, total };
}

export async function getStaffAccountById(targetId: string): Promise<StaffAccountRecord> {
  const record = await repository.findStaffById(prisma, targetId);
  if (!record) notFound();
  return record;
}

export type CreateStaffAccountResult = {
  account: StaffAccountRecord;
  initialPassword: string;
};

/**
 * Creates a staff account (blueprint Section 4.1: "Create... platform user
 * accounts"). Bypasses Better Auth's public sign-up endpoint entirely
 * (disabled — see auth.ts) and instead writes directly through Prisma
 * using Better Auth's own `hashPassword`, the same approach
 * prisma/seed.ts already uses — see docs/HERITAGE_V3_DECISIONS_LOG.md
 * D-012.
 */
export async function createStaffAccount(
  actor: AuthenticatedUser,
  input: CreateStaffAccountInput,
): Promise<CreateStaffAccountResult> {
  const existing = await repository.findUserByEmail(prisma, input.email);
  if (existing) {
    throw new StaffManagementError(
      'EMAIL_ALREADY_EXISTS',
      'An account with this email address already exists.',
    );
  }

  // Generated when the caller doesn't supply one. This plaintext value is
  // returned exactly once, in this function's result, for the System
  // Administrator to relay to the new staff member out-of-band — it is
  // never logged (no console.log/console.error of it anywhere in this
  // module) and never written to AuditLog (sanitizeAccountSnapshot below
  // only ever reads id/name/email/role/isActive from the created User
  // row, which never has a password field — see
  // apps/web/prisma/schema.prisma invariant #4).
  const initialPassword = input.password ?? generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');
  const passwordHash = await hashPassword(initialPassword);
  const newId = randomUUID();

  const account = await prisma.$transaction(async (tx) => {
    const created = await repository.createStaffUser(tx, {
      id: newId,
      name: input.name,
      email: input.email,
      role: input.role,
      passwordHash,
      title: input.title,
      phone: input.phone,
    });

    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: STAFF_AUDIT_ACTIONS.ACCOUNT_CREATED,
      entityType: STAFF_AUDIT_ENTITY_TYPE,
      entityId: created.id,
      afterState: sanitizeAccountSnapshot(created),
    });

    return created;
  });

  return { account, initialPassword };
}

/**
 * Changes a staff account's role (blueprint Section 4.1: "assign roles to
 * staff accounts"). Self-action is rejected outright; demoting the last
 * active SYSTEM_ADMINISTRATOR is rejected inside the same serializable
 * transaction that would apply the change (invariant #1). A successful
 * change revokes the target's existing sessions in the same transaction
 * (invariant #2) — combined with auth.ts's sign-in check, the target is
 * fully signed out under their old role and cannot sign back in with
 * stale session data.
 */
export async function changeStaffRole(
  actor: AuthenticatedUser,
  targetId: string,
  newRole: AppRole,
): Promise<StaffAccountRecord> {
  assertNotSelfAction(actor, targetId);

  return runSerializableWithRetry(async (tx) => {
    const target = await repository.findStaffById(tx, targetId);
    if (!target) notFound();

    if (target.role === newRole) {
      // Idempotent no-op: no state change, so no duplicate audit entry and
      // no unnecessary session revocation for a caller retrying a request
      // whose response was lost.
      return target;
    }

    if (target.role === 'SYSTEM_ADMINISTRATOR') {
      await assertLastAdministratorRemains(tx, targetId);
    }

    const updated = await repository.updateUserRole(tx, targetId, newRole);
    await repository.deleteSessionsForUser(tx, targetId);
    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: STAFF_AUDIT_ACTIONS.ROLE_CHANGED,
      entityType: STAFF_AUDIT_ENTITY_TYPE,
      entityId: targetId,
      beforeState: { role: target.role },
      afterState: { role: updated.role },
    });

    return updated;
  });
}

/**
 * Deactivates a staff account (blueprint Section 4.1: "deactivate platform
 * user accounts"; admin-dashboard.md's "Destructive and Irreversible
 * Actions" — logged with actor, timestamp, and reason). Self-action and
 * last-administrator protections mirror changeStaffRole. Idempotent: a
 * retry against an already-deactivated account is a no-op, not an error.
 */
export async function deactivateStaffAccount(
  actor: AuthenticatedUser,
  targetId: string,
  reason: string,
): Promise<StaffAccountRecord> {
  assertNotSelfAction(actor, targetId);

  return runSerializableWithRetry(async (tx) => {
    const target = await repository.findStaffById(tx, targetId);
    if (!target) notFound();

    if (!target.isActive) {
      return target;
    }

    if (target.role === 'SYSTEM_ADMINISTRATOR') {
      await assertLastAdministratorRemains(tx, targetId);
    }

    const updated = await repository.setUserActive(tx, targetId, false);
    await repository.deleteSessionsForUser(tx, targetId);
    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: STAFF_AUDIT_ACTIONS.ACCOUNT_DEACTIVATED,
      entityType: STAFF_AUDIT_ENTITY_TYPE,
      entityId: targetId,
      beforeState: { isActive: true },
      afterState: { isActive: false, reason },
    });

    return updated;
  });
}

/**
 * Reactivates a previously deactivated staff account. No last-administrator
 * check applies (reactivation only ever increases the pool of active
 * administrators). No serializable-transaction race exists either — unlike
 * deactivation/role-change, there's no concurrent "last one remaining"
 * condition to protect — but the mutation and its audit entry still run in
 * one transaction for atomicity. No session revocation: a deactivated
 * account already lost every session at deactivation time (and could not
 * create a new one — see auth.ts) and reactivation does not itself create
 * a session.
 */
export async function reactivateStaffAccount(
  actor: AuthenticatedUser,
  targetId: string,
): Promise<StaffAccountRecord> {
  assertNotSelfAction(actor, targetId);

  return prisma.$transaction(async (tx) => {
    const target = await repository.findStaffById(tx, targetId);
    if (!target) notFound();

    if (target.isActive) {
      return target;
    }

    const updated = await repository.setUserActive(tx, targetId, true);
    await repository.insertAuditLog(tx, {
      actorId: actor.id,
      action: STAFF_AUDIT_ACTIONS.ACCOUNT_REACTIVATED,
      entityType: STAFF_AUDIT_ENTITY_TYPE,
      entityId: targetId,
      beforeState: { isActive: false },
      afterState: { isActive: true },
    });

    return updated;
  });
}
