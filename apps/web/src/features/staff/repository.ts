import { randomUUID } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';
import type { AppRole } from '@/lib/auth/roles';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a Prisma client or transaction client as its first
// argument so callers can run reads inside the same serializable
// transaction as the writes they gate (see features/staff/service.ts) —
// none of these functions open their own transaction.

export type StaffAccountRecord = {
  id: string;
  name: string;
  email: string;
  role: AppRole;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  staffProfile: { title: string | null; phone: string | null } | null;
};

const STAFF_ACCOUNT_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  staffProfile: { select: { title: true, phone: true } },
} as const;

// This repository's notion of "staff account" — every non-CLIENT role
// (roles.ts's STAFF_ROLES). Scoping the query shape to non-CLIENT rows
// here (rather than filtering client-side) keeps this feature from ever
// returning, and therefore never accidentally mutating, a client's User
// row — client accounts belong to a future, separate client-management
// feature.
const STAFF_ONLY_WHERE = { role: { not: 'CLIENT' as const } };

export async function findUserByEmail(
  client: Prisma.TransactionClient,
  email: string,
): Promise<{ id: string } | null> {
  return client.user.findUnique({ where: { email }, select: { id: true } });
}

export async function findStaffById(
  client: Prisma.TransactionClient,
  id: string,
): Promise<StaffAccountRecord | null> {
  return client.user.findFirst({
    where: { id, ...STAFF_ONLY_WHERE },
    select: STAFF_ACCOUNT_SELECT,
  }) as Promise<StaffAccountRecord | null>;
}

/**
 * Counts currently-active SYSTEM_ADMINISTRATOR accounts, optionally
 * excluding one user id (the target of a pending role change or
 * deactivation) so the caller can ask "how many would remain after this
 * change" in one query. Callers run this inside the serializable
 * transaction that also applies the change — see
 * apps/web/prisma/schema.prisma invariant #1 and
 * features/staff/service.ts's `runSerializableWithRetry`.
 */
export async function countActiveSystemAdministrators(
  client: Prisma.TransactionClient,
  excludeUserId?: string,
): Promise<number> {
  return client.user.count({
    where: {
      role: 'SYSTEM_ADMINISTRATOR',
      isActive: true,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
  });
}

export async function createStaffUser(
  client: Prisma.TransactionClient,
  input: {
    id: string;
    name: string;
    email: string;
    role: AppRole;
    passwordHash: string;
    title?: string;
    phone?: string;
  },
): Promise<StaffAccountRecord> {
  return client.user.create({
    data: {
      id: input.id,
      name: input.name,
      email: input.email,
      role: input.role,
      isActive: true,
      emailVerified: false,
      accounts: {
        create: {
          id: randomUUID(),
          accountId: input.id,
          providerId: 'credential',
          password: input.passwordHash,
        },
      },
      staffProfile:
        input.title || input.phone
          ? {
              create: {
                id: randomUUID(),
                title: input.title,
                phone: input.phone,
              },
            }
          : undefined,
    },
    select: STAFF_ACCOUNT_SELECT,
  }) as Promise<StaffAccountRecord>;
}

export async function updateUserRole(
  client: Prisma.TransactionClient,
  id: string,
  role: AppRole,
): Promise<StaffAccountRecord> {
  return client.user.update({
    where: { id },
    data: { role },
    select: STAFF_ACCOUNT_SELECT,
  }) as Promise<StaffAccountRecord>;
}

export async function setUserActive(
  client: Prisma.TransactionClient,
  id: string,
  isActive: boolean,
): Promise<StaffAccountRecord> {
  return client.user.update({
    where: { id },
    data: { isActive },
    select: STAFF_ACCOUNT_SELECT,
  }) as Promise<StaffAccountRecord>;
}

/**
 * Deletes every session row for a user — the direct-Prisma session
 * revocation apps/web/prisma/schema.prisma invariant #2 calls for. Better
 * Auth's own core session-revocation endpoints only revoke the *caller's
 * own* session(s) (see docs/HERITAGE_V3_DECISIONS_LOG.md D-012); there is
 * no non-plugin Better Auth API to revoke an arbitrary other user's
 * sessions, so this goes straight through Prisma, inside the same
 * transaction as the mutation that necessitates it.
 */
export async function deleteSessionsForUser(
  client: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await client.session.deleteMany({ where: { userId } });
}

export async function insertAuditLog(
  client: Prisma.TransactionClient,
  entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    beforeState?: Prisma.InputJsonValue;
    afterState?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await client.auditLog.create({
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

export type ListStaffAccountsParams = {
  role?: AppRole;
  isActive?: boolean;
  search?: string;
  skip: number;
  take: number;
};

export async function listStaffAccounts(
  client: Prisma.TransactionClient,
  params: ListStaffAccountsParams,
): Promise<{ items: StaffAccountRecord[]; total: number }> {
  const where: Prisma.UserWhereInput = {
    ...STAFF_ONLY_WHERE,
    ...(params.role ? { role: params.role } : {}),
    ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: 'insensitive' } },
            { email: { contains: params.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    client.user.findMany({
      where,
      select: STAFF_ACCOUNT_SELECT,
      orderBy: { createdAt: 'desc' },
      skip: params.skip,
      take: params.take,
    }) as Promise<StaffAccountRecord[]>,
    client.user.count({ where }),
  ]);

  return { items, total };
}
