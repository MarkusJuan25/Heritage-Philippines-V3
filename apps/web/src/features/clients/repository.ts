import { randomUUID } from 'node:crypto';

import type { LeadStatus, Prisma } from '@/generated/prisma/client';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a Prisma client or transaction client as its first
// argument so callers can run reads inside the same transaction as the
// writes they gate (see the future features/clients/service.ts) — none of
// these functions open their own transaction (D-025 §7's plain-transaction
// contract is a service-layer concern, not this module's).
//
// Repository ownership stays split exactly as D-025 §6 requires: the
// existing Lead/conversion duplicate-query primitives
// (`findDuplicateLeadMatches`, `findDuplicateClientMatches`,
// `createClientFromLead`, `findClientSummaryById`) remain owned by
// features/leads/repository.ts, unchanged by this module. This module owns
// only Client Management's own read/duplicate-detection/conditional-update
// primitives — it is not a general Client repository for other features to
// reach into, and it never creates, ends, or otherwise writes a
// `StaffAssignment` row (assignment mutation remains exclusively
// features/assignments/service.ts's `setClientAssignment`/
// `endClientAssignment`, reused unchanged).

export type ClientActor = { id: string; role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' };

/**
 * Explicitly exhaustive over `ClientActor`'s two roles, mirroring
 * features/leads/repository.ts's `leadAssignmentFilter` discipline exactly:
 * the `default` branch exists only to make that exhaustiveness a
 * compile-time guarantee. Scopes the Client LIST query itself (D-025 §2) —
 * never a per-row `canAccessClient` check, and never "fetch every Client
 * and filter in code" (.claude/rules/admin-dashboard.md's Visibility
 * Scoping rule).
 */
function clientAssignmentFilter(actor: ClientActor): Prisma.ClientWhereInput | undefined {
  switch (actor.role) {
    case 'ADMIN_MANAGER':
      return undefined;
    case 'TRAVEL_CONSULTANT':
      return { assignments: { some: { assignedStaffId: actor.id, endedAt: null } } };
    default: {
      const exhaustiveCheck: never = actor.role;
      throw new Error(`Unhandled ClientActor role: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * The Lead-assignment visibility rule D-025 §2/§4 requires for a Client's
 * `originatingLeads` — structurally identical to `clientAssignmentFilter`
 * above (same active-assignment shape), but scoped against the `Lead`
 * model's own `assignments` relation, never the Client's. `ADMIN_MANAGER`
 * sees every Lead linked to the Client; `TRAVEL_CONSULTANT` sees only the
 * subset they independently hold an active Lead assignment for — applied
 * inside the nested `leads` relation query itself (see
 * `buildClientDetailSelect` below), never by fetching every linked Lead and
 * filtering client-side.
 */
function originatingLeadVisibilityFilter(actor: ClientActor): Prisma.LeadWhereInput | undefined {
  switch (actor.role) {
    case 'ADMIN_MANAGER':
      return undefined;
    case 'TRAVEL_CONSULTANT':
      return { assignments: { some: { assignedStaffId: actor.id, endedAt: null } } };
    default: {
      const exhaustiveCheck: never = actor.role;
      throw new Error(`Unhandled ClientActor role: ${String(exhaustiveCheck)}`);
    }
  }
}

export type ClientAssignmentSummary = { staffId: string; staffName: string } | null;

const CLIENT_ASSIGNMENT_SELECT = {
  where: { endedAt: null },
  take: 1,
  select: {
    assignedStaffId: true,
    assignedStaff: { select: { id: true, name: true } },
  },
} as const;

/**
 * Maps a raw Prisma `assignments` nested-select array (at most one row —
 * the database's own partial unique active-assignment index guarantees
 * this, see the `StaffAssignment` model's doc comment in schema.prisma) to
 * D-025 §3/§4's `assignment: { staffId, staffName } | null` shape. The
 * `[0]` read is defensive only.
 */
function toAssignmentSummary(
  assignments: readonly { assignedStaffId: string; assignedStaff: { id: string; name: string } }[],
): ClientAssignmentSummary {
  const active = assignments[0];
  return active ? { staffId: active.assignedStaffId, staffName: active.assignedStaff.name } : null;
}

// --- Client list (D-025 §3) ---

export type ClientListItem = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  createdAt: Date;
  assignment: ClientAssignmentSummary;
};

// Deliberately narrow: excludes normalizedEmail/normalizedPhone, address,
// nationality, dateOfBirth, emergencyContact, notes, updatedAt,
// originatingLeads, and any audit information — D-025 §3's exact,
// closed list-item field set.
const CLIENT_LIST_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  createdAt: true,
  assignments: CLIENT_ASSIGNMENT_SELECT,
} as const;

type ClientListRow = Prisma.ClientGetPayload<{ select: typeof CLIENT_LIST_SELECT }>;

function toClientListItem(row: ClientListRow): ClientListItem {
  const { assignments, ...rest } = row;
  return { ...rest, assignment: toAssignmentSummary(assignments) };
}

export type ListClientsParams = { skip: number; take: number; search?: string };

/**
 * Paginated, actor-scoped Client list (D-025 §2/§3). The assignment filter
 * and the `search` filter are composed directly into both queries' `where`
 * clause — never "fetch every Client and filter in code". `orderBy`
 * includes `id` as a tie-breaker after `createdAt`, matching every other
 * paginated list in this codebase (`listLeadsForActor`,
 * `listBookingsForActor`).
 */
export async function listClientsForActor(
  db: Prisma.TransactionClient,
  actor: ClientActor,
  params: ListClientsParams,
): Promise<{ items: ClientListItem[]; total: number }> {
  const where: Prisma.ClientWhereInput = {
    ...clientAssignmentFilter(actor),
    ...(params.search
      ? {
          OR: [
            { fullName: { contains: params.search, mode: 'insensitive' } },
            { email: { contains: params.search, mode: 'insensitive' } },
            { phone: { contains: params.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.client.findMany({
      where,
      select: CLIENT_LIST_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: params.skip,
      take: params.take,
    }),
    db.client.count({ where }),
  ]);

  return { items: items.map(toClientListItem), total };
}

// --- Client detail (D-025 §4) ---

export type OriginatingLeadSummary = {
  id: string;
  fullName: string;
  status: LeadStatus;
  source: string;
  createdAt: Date;
};

export type ClientDetailRecord = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  nationality: string | null;
  dateOfBirth: string | null;
  emergencyContact: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  assignment: ClientAssignmentSummary;
  originatingLeads: OriginatingLeadSummary[];
};

/**
 * D-025 §4's exact, closed detail-response field set, plus the two nested
 * reads (`assignments`, `leads`) `assignment`/`originatingLeads` are
 * derived from. `leads`' own `where` is actor-dependent
 * (`originatingLeadVisibilityFilter`), so this select is built per call
 * rather than a single shared module-level constant — every other key is
 * identical across both roles.
 */
function buildClientDetailSelect(actor: ClientActor) {
  return {
    id: true,
    fullName: true,
    email: true,
    phone: true,
    address: true,
    nationality: true,
    dateOfBirth: true,
    emergencyContact: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
    assignments: CLIENT_ASSIGNMENT_SELECT,
    leads: {
      where: originatingLeadVisibilityFilter(actor),
      select: {
        id: true,
        fullName: true,
        status: true,
        source: true,
        createdAt: true,
      },
      // Explicitly (non-`const`) typed: the surrounding `as const` below
      // would otherwise freeze this into a readonly tuple, which Prisma's
      // generated `Client$leadsArgs['orderBy']` (a mutable array type)
      // rejects.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] as Prisma.LeadOrderByWithRelationInput[],
    },
  } as const;
}

type ClientDetailRow = Prisma.ClientGetPayload<{
  select: ReturnType<typeof buildClientDetailSelect>;
}>;

/**
 * Converts a persisted `@db.Date` value (always UTC midnight — see
 * `dateOfBirthSchema` in schemas.ts) to a bare `YYYY-MM-DD` string using
 * only its UTC date parts (D-025 §4: "returned only as a bare `YYYY-MM-DD`
 * date, never a timestamp"). Deliberately uses `getUTC*` accessors, never
 * `getFullYear`/`getMonth`/`getDate` (which read the *local* time zone of
 * whatever process runs this code) — the result must not depend on the
 * server's local time zone.
 */
function toDateOnlyString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toClientDetailRecord(row: ClientDetailRow): ClientDetailRecord {
  const { assignments, leads, dateOfBirth, ...rest } = row;
  return {
    ...rest,
    dateOfBirth: dateOfBirth ? toDateOnlyString(dateOfBirth) : null,
    assignment: toAssignmentSummary(assignments),
    originatingLeads: leads,
  };
}

/**
 * `GET /api/clients/[id]`'s own read (D-025 §4). Actor-aware — unlike a
 * Lead's equivalent read, a Client's `originatingLeads` must itself be
 * scoped by the actor's Lead-assignment visibility (D-025 §2), so this
 * function (unlike `findClientById` below) always takes the actor.
 * Authorization for the Client itself (`canAccessClient`) is decided by the
 * future service layer before this is called — this function only fetches.
 */
export async function findClientByIdForRead(
  db: Prisma.TransactionClient,
  id: string,
  actor: ClientActor,
): Promise<ClientDetailRecord | null> {
  const row = await db.client.findUnique({ where: { id }, select: buildClientDetailSelect(actor) });
  return row ? toClientDetailRecord(row) : null;
}

// --- Plain, unscoped Client read (mutation/existence-check use) ---

export type ClientRecord = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  normalizedEmail: string | null;
  normalizedPhone: string | null;
  address: string | null;
  nationality: string | null;
  dateOfBirth: Date | null;
  emergencyContact: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const CLIENT_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  normalizedEmail: true,
  normalizedPhone: true,
  address: true,
  nationality: true,
  dateOfBirth: true,
  emergencyContact: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Plain, unscoped single-Client fetch — mirrors
 * features/leads/repository.ts's `findLeadById` exactly. Used by the future
 * service layer both to read the authoritative current row before a
 * `PATCH` (D-025 §5/§7 — computing the combined email/phone invariant and
 * duplicate-detection inputs) and, after a conditional update matches zero
 * rows, to distinguish a genuinely missing Client from a merely stale
 * `expectedUpdatedAt` (D-025 §7). Never returns `assignment` or
 * `originatingLeads` — those belong only to `findClientByIdForRead` above.
 */
export async function findClientById(
  db: Prisma.TransactionClient,
  id: string,
): Promise<ClientRecord | null> {
  return db.client.findUnique({ where: { id }, select: CLIENT_SELECT });
}

// --- Duplicate detection (D-025 §6) ---
// Narrow, Client-edit-scoped primitives only. Both self-exclude the Client
// currently being edited, applied directly inside each query's own `where`
// clause — never by fetching unfiltered results and excluding them
// afterward. Neither takes an actor: per-match visibility shaping
// (`canAccessLead`/`canAccessClient`, `restrictedMatchDetected`) is a
// service-layer concern (D-022 §5's established pattern), not this
// repository's.

export type ClientDuplicateMatchRow = {
  id: string;
  fullName: string;
  matchedOn: ('EMAIL' | 'PHONE')[];
};
export type LeadDuplicateMatchRow = ClientDuplicateMatchRow & { status: LeadStatus };

function computeMatchedOn(
  row: { normalizedEmail: string | null; normalizedPhone: string | null },
  params: { normalizedEmail?: string; normalizedPhone?: string },
): ('EMAIL' | 'PHONE')[] {
  const matchedOn: ('EMAIL' | 'PHONE')[] = [];
  if (params.normalizedEmail && row.normalizedEmail === params.normalizedEmail) {
    matchedOn.push('EMAIL');
  }
  if (params.normalizedPhone && row.normalizedPhone === params.normalizedPhone) {
    matchedOn.push('PHONE');
  }
  return matchedOn;
}

/**
 * Finds every OTHER Client whose normalized email or phone matches the
 * submitted values (D-025 §6), excluding the Client currently being edited
 * via `id: { not: excludeClientId }` applied inside the query itself.
 */
export async function findDuplicateClientMatches(
  db: Prisma.TransactionClient,
  params: { normalizedEmail?: string; normalizedPhone?: string; excludeClientId: string },
): Promise<ClientDuplicateMatchRow[]> {
  const orConditions: Prisma.ClientWhereInput[] = [];
  if (params.normalizedEmail) orConditions.push({ normalizedEmail: params.normalizedEmail });
  if (params.normalizedPhone) orConditions.push({ normalizedPhone: params.normalizedPhone });
  if (orConditions.length === 0) return [];

  const rows = await db.client.findMany({
    where: {
      OR: orConditions,
      id: { not: params.excludeClientId },
    },
    select: { id: true, fullName: true, normalizedEmail: true, normalizedPhone: true },
  });

  return rows.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    matchedOn: computeMatchedOn(row, params),
  }));
}

/**
 * Finds every Lead whose normalized email or phone matches the submitted
 * values, excluding only the Client's OWN originating Lead(s) — D-025 §6's
 * corrected self-exclusion rule. `NOT { clientId: excludeClientId }` alone
 * cannot be trusted to include NULL rows (`clientId IS NULL`, an unlinked
 * Lead) under every possible query-builder translation, so the exclusion
 * is spelled out explicitly and unambiguously as
 * "`clientId` is null OR `clientId` differs from the Client being edited" —
 * an unlinked Lead and a Lead linked to a DIFFERENT Client both still
 * match; only a Lead already linked to this exact Client is excluded.
 */
export async function findDuplicateLeadMatches(
  db: Prisma.TransactionClient,
  params: { normalizedEmail?: string; normalizedPhone?: string; excludeClientId: string },
): Promise<LeadDuplicateMatchRow[]> {
  const orConditions: Prisma.LeadWhereInput[] = [];
  if (params.normalizedEmail) orConditions.push({ normalizedEmail: params.normalizedEmail });
  if (params.normalizedPhone) orConditions.push({ normalizedPhone: params.normalizedPhone });
  if (orConditions.length === 0) return [];

  const rows = await db.lead.findMany({
    where: {
      AND: [
        { OR: orConditions },
        { OR: [{ clientId: null }, { clientId: { not: params.excludeClientId } }] },
      ],
    },
    select: {
      id: true,
      fullName: true,
      status: true,
      normalizedEmail: true,
      normalizedPhone: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    status: row.status,
    matchedOn: computeMatchedOn(row, params),
  }));
}

// --- Conditional update (D-025 §7) ---

export type UpdateClientFieldsInput = {
  id: string;
  expectedUpdatedAt: Date;
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  normalizedEmail?: string | null;
  normalizedPhone?: string | null;
  address?: string | null;
  nationality?: string | null;
  dateOfBirth?: Date | null;
  emergencyContact?: string | null;
  notes?: string | null;
};

/**
 * Applies a changed Client write atomically, using both the Client's `id`
 * and the expected `updatedAt` value in the update predicate itself
 * (D-025 §7: `updateMany({ where: { id, updatedAt: expectedUpdatedAt },
 * data })`) — the staleness comparison and the write are one indivisible
 * database operation, not a separate read-then-write pair, so no elevated
 * transaction isolation level is required for this check alone. Returns
 * Prisma's own `{ count }`: `count === 1` means the write applied; `count
 * === 0` means either the Client no longer exists or `updatedAt` no longer
 * matches — the caller (the future service layer) distinguishes the two by
 * re-checking existence inside the same transaction (D-025 §7). Suitable
 * for use inside a plain `prisma.$transaction` — this function does not,
 * and must not, open its own transaction.
 */
export async function updateClientFieldsIfUnstale(
  db: Prisma.TransactionClient,
  input: UpdateClientFieldsInput,
): Promise<{ count: number }> {
  const { id, expectedUpdatedAt, ...data } = input;
  return db.client.updateMany({
    where: { id, updatedAt: expectedUpdatedAt },
    data,
  });
}

// --- Audit (D-025 §8) ---
// This feature's own append-only AuditLog writer — the Client service must
// never call Prisma delegates directly, and must never borrow
// features/leads/repository.ts's or features/assignments/repository.ts's
// identically-shaped writer, even though all three are structurally
// identical: each feature owns its own data-access layer
// (.claude/rules/backend.md's "Repository/data-access layer";
// .claude/rules/architecture.md's cross-feature-reuse discipline).

/**
 * Writes one append-only `AuditLog` row — mirrors
 * features/leads/repository.ts's `insertAuditLog` exactly. The id is
 * generated server-side (`randomUUID()`), never caller-supplied. Does not
 * open a transaction — the caller (features/clients/service.ts) supplies
 * `db`, typically the same transaction client as the mutation this entry
 * records, so both commit or roll back together.
 */
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
