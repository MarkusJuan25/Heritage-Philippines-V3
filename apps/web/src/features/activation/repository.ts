import { randomUUID } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a `Prisma.TransactionClient` as its first argument, so
// callers run these inside the same transaction as the checks that gate
// them — none of these functions open their own transaction. The
// `PortalInvitation` row's own transitions remain owned by
// `features/invitations/repository.ts` (`markInvitationOpened`,
// `markInvitationActivated`) — this file owns only the identity rows
// activation is the sole creator of (`User`, `Account`, `ClientProfile`).

/**
 * Any-role email collision check (D-034 Section 6, D-037 Section 8 step
 * (e)): `email` is already normalized (trimmed/lowercased) by the caller,
 * since it is always `PortalInvitation.destinationEmail` — never
 * client-supplied input. A plain equality lookup, mirroring
 * `features/staff/repository.ts`'s established `findUniqueByEmail`
 * pattern exactly, not a case-insensitive query — the database's own
 * `user_email_lower_key` functional index (D-034 Section 8) is the race
 * closer this pre-check alone cannot be.
 */
export async function findUserByEmail(
  db: Prisma.TransactionClient,
  email: string,
): Promise<{ id: string } | null> {
  return db.user.findUnique({ where: { email }, select: { id: true } });
}

/**
 * ClientProfile consistency check (D-037 Section 8 step (f)): a `Client`
 * may hold at most one `ClientProfile` (`clientId @unique`) — an existing
 * row here means this Client was already activated (or is otherwise
 * inconsistent), and activation must reject rather than create a second
 * profile.
 */
export async function findClientProfileByClientId(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<{ id: string } | null> {
  return db.clientProfile.findUnique({ where: { clientId }, select: { id: true } });
}

/**
 * The activation-created `User`'s `name` comes from `Client.fullName`
 * (D-037 Section 8 step (g)) — never from any client-supplied input, since
 * the activation request accepts no name field at all.
 */
export async function findClientNameById(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<{ fullName: string } | null> {
  return db.client.findUnique({ where: { id: clientId }, select: { fullName: true } });
}

export type CreateActivatedAccountInput = {
  clientId: string;
  name: string;
  email: string;
  passwordHash: string;
  emailVerified: boolean;
};

export type ActivatedAccountRecord = {
  userId: string;
  clientProfileId: string;
};

/**
 * The atomic identity-creation half of D-037 Section 8's activation
 * transaction (steps (g), (h), (i)): a new `User` (`role: 'CLIENT'`,
 * `email` the invitation's own frozen destination — never client-supplied
 * input), a linked `Account` (`providerId: 'credential'`, the password
 * hash computed by the caller outside this transaction), and the
 * `ClientProfile` linking the two — mirroring
 * `features/staff/repository.ts`'s `createStaffUser`'s established
 * `user.create` + nested `accounts.create` pattern exactly. No `Client`
 * field is ever written here (D-037 Section 8 step (j)) — this function
 * never touches the `client` table at all.
 */
export async function createActivatedAccount(
  db: Prisma.TransactionClient,
  input: CreateActivatedAccountInput,
): Promise<ActivatedAccountRecord> {
  const userId = randomUUID();
  const clientProfileId = randomUUID();

  await db.user.create({
    data: {
      id: userId,
      name: input.name,
      email: input.email,
      role: 'CLIENT',
      isActive: true,
      emailVerified: input.emailVerified,
      accounts: {
        create: {
          id: randomUUID(),
          accountId: userId,
          providerId: 'credential',
          password: input.passwordHash,
        },
      },
    },
  });

  await db.clientProfile.create({
    data: {
      id: clientProfileId,
      userId,
      clientId: input.clientId,
    },
  });

  return { userId, clientProfileId };
}
