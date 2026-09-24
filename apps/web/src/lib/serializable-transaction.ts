import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import { isRetryableWriteConflict, SerializableRetriesExhaustedError } from '@/lib/prisma-errors';

const MAX_SERIALIZABLE_RETRIES = 3;

/**
 * Runs `fn` inside a SERIALIZABLE transaction, retrying only on a Postgres
 * write conflict, up to `MAX_SERIALIZABLE_RETRIES` attempts in total (never
 * on a business-rule rejection, which callers signal by throwing their own
 * domain error — that propagates immediately, unretried). If every attempt
 * loses a write conflict, throws `SerializableRetriesExhaustedError`, which
 * every caller maps to its own safe conflict response.
 *
 * Shared by every feature whose service layer must read current state and
 * conditionally write to it as one atomic, race-safe unit — originally written for
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
      // A write conflict (P2034, or the raw adapter form detected at
      // COMMIT — see lib/prisma-errors.ts) is the expected outcome of two
      // concurrent SERIALIZABLE transactions racing on the same "read the
      // current state, then conditionally write" check inside `fn`.
      // Anything else — including a business-rule rejection `fn` throws —
      // propagates immediately and unretried.
      if (!isRetryableWriteConflict(error)) {
        throw error;
      }
      if (attempt >= MAX_SERIALIZABLE_RETRIES) {
        throw new SerializableRetriesExhaustedError(attempt, error);
      }
      // Brief jittered backoff before retrying a lost serialization race.
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}
