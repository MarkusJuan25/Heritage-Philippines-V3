import { Prisma } from '@/generated/prisma/client';

// Recognizes the Prisma error shapes this codebase actually receives through
// `@prisma/adapter-pg` (Prisma 7.8.0), each verified directly against a real
// PostgreSQL database rather than assumed from Prisma's pre-adapter
// documentation:
//
// - A SERIALIZABLE write conflict (Postgres SQLSTATE 40001) arrives in one
//   of two forms, depending on where Postgres detects it:
//     * detected at a statement: a `PrismaClientKnownRequestError` with
//       code `P2034`;
//     * detected at COMMIT (e.g. write skew between two transactions that
//       each read, then insert): a *raw* `DriverAdapterError` — not a
//       `PrismaClientKnownRequestError` at all — whose `cause.kind` is
//       `'TransactionWriteConflict'`.
// - A unique violation (SQLSTATE 23505) arrives as a
//   `PrismaClientKnownRequestError` with code `P2002` and **no
//   `meta.target`**. The violated columns are instead under
//   `meta.driverAdapterError.cause.constraint.fields`, parsed by the adapter
//   from Postgres's own "Key (...)" detail — so a mixed-case column arrives
//   still double-quoted (`'"userId"'`), exactly as Postgres prints it.
//   `meta.modelName` names the Prisma model whose write failed.
// - A CHECK-constraint violation (SQLSTATE 23514) does **not** arrive as
//   Prisma's documented `P2004`: it arrives as a raw `DriverAdapterError`
//   with `cause.kind: 'postgres'` and `cause.originalCode: '23514'`, whose
//   `cause.detail` repeats the entire failing row (possibly personal data).
//   It is deliberately recognized by nothing here, so it always propagates
//   as an unknown error to the generic response: every CHECK constraint in
//   this schema is an integrity backstop that only a code defect can reach,
//   never a retryable conflict (D-055).
//
// Nothing else is treated as retryable or as a recognizable unique
// violation: a deadlock (40P01), for example, is not mapped to a write
// conflict by the adapter, has not been observed here, and propagates
// unchanged.

type DriverAdapterCause = {
  kind?: unknown;
  constraint?: unknown;
};

// Mirrors `@prisma/driver-adapter-utils`'s own `isDriverAdapterError`
// (`name === 'DriverAdapterError'` with an object `cause`), which is how
// Prisma itself recognizes this error — both when thrown directly and when
// nested under a known-request error's `meta.driverAdapterError`.
function driverAdapterCause(error: unknown): DriverAdapterCause | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; cause?: unknown };
  if (candidate.name !== 'DriverAdapterError') return null;
  return typeof candidate.cause === 'object' && candidate.cause !== null
    ? (candidate.cause as DriverAdapterCause)
    : null;
}

/**
 * True for a PostgreSQL serialization failure in either verified form: a
 * `P2034` known-request error, or a raw `DriverAdapterError` whose
 * `cause.kind` is `'TransactionWriteConflict'`. Safe to retry with a fresh
 * transaction; nothing was committed.
 */
export function isRetryableWriteConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2034';
  }
  return driverAdapterCause(error)?.kind === 'TransactionWriteConflict';
}

/**
 * Thrown by `runSerializableWithRetry` (lib/serializable-transaction.ts)
 * once every bounded attempt has lost a write conflict. Carries no database
 * detail in its message; the last underlying error is kept only as `cause`,
 * for server-side logging. Every caller maps it to its own safe conflict
 * response — never to the client as-is.
 */
export class SerializableRetriesExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause: unknown) {
    super(`Serializable transaction lost a write conflict on all ${attempts} attempts.`, {
      cause,
    });
    this.name = 'SerializableRetriesExhaustedError';
    this.attempts = attempts;
  }
}

export function isSerializableRetriesExhausted(
  error: unknown,
): error is SerializableRetriesExhaustedError {
  return error instanceof SerializableRetriesExhaustedError;
}

// Postgres quotes an identifier in its "Key (...)" detail only when it needs
// quoting (mixed case, reserved words, special characters), doubling any
// embedded quote. Undo exactly that.
function unquoteIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }
  return trimmed;
}

export type UniqueViolation = {
  /** The Prisma model whose write failed, when Prisma reports it. */
  modelName: string | null;
  /** The violated columns, unquoted; empty when the adapter could not tell. */
  fields: string[];
};

/**
 * The model and columns of a `P2002` unique violation, or `null` when
 * `error` is not one. Reads the verified adapter shape
 * (`meta.driverAdapterError.cause.constraint.fields`), falling back to the
 * legacy `meta.target` only if the adapter shape is absent. When neither
 * names the columns (the adapter reports some violations by index name
 * only), `fields` is empty — which `isUniqueViolationOn` never matches.
 */
export function uniqueViolation(error: unknown): UniqueViolation | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const meta = (error.meta ?? {}) as Record<string, unknown>;
  const modelName = typeof meta.modelName === 'string' ? meta.modelName : null;

  const cause = driverAdapterCause(meta.driverAdapterError);
  const constraint = cause?.constraint as { fields?: unknown } | undefined;
  if (Array.isArray(constraint?.fields)) {
    return {
      modelName,
      fields: constraint.fields
        .filter((field): field is string => typeof field === 'string')
        .map(unquoteIdentifier),
    };
  }

  const target = meta.target;
  if (Array.isArray(target)) {
    return {
      modelName,
      fields: target.filter((field): field is string => typeof field === 'string'),
    };
  }
  return { modelName, fields: [] };
}

/**
 * True only for a `P2002` on exactly `fields` (order-insensitive, no extra
 * or missing column) of exactly `modelName`. A violation of any other
 * constraint — including a same-named column on another model — is not a
 * match, so it can never be mistaken for a caller's idempotent-replay case.
 */
export function isUniqueViolationOn(
  error: unknown,
  modelName: string,
  fields: readonly string[],
): boolean {
  const violation = uniqueViolation(error);
  if (!violation || violation.modelName !== modelName) return false;
  if (violation.fields.length !== fields.length) return false;
  const expected = new Set(fields);
  return violation.fields.every((field) => expected.has(field));
}

/**
 * A residual database conflict a service maps to its own generic, safe
 * CONFLICT response: exhausted serializable retries, a write conflict
 * raised outside `runSerializableWithRetry`, a unique violation (`P2002`)
 * the caller did not handle more specifically. A CHECK-constraint violation
 * is never a residual conflict (see the file header; D-055).
 */
export function isResidualDatabaseConflict(error: unknown): boolean {
  if (isSerializableRetriesExhausted(error) || isRetryableWriteConflict(error)) return true;
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
