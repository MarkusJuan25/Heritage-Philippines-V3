import { randomUUID } from 'node:crypto';

import type { Prisma, ProposalResponseType } from '@/generated/prisma/client';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a Prisma client or transaction client as its first
// argument so callers can run reads inside the same transaction as the
// writes they gate — none of these functions open their own transaction,
// retry a serialization conflict, catch/translate a unique-constraint
// error, or decide a lifecycle/authorization outcome. Transaction
// ownership, `runSerializableWithRetry`, the D-027 §5 publish check
// ordering, the D-027 §7 response-recording check ordering, and every
// controlled `ProposalError` decision belong exclusively to the future
// service layer (Stage 4 of this checkpoint) — this module only exposes
// narrow, honest query/write primitives for that layer to compose,
// mirroring features/bookings/repository.ts's and
// features/clients/repository.ts's identical split.

// Narrowed to exactly the two roles D-027 §3 ever authorizes for any
// Proposal operation — mirrors features/bookings/repository.ts's
// `BookingActor` exactly. No exported function in this file accepts the
// broader `AuthenticatedUser`/`AppRole` type, so an unsupported role cannot
// reach a query even by an internal caller mistake.
export type ProposalActor = { id: string; role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' };

/**
 * The `where` fragment restricting a Client-scoped Proposal query to a
 * TRAVEL_CONSULTANT's own active assignments (D-027 §3) — structurally
 * identical to features/bookings/repository.ts's `clientAssignmentFilter`
 * and features/clients/repository.ts's `clientAssignmentFilter`, expressed
 * here as this feature's own local copy rather than a cross-feature import
 * (.claude/rules/architecture.md's cross-feature-reuse discipline — each
 * feature's repository stays self-contained). Explicitly exhaustive over
 * `ProposalActor`'s two roles: the `default` branch exists only to make
 * that exhaustiveness a compile-time guarantee via the `never` assignment,
 * so a future third role added to `ProposalActor` fails to compile here
 * until handled, rather than silently falling through to unrestricted
 * access.
 */
function proposalClientAssignmentFilter(actor: ProposalActor): Prisma.ClientWhereInput | undefined {
  switch (actor.role) {
    case 'ADMIN_MANAGER':
      return undefined;
    case 'TRAVEL_CONSULTANT':
      return { assignments: { some: { assignedStaffId: actor.id, endedAt: null } } };
    default: {
      const exhaustiveCheck: never = actor.role;
      throw new Error(`Unhandled ProposalActor role: ${String(exhaustiveCheck)}`);
    }
  }
}

// The narrow "who is this Proposal/Version linked to" identity D-027 §8
// requires for every list/detail view — never an invented title or
// reference field, only the linked Client's own identity.
export type ProposalClientIdentity = { id: string; fullName: string };

// --- ProposalVersion field selects, shared across every read/write below ---
// (D-027 §6/§9's exact field lists; `content` is always `string | null` on
// a read shape and never selected at all where it is not needed, e.g. the
// actor-scoped context lookup below).

export type ProposalVersionRecord = {
  id: string;
  proposalId: string;
  versionNumber: number;
  content: string | null;
  clientVisibleAt: Date | null;
  supersededAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const PROPOSAL_VERSION_SELECT = {
  id: true,
  proposalId: true,
  versionNumber: true,
  content: true,
  clientVisibleAt: true,
  supersededAt: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

// --- ProposalAcceptance field select/DTO (D-027 §4/§9) ---
// One shared, explicit allow-list reused by the detail read's nested
// `acceptance` field and by the external-response primitives below — never
// `respondingClientProfileId`/`respondingSessionIdAtResponse` (the portal
// attribution path, schema-only until Phase 3) and never any relation
// beyond the plain scalar columns already on this row. "Staff-appropriate"
// per D-027 §4's own named field list: response type, the client's stated
// response timestamp, the acting staff account, the response method, and
// the evidence reference — nothing else.
export type ProposalAcceptanceRecord = {
  id: string;
  proposalVersionId: string;
  responseType: ProposalResponseType;
  respondedAt: Date;
  recordedByStaffUserId: string | null;
  responseMethod: string | null;
  evidenceReference: string | null;
  createdAt: Date;
};

const PROPOSAL_ACCEPTANCE_SELECT = {
  id: true,
  proposalVersionId: true,
  responseType: true,
  respondedAt: true,
  recordedByStaffUserId: true,
  responseMethod: true,
  evidenceReference: true,
  createdAt: true,
} as const;

// --- Proposal list (D-027 §6's `GET /api/proposals`, §8's list UI) ---

export type ProposalListItem = {
  id: string;
  client: ProposalClientIdentity;
  createdAt: Date;
  updatedAt: Date;
};

// Deliberately excludes every ProposalVersion field, including `content` —
// D-027 §8: a Proposal list distinguishes rows only by the linked Client's
// identity and `Proposal.createdAt`, never an invented title/reference and
// never authored content, which this checkpoint's list view has no reason
// to load at all.
const PROPOSAL_LIST_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { id: true, fullName: true } },
} as const;

export type ListProposalsParams = { skip: number; take: number };

/**
 * Paginated, actor-scoped Proposal list (D-027 §3/§6). The assignment
 * filter is composed directly into both queries' `where` clause — never
 * "fetch every Proposal and filter in code"
 * (.claude/rules/admin-dashboard.md's Visibility Scoping rule) — so there
 * is no per-row authorization check regardless of result size. Runs
 * exactly one `findMany` and one `count`, both against the identical
 * `where` object, via a single `Promise.all`. `orderBy` is
 * `createdAt desc, id desc` — this codebase's established newest-first,
 * fully-deterministic tie-broken ordering for every other paginated list
 * (features/leads/repository.ts's `listLeadsForActor`,
 * features/clients/repository.ts's `listClientsForActor`,
 * features/bookings/repository.ts's `listBookingsForActor`).
 */
export async function listProposalsForActor(
  db: Prisma.TransactionClient,
  actor: ProposalActor,
  params: ListProposalsParams,
): Promise<{ items: ProposalListItem[]; total: number }> {
  const where: Prisma.ProposalWhereInput = { client: proposalClientAssignmentFilter(actor) };

  const [items, total] = await Promise.all([
    db.proposal.findMany({
      where,
      select: PROPOSAL_LIST_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: params.skip,
      take: params.take,
    }),
    db.proposal.count({ where }),
  ]);

  return { items, total };
}

// --- Proposal detail (D-027 §6's `GET /api/proposals/[id]`, §8's detail UI) ---

export type ProposalDetailRecord = {
  id: string;
  client: ProposalClientIdentity;
  createdAt: Date;
  updatedAt: Date;
  versions: (ProposalVersionRecord & { acceptance: ProposalAcceptanceRecord | null })[];
};

/**
 * D-027 §6/§8's exact detail-response shape: the Proposal's own identity,
 * the linked Client's identity, and the complete version history — every
 * version carrying at least the nine fields D-027 §6 names, plus its
 * `acceptance` if any. Ordered `versionNumber desc` (newest revision
 * first), mirroring this codebase's established newest-first convention
 * for every other history-shaped list (e.g.
 * features/leads/repository.ts's `listLeadStatusHistoryForActor`'s
 * `createdAt desc`); `versionNumber` alone is already a full, deterministic
 * order for one Proposal's versions — `ProposalVersion`'s own
 * `@@unique([proposalId, versionNumber])` constraint guarantees no two
 * versions of the same Proposal ever tie, so no further tie-breaker is
 * needed. A legacy version whose `content` is `NULL` (Stage 1) is returned
 * exactly as stored, unchanged and un-substituted — D-027 §8's "Content
 * unavailable" UI state is a rendering decision for a later stage, not a
 * repository concern.
 *
 * A plain constant, not a per-actor builder function: unlike
 * features/clients/repository.ts's `buildClientDetailSelect` (whose nested
 * `leads` relation genuinely needs a different `where` per actor, via
 * `originatingLeadVisibilityFilter`), no nested relation selected here
 * varies by actor — the only actor-dependent scoping for a Proposal detail
 * read is the top-level `client` assignment filter
 * `findProposalByIdForActor` already applies in its own `where` clause.
 */
const PROPOSAL_DETAIL_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { id: true, fullName: true } },
  versions: {
    select: { ...PROPOSAL_VERSION_SELECT, acceptance: { select: PROPOSAL_ACCEPTANCE_SELECT } },
    orderBy: { versionNumber: 'desc' },
  },
} satisfies Prisma.ProposalSelect;

