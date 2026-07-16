import { randomBytes, randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { BOOKING_AUDIT_ACTIONS, BOOKING_AUDIT_ENTITY_TYPE, sanitizeBookingSnapshot } from './audit';
import { BookingError } from './errors';
import * as repository from './repository';
import type { BookingActor, BookingRecord } from './repository';
import type { CreateBookingInput, ListBookingsQuery } from './schemas';

const BOOKING_REFERENCE_PREFIX = 'HPB-';
const MAX_BOOKING_REFERENCE_ATTEMPTS = 3;

/**
 * Defense-in-depth service-boundary authorization (.claude/rules/backend.md
 * "Authentication vs. Authorization"). `withRole(['ADMIN_MANAGER',
 * 'TRAVEL_CONSULTANT'], ...)` already gates every Booking route before its
 * handler runs — this is an *additional*, independent check, not a
 * replacement: it protects the service boundary itself, so an exported
 * service function called directly (a future internal caller, a route
 * wired up incorrectly, a test) still produces a controlled
 * `ROLE_NOT_PERMITTED` result for an unsupported role, before any
 * transaction opens or any repository/database call happens — never a
 * repository query, and never an unhandled exception from
 * repository.ts's `clientAssignmentFilter` (whose `switch` over
 * `BookingActor`'s two roles throws for anything else, since `BookingActor`
 * itself cannot represent an unsupported role at the type level once this
 * function has narrowed it).
 *
 * Must run before opening a transaction or calling any repository
 * function — every exported function below calls this first, before doing
 * anything else.
 */
function assertBookingActor(actor: AuthenticatedUser): BookingActor {
  if (actor.role === 'ADMIN_MANAGER' || actor.role === 'TRAVEL_CONSULTANT') {
    return { id: actor.id, role: actor.role };
  }
  throw new BookingError('ROLE_NOT_PERMITTED', 'This role is not permitted to manage bookings.');
}

/**
 * `HPB-` followed by 20 uppercase hexadecimal characters, generated from 10
 * cryptographically secure random bytes (`node:crypto`'s `randomBytes` — no
 * new dependency). Never a year or sequential counter — see
 * docs/HERITAGE_V3_DECISIONS_LOG.md's booking-reference decision. Always
 * server-generated; a client can never supply or override this value (see
 * schemas.ts's `createBookingSchema`, which has no `bookingReference`
 * field). Collision handling is the caller's responsibility (see
 * `createBooking` below) — `Booking.bookingReference`'s database `@unique`
 * constraint is the final safeguard regardless.
 */
function generateBookingReference(): string {
  return `${BOOKING_REFERENCE_PREFIX}${randomBytes(10).toString('hex').toUpperCase()}`;
}

function uniqueConstraintTarget(error: Prisma.PrismaClientKnownRequestError): string {
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.join(',');
  return typeof target === 'string' ? target : '';
}

function isUniqueConflictOn(error: unknown, field: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    uniqueConstraintTarget(error).includes(field)
  );
}

// P2034: a SERIALIZABLE conflict that survived every retry in
// runSerializableWithRetry. P2002 (unmatched by the two specific checks
// above)/P2004: the database's own unique indexes / CHECK constraints (see
// the Booking/BookingStatusHistory model doc comments in
// apps/web/prisma/schema.prisma) rejecting a write for a reason this
// service did not anticipate — a defense-in-depth backstop, mirroring
// features/assignments/service.ts's `isKnownConflict`.
function isOtherKnownConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002' || error.code === 'P2004')
  );
}

const CONFLICT_MESSAGE =
  'This booking could not be completed because of a conflicting update. Please try again.';

type CreateBookingResult = { booking: BookingRecord; created: boolean };

/**
 * Executes one full attempt: idempotency check, ProposalVersion
 * eligibility, and (if eligible) the Booking + initial BookingStatusHistory
 * + AuditLog write — all inside a single SERIALIZABLE transaction, so a
 * concurrent request can never observe a partially created Booking.
 */
async function attemptCreateBooking(
  tx: Prisma.TransactionClient,
  actor: BookingActor,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  // 1. Idempotent no-op: a Booking already exists for this ProposalVersion
  // and `actor` may see it — return it unchanged, no new write, no
  // duplicate history row, no duplicate audit entry (blueprint's
  // one-Booking-per-ProposalVersion rule, preserved exactly as the database
  // already enforces it via `Booking.proposalVersionId`'s `@unique`
  // constraint — never widened into a one-per-Proposal rule).
  const existing = await repository.findBookingByProposalVersionIdForActor(
    tx,
    actor,
    input.proposalVersionId,
  );
  if (existing) {
    return { booking: existing, created: false };
  }

  // 2. Resolve the eligible ProposalVersion, scoped to what `actor` may
  // see. A `null` result is ambiguous for a TRAVEL_CONSULTANT (nonexistent
  // vs. not assigned) and must never leak which — see BookingError's doc
  // comment.
  const eligible = await repository.findEligibleProposalVersionForActor(
    tx,
    actor,
    input.proposalVersionId,
  );
  if (!eligible) {
    throw actor.role === 'ADMIN_MANAGER'
      ? new BookingError('PROPOSAL_VERSION_NOT_FOUND', 'Proposal version not found.')
      : new BookingError(
          'PROPOSAL_VERSION_FORBIDDEN',
          'Proposal version not found or not accessible.',
        );
  }
  if (!eligible.hasAcceptedAcceptance) {
    throw new BookingError(
      'PROPOSAL_VERSION_NOT_ACCEPTED',
      'A booking can only be created from a proposal version the client has accepted.',
    );
  }

  // 3. Create. `clientId` comes from `eligible.clientId` (resolved via
  // proposalVersion.proposal.clientId) — never from caller input — which is
  // exactly the client-consistency invariant the Booking model's doc
  // comment in apps/web/prisma/schema.prisma requires ("Booking.clientId
  // must always equal the Client connected through
  // Booking.proposalVersion.proposal.clientId"): satisfied by construction,
  // since there is no other source for this value.
  const created = await repository.createBookingWithInitialHistory(tx, {
    id: randomUUID(),
    bookingReference: generateBookingReference(),
    clientId: eligible.clientId,
    proposalVersionId: input.proposalVersionId,
    changedByUserId: actor.id,
  });

  await repository.insertAuditLog(tx, {
    actorId: actor.id,
    action: BOOKING_AUDIT_ACTIONS.BOOKING_CREATED,
    entityType: BOOKING_AUDIT_ENTITY_TYPE,
    entityId: created.id,
    afterState: sanitizeBookingSnapshot(created),
  });

  return { booking: created, created: true };
}

