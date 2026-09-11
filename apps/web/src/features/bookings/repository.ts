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

// --- Client-portal reads (docs/HERITAGE_V3_DECISIONS_LOG.md D-040 §5) ---
// The Booking feature owns its own status taxonomy and every Booking
// database read, including the two the Client Home / Overview consumes.
// These are pure, bounded reads: no assignment filter is composed here
// (`Booking.clientId` is a direct FK — D-040 scopes strictly by the
// server-resolved owned `clientId`, and authorization is the caller's
// `canAccessClient` gate in features/bookings/service.ts, not a query
// filter), no transaction, no write, no audit.

// DRAFT is a staff-only working state — it never reaches a client
// (D-040 §5). `NON_DRAFT_BOOKING_STATUSES` is the fixed, ordered set of the
// nine statuses the client-visible booking aggregate reports; the
// `satisfies` check keeps it exhaustive against the Prisma enum at compile
// time (a tenth non-DRAFT status added to `BookingStatus` would fail here).
export const NON_DRAFT_BOOKING_STATUSES = [
  BookingStatus.PENDING_CONFIRMATION,
  BookingStatus.CONFIRMED,
  BookingStatus.IN_PREPARATION,
  BookingStatus.DOCUMENTS_REQUIRED,
  BookingStatus.VISA_PROCESSING,
  BookingStatus.READY_FOR_TRAVEL,
  BookingStatus.IN_PROGRESS,
  BookingStatus.COMPLETED,
  BookingStatus.CANCELLED,
] as const satisfies readonly Exclude<BookingStatus, 'DRAFT'>[];

export type NonDraftBookingStatus = (typeof NON_DRAFT_BOOKING_STATUSES)[number];

export type ClientBookingFacts = {
  byStatus: Record<NonDraftBookingStatus, number>;
};

function emptyByStatus(): Record<NonDraftBookingStatus, number> {
  const record = {} as Record<NonDraftBookingStatus, number>;
  for (const status of NON_DRAFT_BOOKING_STATUSES) {
    record[status] = 0;
  }
  return record;
}

/**
 * D-040 §5's fixed-cardinality booking aggregate for one Client, DRAFT
 * excluded entirely. One `groupBy` over `status` (at most nine result
 * rows), normalized into a nine-key record with every missing status
 * defaulting to 0 — never an unbounded row load, and never a per-row fetch.
 */