/**
 * Actor-scoped single-Proposal read (D-027 §3/§6). The assignment filter is
 * composed directly into this query's own `where` clause — never resolved
 * by fetching an unrestricted row and checking it afterward — so a
 * nonexistent Proposal and one that exists but belongs to a Client the
 * actor holds no active assignment for are both indistinguishable `null`
 * results, exactly the anti-enumeration property
 * features/bookings/repository.ts's `findBookingByIdForActor` already
 * establishes. Authorization for *which* controlled error a `null` result
 * becomes (`PROPOSAL_NOT_FOUND` vs. `PROPOSAL_FORBIDDEN`) is the future
 * service layer's decision, not this function's.
 */
export async function findProposalByIdForActor(
  db: Prisma.TransactionClient,
  actor: ProposalActor,
  id: string,
): Promise<ProposalDetailRecord | null> {
  return db.proposal.findFirst({
    where: { id, client: proposalClientAssignmentFilter(actor) },
    select: PROPOSAL_DETAIL_SELECT,
  });
}

// --- Unscoped identity/context lookups (future-service authorization inputs) ---
// Deliberately unscoped by actor and deliberately minimal — these exist
// only so the future service can resolve *which* Client a Proposal/
// ProposalVersion belongs to before it runs `canAccessClient`/
// `assertProposalAuthorAccess` against that id (D-027 §3). Neither may be
// used as a substitute for `findProposalByIdForActor`/`listProposalsForActor`
// above or for the actor-scoped ProposalVersion lookup below — none of
// these three functions performs or implies any authorization decision.

