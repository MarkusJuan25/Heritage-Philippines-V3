import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';

const MAX_SERIALIZABLE_RETRIES = 3;

function isSerializationConflict(error: unknown): boolean {
  // Prisma's P2034: "Transaction failed due to a write conflict or a
  // deadlock. Please retry your transaction" — the expected, retryable
  // outcome of two concurrent SERIALIZABLE transactions racing on the same
  // "read the current state, then conditionally write" check a caller runs
  // inside `fn` (e.g. features/staff/service.ts's "is this the last admin"
  // check, or features/assignments/service.ts's "is there already an
  // active assignment" check).
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

/**
 * Runs `fn` inside a SERIALIZABLE transaction, retrying only on a Postgres
 * serialization conflict (never on a business-rule rejection, which callers
 * signal by throwing their own domain error — that propagates immediately,
 * unretried). Shared by every feature whose service layer must read
 * current state and conditionally write to it as one atomic,
 * race-safe unit — originally written for
 * apps/web/prisma/schema.prisma invariant #1 (the "is this the last active
 * SYSTEM_ADMINISTRATOR" check in features/staff/service.ts) and extracted
 * here once features/assignments/service.ts needed the identical guarantee
 * for its "is there already an active assignment for this Lead/Client"
 * check.
 */
export async function runSerializableWithRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt >= MAX_SERIALIZABLE_RETRIES) {
        throw error;
      }
      // Brief jittered backoff before retrying a lost serialization race.
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}