export async function findClientBookingFacts(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<ClientBookingFacts> {
  const grouped = await db.booking.groupBy({
    by: ['status'],
    where: { clientId, status: { not: BookingStatus.DRAFT } },
    _count: { _all: true },
  });

  const byStatus = emptyByStatus();
  for (const row of grouped) {
    if (row.status !== BookingStatus.DRAFT) {
      byStatus[row.status] = row._count._all;
    }
  }
  return { byStatus };
}

export const CLIENT_OVERVIEW_BOOKING_PREVIEW_MAX = 5;

// D-040 §5's exact client-visible preview field allow-list. Deliberately
// excludes `internalNotes`, `clientVisibleNotes`, `totalAmount`,
// `currencyCode`, `travelerCount`, the `Booking.id`, and all status
// history. `bookingReference` (a client-facing reference, not a database
// id) is the one identifier a client sees.
const CLIENT_BOOKING_PREVIEW_SELECT = {
  bookingReference: true,
  status: true,
  travelStartDate: true,
  travelEndDate: true,
  destination: true,
  tourPackageName: true,
} as const;

export type ClientBookingPreviewRow = {
  bookingReference: string;
  status: NonDraftBookingStatus;
  travelStartDate: Date | null;
  travelEndDate: Date | null;
  destination: string | null;
  tourPackageName: string | null;
};

/**
 * D-040 §5's bounded (five-item), deterministically ordered client-visible
 * booking preview, DRAFT excluded. `orderBy: [createdAt desc, id asc]` —
 * `id` breaks a `createdAt` tie — matching this codebase's established
 * newest-first, fully-deterministic list ordering.
 */
export async function findClientBookingPreview(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<ClientBookingPreviewRow[]> {
  const rows = await db.booking.findMany({
    where: { clientId, status: { not: BookingStatus.DRAFT } },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: CLIENT_OVERVIEW_BOOKING_PREVIEW_MAX,
    select: CLIENT_BOOKING_PREVIEW_SELECT,
  });
  return rows.map((row) => ({
    bookingReference: row.bookingReference,
    status: row.status as NonDraftBookingStatus,
    travelStartDate: row.travelStartDate,
    travelEndDate: row.travelEndDate,
    destination: row.destination,
    tourPackageName: row.tourPackageName,
  }));
}

// --- Client booking list and detail reads (docs/HERITAGE_V3_DECISIONS_LOG.md
// D-049 §§2, 4, 5) ---
// Extends the D-040 §5 client-portal reads above with a paginated list and a
// single-booking detail read for `/client/bookings` and its detail view
// (Stage 3, not implemented here). Same discipline as the D-040 reads
// above: no assignment filter (`Booking.clientId` is a direct FK;
// authorization is the caller's `assertClientPortalAccess` gate in
// service.ts, independently before each read — D-049 §2), no transaction,
// no write, no audit, DRAFT excluded from every predicate (D-049 §6).

// D-049 §4's fixed page size for `/client/bookings`. The list read fetches
// `CLIENT_BOOKING_LIST_PAGE_SIZE + 1` rows for a confirmed page; the service
// renders at most `CLIENT_BOOKING_LIST_PAGE_SIZE`, using the extra row only
// to decide whether a Next-page link is shown (D-049 §4).
export const CLIENT_BOOKING_LIST_PAGE_SIZE = 10;

/**
 * The count of one Client's non-DRAFT Bookings (D-049 §4's existing-page
 * check: the service derives the last existing page
 * (`ceil(count / CLIENT_BOOKING_LIST_PAGE_SIZE)`) from this and redirects an
 * out-of-range `page` > 1 BEFORE it computes or issues any offset query).
 * Scoped by `clientId` alone, DRAFT excluded — the identical predicate
 * `findClientBookingListPage` below uses, so the count and the list query
 * agree exactly on which rows exist.
 */
export async function countClientBookings(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<number> {
  return db.booking.count({ where: { clientId, status: { not: BookingStatus.DRAFT } } });
}

/**
 * One page of a Client's non-DRAFT Bookings, in D-049 §4's deterministic
 * order — `createdAt` descending, `id` ascending as the server-only
 * tie-breaker (never returned) — reusing `findClientBookingPreview`'s
 * established ordering and field allow-list exactly (D-049 §5 List DTO:
 * `bookingReference`, `status`, `travelStartDate`, `travelEndDate`,
 * `destination`, `tourPackageName` — no new field). `skip`/`take` are
 * supplied by the service, which passes
 * `take = CLIENT_BOOKING_LIST_PAGE_SIZE + 1` and only ever computes a `skip`
 * for a page it has already confirmed exists (D-049 §4).
 */
export async function findClientBookingListPage(
  db: Prisma.TransactionClient,
  clientId: string,
  params: { skip: number; take: number },
): Promise<ClientBookingPreviewRow[]> {
  const rows = await db.booking.findMany({
    where: { clientId, status: { not: BookingStatus.DRAFT } },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    skip: params.skip,
    take: params.take,
    select: CLIENT_BOOKING_PREVIEW_SELECT,
  });
  return rows.map((row) => ({
    bookingReference: row.bookingReference,
    status: row.status as NonDraftBookingStatus,
    travelStartDate: row.travelStartDate,
    travelEndDate: row.travelEndDate,
    destination: row.destination,
    tourPackageName: row.tourPackageName,
  }));
}

// D-049 §5's exact detail-view field allow-list: the D-040 six plus
// `travelerCount`, `includedServices`, `excludedServices`, `specialRequests`,
// and `clientVisibleNotes` (each individually approved in D-049 §5).
// Deliberately excludes `id`, `clientId`, `proposalVersionId`,
// `internalNotes` (D-049 §5 — rejected), `totalAmount`/`currencyCode`
// (D-049 §6), `createdAt`/`updatedAt`, and every relation — none of these
// is a D-049-approved client-visible field.
const CLIENT_BOOKING_DETAIL_SELECT = {
  bookingReference: true,
  status: true,
  tourPackageName: true,
  destination: true,
  travelStartDate: true,
  travelEndDate: true,
  travelerCount: true,
  includedServices: true,
  excludedServices: true,
  specialRequests: true,
  clientVisibleNotes: true,
} as const;

export type ClientBookingDetailRow = {
  bookingReference: string;
  status: NonDraftBookingStatus;
  tourPackageName: string | null;
  destination: string | null;
  travelStartDate: Date | null;
  travelEndDate: Date | null;
  travelerCount: number | null;
  includedServices: string | null;
  excludedServices: string | null;
  specialRequests: string | null;
  clientVisibleNotes: string | null;
};

/**
 * One Client's single Booking, addressed by its canonical `bookingReference`
 * — D-049 §2's combined predicate: `clientId` (server-resolved, never
 * caller-supplied) AND `bookingReference` (already lexically validated by
 * the caller — D-049 §3) AND non-DRAFT, all in **one** query. A nonexistent
 * reference, a DRAFT booking's reference, and another client's booking's
 * reference are indistinguishable to this query by construction — each
 * simply matches zero rows — and this function returns `null` for all
 * three, never throwing and never calling any Next.js navigation function
 * (D-049 §7); the caller (service.ts) maps `null` identically regardless of
 * which of those three held. This is never an unrestricted global
 * `findFirst`/`findUnique` by `bookingReference` alone followed by an
 * application-level ownership check — `clientId` is part of the same
 * `where` clause as `bookingReference`, not a check applied after the read.
 */
export async function findClientBookingDetailByReference(
  db: Prisma.TransactionClient,
  clientId: string,
  bookingReference: string,
): Promise<ClientBookingDetailRow | null> {
  const row = await db.booking.findFirst({
    where: { clientId, bookingReference, status: { not: BookingStatus.DRAFT } },
    select: CLIENT_BOOKING_DETAIL_SELECT,
  });
  if (!row) return null;
  return {
    bookingReference: row.bookingReference,
    status: row.status as NonDraftBookingStatus,
    tourPackageName: row.tourPackageName,
    destination: row.destination,
    travelStartDate: row.travelStartDate,
    travelEndDate: row.travelEndDate,
    travelerCount: row.travelerCount,
    includedServices: row.includedServices,
    excludedServices: row.excludedServices,
    specialRequests: row.specialRequests,
    clientVisibleNotes: row.clientVisibleNotes,
  };
}