export type ProposalContext = { id: string; clientId: string };

/** Resolves a Proposal to its owning Client id, or `null` if it does not exist. */
export async function findProposalContext(
  db: Prisma.TransactionClient,
  proposalId: string,
): Promise<ProposalContext | null> {
  return db.proposal.findUnique({
    where: { id: proposalId },
    select: { id: true, clientId: true },
  });
}

export type ProposalVersionContext = { id: string; proposalId: string; clientId: string };

/** Resolves a ProposalVersion to its Proposal id and owning Client id, or `null` if it does not exist. */
export async function findProposalVersionContext(
  db: Prisma.TransactionClient,
  proposalVersionId: string,
): Promise<ProposalVersionContext | null> {
  const row = await db.proposalVersion.findUnique({
    where: { id: proposalVersionId },
    select: { id: true, proposalId: true, proposal: { select: { clientId: true } } },
  });
  if (!row) return null;
  return { id: row.id, proposalId: row.proposalId, clientId: row.proposal.clientId };
}

// --- Actor-scoped ProposalVersion context (publish/response workflows) ---

export type ProposalVersionActorContext = {
  id: string;
  proposalId: string;
  clientId: string;
  versionNumber: number;
  clientVisibleAt: Date | null;
  supersededAt: Date | null;
};

/**
 * Actor-scoped ProposalVersion lookup backing both the publish endpoint
 * (D-027 §5) and the response-recording endpoint (D-027 §7) — the single
 * shared primitive both future service workflows re-read inside their own
 * transaction, before and (transaction-locally) during their write. The
 * assignment filter (via `proposal.client`, mirroring
 * features/bookings/repository.ts's `findEligibleProposalVersionForActor`'s
 * identical `proposal: { client: ... }` relation path) is composed
 * directly into this query's `where` clause, so a nonexistent version and
 * one belonging to a Client the actor holds no active assignment for are
 * indistinguishable `null` results — D-027 §5's required
 * `PROPOSAL_VERSION_FORBIDDEN`-never-`NOT_FOUND` anti-enumeration property
 * for the Travel-Consultant-only publish route. Deliberately excludes
 * `content` (neither workflow renders or needs it) and returns
 * `clientVisibleAt`/`supersededAt` as raw data only — this function never
 * itself decides whether the version is current, superseded, or an
 * idempotent-no-op target; those decisions and their exact ordering belong
 * to the future service (D-027 §5/§7).
 */