/**
 * Creates a Booking from an accepted ProposalVersion (blueprint Sections 5,
 * 5.1, 5.2, 9) — an explicit staff action, never automatic.
 *
 * Concurrency: each attempt runs inside `runSerializableWithRetry`, which
 * itself retries a Postgres serialization conflict (P2034) up to its own
 * bounded limit. Two additional, narrower conflicts are handled around
 * that, each requiring a *fresh* transaction (a failed statement aborts the
 * Postgres transaction it ran in — Prisma's interactive transactions do not
 * use savepoints per statement — so retrying inside the same `tx` callback
 * would not work; each retry below re-invokes `runSerializableWithRetry`
 * with a brand-new transaction):
 *
 * - `bookingReference` uniqueness lost a race (astronomically unlikely at
 *   80 bits of randomness, but handled defensively per the booking
 *   reference decision): regenerate a new reference and retry the whole
 *   attempt, up to `MAX_BOOKING_REFERENCE_ATTEMPTS` times.
 * - `proposalVersionId` uniqueness lost a race (two concurrent requests for
 *   the same ProposalVersion): re-read the actor-accessible existing
 *   Booking and return it as the idempotent result — the same outcome a
 *   non-concurrent idempotent replay produces.
 *
 * Any other residual conflict (P2034 that survived every retry, P2004, or
 * an unmatched P2002) maps to a controlled `BookingError('BOOKING_CONFLICT')`
 * — never a raw Prisma/PostgreSQL error reaching the route layer
 * (.claude/rules/backend.md's "Consistent Error Responses" / "No secret or
 * sensitive-error exposure").
 */
export async function createBooking(
  actor: AuthenticatedUser,
  input: CreateBookingInput,
): Promise<CreateBookingResult> {
  const bookingActor = assertBookingActor(actor);

  for (let attempt = 1; attempt <= MAX_BOOKING_REFERENCE_ATTEMPTS; attempt += 1) {
    try {
      return await runSerializableWithRetry((tx) => attemptCreateBooking(tx, bookingActor, input));
    } catch (error) {
      if (isUniqueConflictOn(error, 'bookingReference')) {
        if (attempt < MAX_BOOKING_REFERENCE_ATTEMPTS) {
          continue;
        }
        throw new BookingError(
          'BOOKING_CONFLICT',
          'Could not generate a unique booking reference. Please try again.',
        );
      }

      if (isUniqueConflictOn(error, 'proposalVersionId')) {
        const raced = await repository.findBookingByProposalVersionIdForActor(
          prisma,
          bookingActor,
          input.proposalVersionId,
        );
        if (raced) {
          return { booking: raced, created: false };
        }
        throw new BookingError('BOOKING_CONFLICT', CONFLICT_MESSAGE);
      }

      if (isOtherKnownConflict(error)) {
        throw new BookingError('BOOKING_CONFLICT', CONFLICT_MESSAGE);
      }

      // BookingError business-rule outcomes (NOT_FOUND / FORBIDDEN /
      // NOT_ACCEPTED) and any truly unexpected error propagate unchanged.
      throw error;
    }
  }

  // Unreachable: the loop above always returns or throws. Present only to
  // satisfy TypeScript's control-flow analysis.
  throw new BookingError(
    'BOOKING_CONFLICT',
    'Could not generate a unique booking reference. Please try again.',
  );
}

/**
 * Single-Booking read, scoped to what `actor` may see. A `null` repository
 * result is ambiguous for a TRAVEL_CONSULTANT and always becomes FORBIDDEN
 * (403), never NOT_FOUND (404) — see BookingError's doc comment.
 */
export async function getBookingById(actor: AuthenticatedUser, id: string): Promise<BookingRecord> {
  const bookingActor = assertBookingActor(actor);

  const found = await repository.findBookingByIdForActor(prisma, bookingActor, id);
  if (!found) {
    throw bookingActor.role === 'ADMIN_MANAGER'
      ? new BookingError('BOOKING_NOT_FOUND', 'Booking not found.')
      : new BookingError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.');
  }
  return found;
}

export type ListBookingsResult = {
  items: BookingRecord[];
  page: number;
  pageSize: number;
  total: number;
};

/** Paginated Booking list, scoped to what `actor` may see (repository.ts's
 * `listBookingsForActor` composes the scoping into a single query). */
export async function listBookings(
  actor: AuthenticatedUser,
  query: ListBookingsQuery,
): Promise<ListBookingsResult> {
  const bookingActor = assertBookingActor(actor);

  const skip = (query.page - 1) * query.pageSize;
  const { items, total } = await repository.listBookingsForActor(prisma, bookingActor, {
    skip,
    take: query.pageSize,
  });
  return { items, page: query.page, pageSize: query.pageSize, total };
}
