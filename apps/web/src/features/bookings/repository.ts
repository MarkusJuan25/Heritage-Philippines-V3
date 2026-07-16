import { randomUUID } from 'node:crypto';

import { BookingStatus, type Prisma } from '@/generated/prisma/client';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a Prisma client or transaction client as its first
// argument so callers can run reads inside the same serializable
// transaction as the writes they gate (see features/bookings/service.ts) —
// none of these functions open their own transaction.
//
// Authorization is scoped directly into these queries' `where` clauses
// (blueprint Section 4.7's assignment-based model), never resolved by
// fetching an unrestricted row and checking it in application code: a
// TRAVEL_CONSULTANT's queries below add a `client.assignments.some(...)`
// filter so the database itself only ever returns rows that actor is
// entitled to see, matching the discipline
// features/assignments/repository.ts's `findActiveAssignmentForClient`
// already established. An ADMIN_MANAGER's queries add no such filter
// (blueprint Section 4.2's full operational visibility).

// Narrowed to exactly the two roles the Booking service layer ever permits
// past `assertBookingActor` (service.ts). Every repository function below
// takes this type, not the broader `AuthenticatedUser`/`AppRole`, so an
// unsupported role cannot reach a repository query even by an internal
// caller mistake — the compiler rejects it, not just a runtime check.
export type BookingActor = { id: string; role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' };

/**
 * The `where` fragment restricting a Client-scoped query to a
 * TRAVEL_CONSULTANT's own active assignments — the identical condition
 * `features/assignments/repository.ts`'s `findActiveAssignmentForClient`
 * expresses directly on `staff_assignment`, expressed here from the other
 * side of the relation (Booking/ProposalVersion -> Client ->
 * StaffAssignment) so it can be composed into a single query rather than
 * requiring a separate lookup per row.
 *
 * Explicitly exhaustive over `BookingActor`'s two roles — not "anything
 * except TRAVEL_CONSULTANT gets unrestricted access." The `default` branch
 * only exists to make that exhaustiveness a compile-time guarantee (via the
 * `never` assignment): if `BookingActor`'s role union ever grows, this
 * function fails to compile until a case is added for the new role,
 * instead of silently falling through to unrestricted access.
 */
function clientAssignmentFilter(actor: BookingActor): Prisma.ClientWhereInput | undefined {
  switch (actor.role) {
    case 'ADMIN_MANAGER':
      return undefined;
    case 'TRAVEL_CONSULTANT':
      return { assignments: { some: { assignedStaffId: actor.id, endedAt: null } } };
    default: {
      const exhaustiveCheck: never = actor.role;
      throw new Error(`Unhandled BookingActor role: ${String(exhaustiveCheck)}`);
    }
  }
}

export type BookingRecord = {
  id: string;
  bookingReference: string;
  clientId: string;
  proposalVersionId: string;
  status: BookingStatus;
  tourPackageName: string | null;
  destination: string | null;
  travelStartDate: Date | null;
  travelEndDate: Date | null;
  travelerCount: number | null;
  includedServices: string | null;
  excludedServices: string | null;
  specialRequests: string | null;
  internalNotes: string | null;
  clientVisibleNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// Explicit, staff-appropriate DTO select — no relations (statusHistory,
// staffAssignments), no ProposalVersion/Client/User data. Every field named
// here is a direct Booking scalar; nothing is ever spread from the raw
// Prisma record (.claude/rules/architecture.md's shared-contract discipline).
const BOOKING_SELECT = {
  id: true,
  bookingReference: true,
  clientId: true,
  proposalVersionId: true,
  status: true,
  tourPackageName: true,
  destination: true,
  travelStartDate: true,
  travelEndDate: true,
  travelerCount: true,
  includedServices: true,
  excludedServices: true,
  specialRequests: true,
  internalNotes: true,
  clientVisibleNotes: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The Booking currently linked to `proposalVersionId`, if any — scoped to
 * what `actor` may see. Used both for the idempotency check ("does a
 * Booking already exist for this ProposalVersion") and for re-reading the
 * winning row after losing a `proposalVersionId`-uniqueness race (see
 * service.ts). A TRAVEL_CONSULTANT never sees a Booking for a Client they
 * are not actively assigned to — the query returns `null` exactly as it
 * would for a genuinely nonexistent Booking, so the caller cannot
 * distinguish the two cases (see BookingError's doc comment).
 */
export async function findBookingByProposalVersionIdForActor(
  db: Prisma.TransactionClient,
  actor: BookingActor,
  proposalVersionId: string,
): Promise<BookingRecord | null> {
  return db.booking.findFirst({
    where: { proposalVersionId, client: clientAssignmentFilter(actor) },
    select: BOOKING_SELECT,
  });
}

/** Single-Booking read, scoped to what `actor` may see — see the doc
 * comment on `findBookingByProposalVersionIdForActor` above for the
 * TRAVEL_CONSULTANT scoping rationale, which applies identically here. */
export async function findBookingByIdForActor(
  db: Prisma.TransactionClient,
  actor: BookingActor,
  id: string,
): Promise<BookingRecord | null> {
  return db.booking.findFirst({
    where: { id, client: clientAssignmentFilter(actor) },
    select: BOOKING_SELECT,
  });
}

export type ListBookingsParams = { skip: number; take: number };

/**
 * Paginated Booking list, scoped to what `actor` may see — the assignment
 * filter is composed directly into both queries' `where` clause (never
 * "fetch every Booking and filter in code" —
 * .claude/rules/admin-dashboard.md's Visibility Scoping rule), so there is
 * no per-row authorization check regardless of result size. This performs
 * exactly two concurrent database operations via `Promise.all` — one
 * `findMany` and one `count`, sharing the same `where` — not a single
 * query.
 *
 * `orderBy` includes `id` as a tie-breaker after `createdAt` so paginated
 * results are deterministic: two Bookings can share a `createdAt` value,
 * and without a fully-ordering second key, Postgres does not guarantee a
 * stable row order across separate paginated `LIMIT`/`OFFSET` queries for
 * rows that tie on the first key — which could otherwise skip or repeat a
 * row across pages.
 */
export async function listBookingsForActor(
  db: Prisma.TransactionClient,
  actor: BookingActor,
  params: ListBookingsParams,
): Promise<{ items: BookingRecord[]; total: number }> {
  const where: Prisma.BookingWhereInput = { client: clientAssignmentFilter(actor) };

  const [items, total] = await Promise.all([
    db.booking.findMany({
      where,
      select: BOOKING_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: params.skip,
      take: params.take,
    }),
    db.booking.count({ where }),
  ]);

  return { items, total };
}

export type ProposalVersionEligibility = {
  id: string;
  clientId: string;
  hasAcceptedAcceptance: boolean;
};

/**
 * Resolves whether `proposalVersionId` is eligible to source a new Booking
 * for `actor` — existence, the owning Client (via
 * `proposalVersion.proposal.clientId`, blueprint Section 5.2), and whether
 * an ACCEPT ProposalAcceptance exists (blueprint Section 9; the Booking
 * model's own doc comment in apps/web/prisma/schema.prisma: "the future
 * Booking-creation service must verify [that the referenced ProposalVersion
 * actually has an ACCEPT ProposalAcceptance] transactionally before writing
 * this row"). The TRAVEL_CONSULTANT assignment filter is scoped directly
 * into this query (via the Proposal -> Client relation), exactly like the
 * read functions above — never resolved by fetching the ProposalVersion
 * unrestricted and checking assignment afterward.
 *
 * Deliberately does NOT check `clientVisibleAt`/`supersededAt` ("is this
 * the current, non-superseded client-visible version"). That phrase
 * appears twice in the Booking model's doc comment, but both times only as
 * an illustrative analogy for a *different*, already-documented invariant
 * (ProposalAcceptance's own creation-time check) — never as a stated
 * Booking-creation precondition itself. Only two Booking-creation
 * invariants are actually named there: the ACCEPT-acceptance check this
 * function performs, and the `clientId`-consistency invariant (which this
 * function's `clientId` return value lets the service layer satisfy by
 * construction, never by trusting a caller-supplied value). Treating
 * "current/non-superseded" as an additional creation gate would be
 * inferring a Proposal-lifecycle rule the repository does not actually
 * state for Booking creation — see the implementation summary for the
 * verbatim evidence.
 */
export async function findEligibleProposalVersionForActor(
  db: Prisma.TransactionClient,
  actor: BookingActor,
  proposalVersionId: string,
): Promise<ProposalVersionEligibility | null> {
  const found = await db.proposalVersion.findFirst({
    where: {
      id: proposalVersionId,
      // Reuses `clientAssignmentFilter` (never a second, duplicated
      // role-branch) — `undefined` for ADMIN_MANAGER means "no proposal
      // filter at all," not "assignment filter is optional."
      proposal: { client: clientAssignmentFilter(actor) },
    },
    select: {
      id: true,
      proposal: { select: { clientId: true } },
      acceptance: { select: { responseType: true } },
    },
  });

  if (!found) return null;

  return {
    id: found.id,
    clientId: found.proposal.clientId,
    hasAcceptedAcceptance: found.acceptance?.responseType === 'ACCEPT',
  };
}

export type CreateBookingInput = {
  id: string;
  bookingReference: string;
  clientId: string;
  proposalVersionId: string;
  changedByUserId: string;
};

/**
 * Creates a Booking (status DRAFT) and its initial BookingStatusHistory row
 * (`previousStatus: null, newStatus: DRAFT`) as a single nested Prisma
 * write, so both rows commit or roll back together within whatever
 * transaction `db` belongs to (blueprint Section 14.9;
 * .claude/rules/backend.md's Auditability — "Booking status changes" and
 * database-security.md's per-entity status-history requirement).
 */
export async function createBookingWithInitialHistory(
  db: Prisma.TransactionClient,
  input: CreateBookingInput,
): Promise<BookingRecord> {
  return db.booking.create({
    data: {
      id: input.id,
      bookingReference: input.bookingReference,
      clientId: input.clientId,
      proposalVersionId: input.proposalVersionId,
      status: BookingStatus.DRAFT,
      statusHistory: {
        create: {
          id: randomUUID(),
          previousStatus: null,
          newStatus: BookingStatus.DRAFT,
          changedByUserId: input.changedByUserId,
        },
      },
    },
    select: BOOKING_SELECT,
  });
}

export type UpdateBookingStatusInput = {
  id: string;
  previousStatus: BookingStatus;
  newStatus: BookingStatus;
  changedByUserId: string;
};

/**
 * Updates `Booking.status` and creates the corresponding
 * `BookingStatusHistory` row as a single nested Prisma write — the `update`
 * counterpart of `createBookingWithInitialHistory` above, so both rows
 * commit or roll back together within whatever transaction `db` belongs to
 * (blueprint Section 14.9; .claude/rules/backend.md's Auditability). This
 * function does not decide *whether* `previousStatus -> newStatus` is
 * allowed — that policy lives in transitions.ts's `isTransitionAllowed`
 * and is the caller's (service.ts's) responsibility to check before ever
 * calling this; this function only persists a transition already approved,
 * matching this codebase's repository/service-layer split
 * (.claude/rules/backend.md's "Repository/data-access layer" / "Service-
 * Level Business Rules").
 */
export async function updateBookingStatusWithHistory(
  db: Prisma.TransactionClient,
  input: UpdateBookingStatusInput,
): Promise<BookingRecord> {
  return db.booking.update({
    where: { id: input.id },
    data: {
      status: input.newStatus,
      statusHistory: {
        create: {
          id: randomUUID(),
          previousStatus: input.previousStatus,
          newStatus: input.newStatus,
          changedByUserId: input.changedByUserId,
        },
      },
    },
    select: BOOKING_SELECT,
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