export async function findProposalVersionForActor(
  db: Prisma.TransactionClient,
  actor: ProposalActor,
  proposalVersionId: string,
): Promise<ProposalVersionActorContext | null> {
  const row = await db.proposalVersion.findFirst({
    where: { id: proposalVersionId, proposal: { client: proposalClientAssignmentFilter(actor) } },
    select: {
      id: true,
      proposalId: true,
      versionNumber: true,
      clientVisibleAt: true,
      supersededAt: true,
      proposal: { select: { clientId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    proposalId: row.proposalId,
    clientId: row.proposal.clientId,
    versionNumber: row.versionNumber,
    clientVisibleAt: row.clientVisibleAt,
    supersededAt: row.supersededAt,
  };
}

// --- Proposal creation (D-027 §2/§6's `POST /api/proposals`) ---

export type ProposalRecord = { id: string; clientId: string; createdAt: Date; updatedAt: Date };

export type CreateProposalInput = {
  id: string;
  clientId: string;
  content: string;
  createdByUserId: string;
};

/**
 * Creates a Proposal and its first ProposalVersion (`versionNumber: 1`,
 * unpublished — `clientVisibleAt`/`supersededAt` both start `null`) as a
 * single nested Prisma write, so both rows commit or roll back together
 * within whatever transaction `db` belongs to — mirrors
 * features/bookings/repository.ts's `createBookingWithInitialHistory`'s
 * identical nested-create shape exactly. The Proposal's own id is
 * caller-supplied (the future service generates it via `randomUUID()`,
 * matching `createBookingWithInitialHistory`'s `input.id` convention); the
 * nested first version's id is generated here, matching that same
 * function's nested `statusHistory.create.id: randomUUID()` convention.
 * Never publishes the created version — that is an entirely separate,
 * later, explicit staff action (D-027 §5).
 */
export async function createProposalWithFirstVersion(
  db: Prisma.TransactionClient,
  input: CreateProposalInput,
): Promise<{ proposal: ProposalRecord; version: ProposalVersionRecord }> {
  const created = await db.proposal.create({
    data: {
      id: input.id,
      clientId: input.clientId,
      versions: {
        create: {
          id: randomUUID(),
          versionNumber: 1,
          content: input.content,
          createdByUserId: input.createdByUserId,
        },
      },
    },
    select: {
      id: true,
      clientId: true,
      createdAt: true,
      updatedAt: true,
      versions: { select: PROPOSAL_VERSION_SELECT },
    },
  });

  const [version] = created.versions;
  if (!version) {
    // Unreachable: the nested `versions.create` above always creates
    // exactly one ProposalVersion row in this same write. Present only to
    // satisfy TypeScript's control-flow analysis over Prisma's to-many
    // relation select, which is typed as an array even though exactly one
    // row is guaranteed here — mirrors features/bookings/service.ts's
    // `createBooking` retry loop's identical "Unreachable" comment
    // convention.
    throw new Error('createProposalWithFirstVersion: expected exactly one created version.');
  }

  return {
    proposal: {
      id: created.id,
      clientId: created.clientId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    },
    version,
  };
}

// --- Revision allocation and creation (D-027 §2/§6's `POST /api/proposals/[id]/versions`) ---

export type CreateProposalRevisionInput = {
  proposalId: string;
  content: string;
  createdByUserId: string;
};

/**
 * Allocates the next `versionNumber` for a Proposal (`MAX(versionNumber)
 * for this Proposal, or 0 if none exist, plus 1`) and creates exactly one
 * new ProposalVersion with it — both operations through the same
 * caller-provided `db` (D-027 §6). This function does not open a
 * transaction, does not retry a `P2034`/unique-constraint conflict, and
 * does not catch or translate any database error: relying on SERIALIZABLE
 * isolation to make the allocation race-safe, retrying inside
 * `runSerializableWithRetry` on a lost race, and the outer
 * up-to-three-attempt collision retry on a residual
 * `@@unique([proposalId, versionNumber])` conflict are all the future
 * service's responsibility (D-027 §6, mirroring
 * features/bookings/service.ts's `createBooking`'s identical
 * `bookingReference`-collision retry loop).
 */
export async function createProposalRevision(
  db: Prisma.TransactionClient,
  input: CreateProposalRevisionInput,
): Promise<ProposalVersionRecord> {
  const aggregate = await db.proposalVersion.aggregate({
    where: { proposalId: input.proposalId },
    _max: { versionNumber: true },
  });
  const nextVersionNumber = (aggregate._max.versionNumber ?? 0) + 1;

  return db.proposalVersion.create({
    data: {
      id: randomUUID(),
      proposalId: input.proposalId,
      versionNumber: nextVersionNumber,
      content: input.content,
      createdByUserId: input.createdByUserId,
    },
    select: PROPOSAL_VERSION_SELECT,
  });
}

// --- Publishing primitives (D-027 §5) ---
// Three narrow reads/writes the future service composes, in its own exact
// order, inside one `runSerializableWithRetry` transaction. None of these
// functions decides whether the target is already current, already
// superseded, matches `expectedCurrentVersionId`, or is an idempotent
// no-op — every one of those D-027 §5 outcomes is Stage 4 service logic.

/**
 * The Proposal's authoritative current client-visible version, if any
 * (`clientVisibleAt IS NOT NULL AND supersededAt IS NULL` — D-027 §5's own
 * literal definition of "current"). The existing partial unique index
 * `proposal_version_current_client_visible_key` (Proposal / ROS Schema
 * Foundation checkpoint) guarantees at most one row can ever match.
 */
export async function findCurrentClientVisibleVersion(
  db: Prisma.TransactionClient,
  proposalId: string,
): Promise<ProposalVersionRecord | null> {
  return db.proposalVersion.findFirst({
    where: { proposalId, clientVisibleAt: { not: null }, supersededAt: null },
    select: PROPOSAL_VERSION_SELECT,
  });
}

/**
 * Sets `supersededAt` on the prior current version being replaced by a
 * publish (D-027 §5 step (f)). `supersededAt` is supplied by the caller
 * (a single `Date` the service reads once per publish attempt), never
 * computed here, so the service can use the identical timestamp for this
 * write and the paired `markProposalVersionClientVisible` write below.
 */
export async function markProposalVersionSuperseded(
  db: Prisma.TransactionClient,
  id: string,
  supersededAt: Date,
): Promise<ProposalVersionRecord> {
  return db.proposalVersion.update({
    where: { id },
    data: { supersededAt },
    select: PROPOSAL_VERSION_SELECT,
  });
}

/**
 * Sets `clientVisibleAt` on the target version being published (D-027 §5
 * step (f)). `clientVisibleAt` is supplied by the caller, never computed
 * here. The database's partial unique index (see
 * `findCurrentClientVisibleVersion`'s doc comment) is the final backstop if
 * two publish attempts somehow both reach this write concurrently for the
 * same Proposal — this function does not catch or translate that
 * conflict; it propagates unchanged for the service layer to handle,
 * mirroring features/bookings/service.ts's `isOtherKnownConflict` pattern.
 */
export async function markProposalVersionClientVisible(
  db: Prisma.TransactionClient,
  id: string,
  clientVisibleAt: Date,
): Promise<ProposalVersionRecord> {
  return db.proposalVersion.update({
    where: { id },
    data: { clientVisibleAt },
    select: PROPOSAL_VERSION_SELECT,
  });
}

// --- External-response primitives (D-027 §4/§7/§9.1) ---

/**
 * The ProposalAcceptance already recorded for a ProposalVersion, if any.
 * Uses `findUnique` on `proposalVersionId` (the schema's own `@unique`
 * constraint — Proposal / ROS Schema Foundation checkpoint), not
 * `findFirst`, since at most one row can ever exist for a given version.
 * The future service reads this first, before any "is this version
 * current" check, per D-027 §7's fixed ordering — this function only
 * fetches; it does not decide which check wins.
 */
export async function findProposalAcceptanceForVersion(
  db: Prisma.TransactionClient,
  proposalVersionId: string,
): Promise<ProposalAcceptanceRecord | null> {
  return db.proposalAcceptance.findUnique({
    where: { proposalVersionId },
    select: PROPOSAL_ACCEPTANCE_SELECT,
  });
}

export type CreateExternalProposalAcceptanceInput = {
  proposalVersionId: string;
  responseType: ProposalResponseType;
  respondedAt: Date;
  recordedByStaffUserId: string;
  responseMethod: string;
  evidenceReference: string;
};

/**
 * Creates exactly one externally recorded ProposalAcceptance (D-027 §4/§9.1
 * — Accept, Decline, or Request Changes entered by staff on the client's
 * behalf). `responseMethod`/`evidenceReference` are persisted exactly as
 * supplied — schemas.ts's `recordProposalResponseSchema` has already
 * trimmed and length-validated both; this function invents no further
 * transformation of either. The portal-response attribution fields
 * (`respondingClientProfileId`, `respondingSessionIdAtResponse`) are never
 * set here — omitted, not merely left `undefined` by accident: D-027 §4's
 * two attribution paths are mutually exclusive, and portal-based
 * acceptance remains deferred to Phase 3, so this function's write can only
 * ever populate the external path's own complete field set (the
 * `proposal_acceptance_response_path` CHECK constraint enforces this same
 * invariant at the database level regardless). Does not catch or translate
 * a residual unique-constraint conflict on `proposalVersionId` (at most one
 * response per version) — the future service's D-027 §7 "does an
 * acceptance already exist" read is expected to catch this ordinarily; any
 * conflict that still reaches this write is the service's error-handling
 * concern, not this repository's.
 */
export async function createExternalProposalAcceptance(
  db: Prisma.TransactionClient,
  input: CreateExternalProposalAcceptanceInput,
): Promise<ProposalAcceptanceRecord> {
  return db.proposalAcceptance.create({
    data: {
      id: randomUUID(),
      proposalVersionId: input.proposalVersionId,
      responseType: input.responseType,
      respondedAt: input.respondedAt,
      recordedByStaffUserId: input.recordedByStaffUserId,
      responseMethod: input.responseMethod,
      evidenceReference: input.evidenceReference,
    },
    select: PROPOSAL_ACCEPTANCE_SELECT,
  });
}

// --- Audit (D-027 §9) ---
// This feature's own append-only AuditLog writer — mirrors
// features/bookings/repository.ts's, features/clients/repository.ts's, and
// features/assignments/repository.ts's identically-shaped writer exactly,
// each an intentional, independent local copy rather than a shared
// cross-feature import (.claude/rules/architecture.md). This function never
// builds a snapshot itself and must never be called with
// `ProposalVersion.content` in either `beforeState` or `afterState` —
// snapshot sanitization is audit.ts's job; deciding *when*, with *what*
// action/entity, and inside which transaction to call this is the future
// service's job.

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

// --- Client-portal reads (docs/HERITAGE_V3_DECISIONS_LOG.md D-040 §4) ---
// The Proposal / ROS feature owns every ProposalVersion database read,
// including the two the Client Home / Overview consumes. Pure, bounded
// reads: no assignment filter is composed here (D-040 scopes strictly by
// the server-resolved owned `clientId`, and authorization is the caller's
// `canAccessClient` gate in features/proposals/service.ts, not a query
// filter), no transaction, no write, no audit, and never any proposal
// `content`.

/**
 * D-040 §4's "current-client-visible" predicate for a ProposalVersion of
 * this Client: `clientVisibleAt` set AND `supersededAt` null. The partial
 * unique index `proposal_version_current_client_visible_key` guarantees at
 * most one such version per Proposal. Draft-only, unpublished, and
 * superseded versions are all excluded — so a staff-only draft proposal is
 * never counted or revealed.
 */
function clientVisibleVersionBaseWhere(clientId: string): Prisma.ProposalVersionWhereInput {
  return {
    proposal: { clientId },
    clientVisibleAt: { not: null },
    supersededAt: null,
  };
}

export type ClientProposalFacts = {
  currentVisibleTotal: number;
  awaitingResponse: number;
  accepted: number;
  acceptedWithoutClientVisibleBooking: number;
  respondedNonAccept: number;
};

/**
 * D-040 §4's five bounded `count()` facts over the complete set of
 * current-client-visible versions for one Client. Every count applies the
 * base predicate plus its own addition:
 *
 * - `currentVisibleTotal` — base only.
 * - `awaitingResponse` — no `ProposalAcceptance` row.
 * - `accepted` — an ACCEPT acceptance.
 * - `acceptedWithoutClientVisibleBooking` — an ACCEPT acceptance AND
 *   (no associated `Booking` OR an associated `Booking` with `status =
 *   DRAFT`): a staff-side DRAFT booking is invisible to the client, so the
 *   accepted proposal is still awaiting a booking from the client's view.
 * - `respondedNonAccept` — a DECLINE or REQUEST_CHANGES acceptance.
 *
 * Invariant (asserted by the service/integration tests, not here):
 * `awaitingResponse + accepted + respondedNonAccept === currentVisibleTotal`,
 * and `0 <= acceptedWithoutClientVisibleBooking <= accepted`.
 */
export async function findClientProposalFacts(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<ClientProposalFacts> {
  const base = clientVisibleVersionBaseWhere(clientId);
  const [
    currentVisibleTotal,
    awaitingResponse,
    accepted,
    acceptedWithoutClientVisibleBooking,
    respondedNonAccept,
  ] = await Promise.all([
    db.proposalVersion.count({ where: base }),
    db.proposalVersion.count({ where: { ...base, acceptance: { is: null } } }),
    db.proposalVersion.count({
      where: { ...base, acceptance: { is: { responseType: 'ACCEPT' } } },
    }),
    db.proposalVersion.count({
      where: {
        ...base,
        acceptance: { is: { responseType: 'ACCEPT' } },
        OR: [{ booking: { is: null } }, { booking: { is: { status: 'DRAFT' } } }],
      },
    }),
    db.proposalVersion.count({
      where: {
        ...base,
        acceptance: { is: { responseType: { in: ['DECLINE', 'REQUEST_CHANGES'] } } },
      },
    }),
  ]);

  return {
    currentVisibleTotal,
    awaitingResponse,
    accepted,
    acceptedWithoutClientVisibleBooking,
    respondedNonAccept,
  };
}

export const CLIENT_OVERVIEW_PROPOSAL_PREVIEW_MAX = 5;

export type ClientProposalPreviewRow = {
  versionNumber: number;
  responseType: ProposalResponseType | null;
};

/**
 * D-040 §4's bounded (five-item) client-visible proposal preview for one
 * Client, applying the identical current-client-visible predicate before
 * ordering and limiting. `orderBy: [proposal.createdAt desc, proposal.id
 * asc]` — deterministic, `proposal.id` breaking a `createdAt` tie. Selects
 * only `versionNumber` and the acceptance's `responseType`; no proposal
 * `content`, no `Proposal`/`ProposalVersion`/`ProposalAcceptance` id.
 */
export async function findClientProposalPreview(
  db: Prisma.TransactionClient,
  clientId: string,
): Promise<ClientProposalPreviewRow[]> {
  const rows = await db.proposalVersion.findMany({
    where: clientVisibleVersionBaseWhere(clientId),
    orderBy: [{ proposal: { createdAt: 'desc' } }, { proposal: { id: 'asc' } }],
    take: CLIENT_OVERVIEW_PROPOSAL_PREVIEW_MAX,
    select: { versionNumber: true, acceptance: { select: { responseType: true } } },
  });
  return rows.map((row) => ({
    versionNumber: row.versionNumber,
    responseType: row.acceptance?.responseType ?? null,
  }));
}
