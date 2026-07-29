import { randomUUID } from 'node:crypto';

import { LeadStatus, type Prisma } from '@/generated/prisma/client';

import { LEAD_AUDIT_ACTIONS, LEAD_AUDIT_ENTITY_TYPE } from './audit';

// The only layer that talks to the database for this feature
// (.claude/rules/backend.md's "Repository/data-access layer"). Every
// function takes a Prisma client or transaction client as its first
// argument so callers can run reads inside the same transaction as the
// writes they gate (see features/leads/service.ts) — none of these
// functions open their own transaction.
//
// Single-resource authorization (GET/PATCH/status) is handled by
// features/assignments/authorization.ts's existing `canAccessLead`
// (D-022 §2/§8) — this module's functions for that purpose are therefore
// plain, unscoped fetches (`findLeadById`) rather than actor-scoped ones.
// Only the *list* query needs a query-embedded scoping filter of its own
// (`leadAssignmentFilter` below), since `canAccessLead` checks one resource
// at a time and calling it once per list row would mean fetching unscoped
// rows first — exactly what .claude/rules/admin-dashboard.md's Visibility
// Scoping rule forbids. This mirrors features/bookings/repository.ts's
// `clientAssignmentFilter`, applied directly to `Lead.assignments` (Lead —
// unlike Booking — has a direct assignment relation, no Client indirection).

export type LeadActor = { id: string; role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' };

/**
 * Explicitly exhaustive over `LeadActor`'s two roles, matching
 * features/bookings/repository.ts's `clientAssignmentFilter` discipline: the
 * `default` branch exists only to make that exhaustiveness a compile-time
 * guarantee — if `LeadActor`'s role union ever grows, this fails to compile
 * until a case is added, instead of silently falling through to
 * unrestricted access.
 */
function leadAssignmentFilter(actor: LeadActor): Prisma.LeadWhereInput | undefined {
  switch (actor.role) {
    case 'ADMIN_MANAGER':
      return undefined;
    case 'TRAVEL_CONSULTANT':
      return { assignments: { some: { assignedStaffId: actor.id, endedAt: null } } };
    default: {
      const exhaustiveCheck: never = actor.role;
      throw new Error(`Unhandled LeadActor role: ${String(exhaustiveCheck)}`);
    }
  }
}

export type LeadRecord = {
  id: string;
  status: LeadStatus;
  fullName: string;
  email: string | null;
  phone: string | null;
  normalizedEmail: string | null;
  normalizedPhone: string | null;
  source: string;
  notes: string | null;
  clientId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// D-023 §5's additive read-only extension, kept structurally separate from
// LeadRecord (Stage 2 correction). LeadRecord is the shared shape every
// mutation-backing function (createLeadWithInitialHistory,
// updateLeadFields, updateLeadStatusWithHistory) returns, and D-023's own
// Constraint requires those responses to keep their exact pre-D-023 shape
// — never gaining `assignment` merely because a *different* query needed
// it. Only `findLeadByIdForRead` and `listLeadsForActor` (backing
// `GET /api/leads/[id]` and `GET /api/leads`, the only two surfaces D-023
// §5 names) return this richer type.
export type LeadRecordWithAssignment = LeadRecord & {
  assignment: { staffId: string; staffName: string } | null;
};

const LEAD_SELECT = {
  id: true,
  status: true,
  fullName: true,
  email: true,
  phone: true,
  normalizedEmail: true,
  normalizedPhone: true,
  source: true,
  notes: true,
  clientId: true,
  createdAt: true,
  updatedAt: true,
} as const;

// GET-only select (D-023 §5): LEAD_SELECT plus the Lead's current active
// assignment, retrieved via Prisma's own batched/declarative nested
// relation select — never one application-level query per Lead. Used only
// by `findLeadByIdForRead`/`listLeadsForActor`, never by any mutation-
// backing function, so `assignment` cannot appear in a POST/PATCH/
// PUT-status response merely through shared-type/shared-select reuse
// (Stage 2 correction). The database's partial unique index on (leadId)
// WHERE endedAt IS NULL (see features/assignments/repository.ts's
// findActiveAssignmentForLead doc comment) guarantees at most one row can
// ever match.
const LEAD_SELECT_WITH_ASSIGNMENT = {
  ...LEAD_SELECT,
  assignments: {
    where: { endedAt: null },
    take: 1,
    select: {
      assignedStaffId: true,
      assignedStaff: { select: { id: true, name: true } },
    },
  },
} as const;

type LeadRowWithAssignment = Prisma.LeadGetPayload<{ select: typeof LEAD_SELECT_WITH_ASSIGNMENT }>;

/**
 * Maps a raw Prisma Lead row (LEAD_SELECT_WITH_ASSIGNMENT's nested
 * `assignments` array) to LeadRecordWithAssignment's single `assignment`
 * field (D-023 §5). `[0]` is a defensive read — the database's own partial
 * unique active-assignment index is what actually guarantees at most one
 * row, not this mapping.
 */
function toLeadRecordWithAssignment(row: LeadRowWithAssignment): LeadRecordWithAssignment {
  const { assignments, ...rest } = row;
  const active = assignments[0];
  return {
    ...rest,
    assignment: active
      ? { staffId: active.assignedStaffId, staffName: active.assignedStaff.name }
      : null,
  };
}

/** Plain, unscoped single-Lead fetch — the actor-authorization decision has
 * already been made by `canAccessLead` before this is called (service.ts).
 * Returns the original, assignment-free LeadRecord shape: reused directly
 * by mutation no-op/existence-check paths (`updateLead`, `updateLeadStatus`,
 * `getLeadStatusHistory`) whose responses must never carry `assignment`
 * (Stage 2 correction). `GET /api/leads/[id]` uses the structurally
 * separate `findLeadByIdForRead` below instead. */
export async function findLeadById(
  db: Prisma.TransactionClient,
  id: string,
): Promise<LeadRecord | null> {
  return db.lead.findUnique({ where: { id }, select: LEAD_SELECT });
}

/**
 * `GET /api/leads/[id]`'s own read (D-023 §5) — deliberately a distinct
 * function/select/type from `findLeadById`, so the richer
 * LeadRecordWithAssignment shape can never leak into a mutation response
 * merely by some other call site reusing this function (Stage 2
 * correction).
 */
export async function findLeadByIdForRead(
  db: Prisma.TransactionClient,
  id: string,
): Promise<LeadRecordWithAssignment | null> {
  const row = await db.lead.findUnique({ where: { id }, select: LEAD_SELECT_WITH_ASSIGNMENT });
  return row ? toLeadRecordWithAssignment(row) : null;
}

export type ListLeadsParams = {
  skip: number;
  take: number;
  status?: LeadStatus;
  source?: string;
  search?: string;
};

/**
 * Paginated, actor-scoped Lead list (D-022 §8). The assignment filter and
 * every named filter are composed directly into both queries' `where`
 * clause — never "fetch every Lead and filter in code"
 * (.claude/rules/admin-dashboard.md's Visibility Scoping rule). `orderBy`
 * includes `id` as a tie-breaker after `createdAt`, matching
 * `listBookingsForActor`'s deterministic-pagination discipline.
 */
export async function listLeadsForActor(
  db: Prisma.TransactionClient,
  actor: LeadActor,
  params: ListLeadsParams,
): Promise<{ items: LeadRecordWithAssignment[]; total: number }> {
  const where: Prisma.LeadWhereInput = {
    ...leadAssignmentFilter(actor),
    ...(params.status ? { status: params.status } : {}),
    ...(params.source ? { source: params.source } : {}),
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
    db.lead.findMany({
      where,
      select: LEAD_SELECT_WITH_ASSIGNMENT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: params.skip,
      take: params.take,
    }),
    db.lead.count({ where }),
  ]);

  return { items: items.map(toLeadRecordWithAssignment), total };
}

export type CreateLeadInput = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  normalizedEmail: string | null;
  normalizedPhone: string | null;
  source: string;
  notes: string | null;
  changedByUserId: string;
};

/**
 * Creates a Lead (status NEW) and its initial LeadStatusHistory row
 * (`previousStatus: null, newStatus: NEW`) as a single nested Prisma write,
 * so both rows commit or roll back together within whatever transaction
 * `db` belongs to — mirrors
 * features/bookings/repository.ts's `createBookingWithInitialHistory`
 * exactly (D-022 §7).
 */
export async function createLeadWithInitialHistory(
  db: Prisma.TransactionClient,
  input: CreateLeadInput,
): Promise<LeadRecord> {
  return db.lead.create({
    data: {
      id: input.id,
      status: LeadStatus.NEW,
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      normalizedEmail: input.normalizedEmail,
      normalizedPhone: input.normalizedPhone,
      source: input.source,
      notes: input.notes,
      statusHistory: {
        create: {
          id: randomUUID(),
          previousStatus: null,
          newStatus: LeadStatus.NEW,
          changedByUserId: input.changedByUserId,
        },
      },
    },
    select: LEAD_SELECT,
  });
}

export type UpdateLeadFieldsInput = {
  id: string;
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  normalizedEmail?: string | null;
  normalizedPhone?: string | null;
  source?: string;
  notes?: string | null;
};

/**
 * Updates only the ordinary Lead fields present in `input` (Prisma's
 * `update` skips any key whose value is `undefined`, so the caller — never
 * this function — decides which fields actually change; see service.ts's
 * `updateLead`). Never creates a LeadStatusHistory row — an ordinary edit
 * never changes `status`.
 */
export async function updateLeadFields(
  db: Prisma.TransactionClient,
  input: UpdateLeadFieldsInput,
): Promise<LeadRecord> {
  const { id, ...data } = input;
  return db.lead.update({ where: { id }, data, select: LEAD_SELECT });
}

export type UpdateLeadStatusInput = {
  id: string;
  previousStatus: LeadStatus;
  newStatus: LeadStatus;
  changedByUserId: string;
};

/**
 * Updates `Lead.status` and creates the corresponding LeadStatusHistory row
 * as a single nested Prisma write — mirrors
 * `updateBookingStatusWithHistory` exactly. Transition *policy* lives in
 * transitions.ts, never here — this function only persists a transition
 * already approved by the caller (service.ts).
 */
export async function updateLeadStatusWithHistory(
  db: Prisma.TransactionClient,
  input: UpdateLeadStatusInput,
): Promise<LeadRecord> {
  return db.lead.update({
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
    select: LEAD_SELECT,
  });
}

export type DuplicateMatchRow = {
  id: string;
  fullName: string;
  matchedOn: ('EMAIL' | 'PHONE')[];
};

export type LeadDuplicateMatchRow = DuplicateMatchRow & { status: LeadStatus };

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
 * Finds every Lead whose normalized email or phone matches the submitted
 * values (D-022 §5), run against `db` (always the live `prisma` singleton
 * in this checkpoint — see service.ts's doc comment on why duplicate
 * detection cannot be composed into the creation/edit transaction).
 * Deduplicates naturally by id (one `findMany` row per Lead, `matchedOn`
 * computed per row so a record matching both channels appears once with
 * both listed). `excludeId` implements edit-time self-exclusion (D-022 §5)
 * — omitted entirely at creation time, where no such row can exist yet.
 */
export async function findDuplicateLeadMatches(
  db: Prisma.TransactionClient,
  params: { normalizedEmail?: string; normalizedPhone?: string; excludeId?: string },
): Promise<LeadDuplicateMatchRow[]> {
  const orConditions: Prisma.LeadWhereInput[] = [];
  if (params.normalizedEmail) orConditions.push({ normalizedEmail: params.normalizedEmail });
  if (params.normalizedPhone) orConditions.push({ normalizedPhone: params.normalizedPhone });
  if (orConditions.length === 0) return [];

  const rows = await db.lead.findMany({
    where: {
      OR: orConditions,
      ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
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

/**
 * Finds every Client whose normalized email or phone matches the submitted
 * values (D-022 §5) — the Client-side counterpart of
 * `findDuplicateLeadMatches`. No self-exclusion parameter: a Client row is
 * never the record being created or edited by this feature (D-022 §5 does
 * not exclude Client rows during edit-time duplicate checking).
 */
export async function findDuplicateClientMatches(
  db: Prisma.TransactionClient,
  params: { normalizedEmail?: string; normalizedPhone?: string },
): Promise<DuplicateMatchRow[]> {
  const orConditions: Prisma.ClientWhereInput[] = [];
  if (params.normalizedEmail) orConditions.push({ normalizedEmail: params.normalizedEmail });
  if (params.normalizedPhone) orConditions.push({ normalizedPhone: params.normalizedPhone });
  if (orConditions.length === 0) return [];

  const rows = await db.client.findMany({
    where: { OR: orConditions },
    select: { id: true, fullName: true, normalizedEmail: true, normalizedPhone: true },
  });

  return rows.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    matchedOn: computeMatchedOn(row, params),
  }));
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

export type LeadStatusHistoryRow = {
  id: string;
  previousStatus: LeadStatus | null;
  newStatus: LeadStatus;
  changedByUserId: string | null;
  changedByName: string | null;
  createdAt: Date;
};

const LEAD_STATUS_HISTORY_SELECT = {
  id: true,
  previousStatus: true,
  newStatus: true,
  changedByUserId: true,
  changedBy: { select: { name: true } },
  createdAt: true,
} as const;

/**
 * Paginated status-history read for a single Lead (D-023 §8). Authorization
 * (canAccessLead / assertLeadActor) is already decided by service.ts before
 * this is called — this function only fetches, exactly like findLeadById.
 * Ordered `createdAt desc, id desc`, matching every other list query in
 * this feature (listLeadsForActor). Deliberately excludes the transition
 * `reason` — LeadStatusHistory has no reason column (D-023 §8); the reason
 * lives only in sanitized AuditLog state, out of scope for this read.
 */
export async function listLeadStatusHistory(
  db: Prisma.TransactionClient,
  params: { leadId: string; skip: number; take: number },
): Promise<{ items: LeadStatusHistoryRow[]; total: number }> {
  const where = { leadId: params.leadId };

  const [rows, total] = await Promise.all([
    db.leadStatusHistory.findMany({
      where,
      select: LEAD_STATUS_HISTORY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: params.skip,
      take: params.take,
    }),
    db.leadStatusHistory.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      previousStatus: row.previousStatus,
      newStatus: row.newStatus,
      changedByUserId: row.changedByUserId,
      changedByName: row.changedBy?.name ?? null,
      createdAt: row.createdAt,
    })),
    total,
  };
}

// --- Lead-to-Client conversion (D-024 §4/§6/§7) ---
// Narrow, conversion-scoped primitives only — not a general Client
// repository. Client CRUD/management remains its own, later, unauthorized
// feature (D-024 §1); nothing here composes a transaction, creates an
// assignment or audit entry, or touches any downstream record — that
// composition is service.ts's job (D-024 §6), a later stage.

export type ClientSummary = { id: string; fullName: string };

const CLIENT_SUMMARY_SELECT = { id: true, fullName: true } as const;

export type CreateClientFromLeadInput = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  normalizedEmail: string | null;
  normalizedPhone: string | null;
};

/**
 * Creates a Client from a Lead's own data at conversion time (D-024 §4).
 * Copies exactly `fullName`/`email`/`phone`/`normalizedEmail`/
 * `normalizedPhone` — `Lead.notes` is deliberately absent from
 * `CreateClientFromLeadInput`'s type, so it can never be copied — and every
 * optional profile field (`notes`, `address`, `nationality`, `dateOfBirth`,
 * `emergencyContact`) is set explicitly to `null` here, never left to a
 * Prisma column default. Creates exactly one `Client` row and nothing
 * else: no assignment, no audit entry, no downstream record.
 */
export async function createClientFromLead(
  db: Prisma.TransactionClient,
  input: CreateClientFromLeadInput,
): Promise<ClientSummary> {
  return db.client.create({
    data: {
      id: input.id,
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      normalizedEmail: input.normalizedEmail,
      normalizedPhone: input.normalizedPhone,
      notes: null,
      address: null,
      nationality: null,
      dateOfBirth: null,
      emergencyContact: null,
    },
    select: CLIENT_SUMMARY_SELECT,
  });
}

/**
 * Reads a minimal Client summary by id (D-024 §7's idempotent-replay
 * response; D-024 §9's response shape) — deliberately not in
 * features/assignments/repository.ts, whose existing `findClientById`
 * selects only `{ id }` for its own, narrower assignment-target-existence
 * purpose. Returns `null` when the Client does not exist, unchanged.
 */
export async function findClientSummaryById(
  db: Prisma.TransactionClient,
  id: string,
): Promise<ClientSummary | null> {
  return db.client.findUnique({ where: { id }, select: CLIENT_SUMMARY_SELECT });
}

export type ConvertLeadWithHistoryInput = {
  id: string;
  clientId: string;
  changedByUserId: string;
};

/**
 * Performs the Lead-to-Client conversion write (D-024 §6): one nested
 * Prisma update setting `Lead.clientId`/`Lead.status` and creating the
 * corresponding `LeadStatusHistory` row, mirroring
 * `updateLeadStatusWithHistory`'s nested-write style exactly. Unlike that
 * function, `previousStatus`/`newStatus` are not caller-supplied —
 * D-024 §2/§6 authorize only the single `QUALIFIED` -> `CONVERTED_TO_CLIENT`
 * transition for this checkpoint, so both are hardcoded here rather than
 * accepted as parameters, closing off any possibility of this function ever
 * recording a different transition. Returns the existing assignment-free
 * `LeadRecord` shape via `LEAD_SELECT` — never `LeadRecordWithAssignment` —
 * matching D-024 §9's corrected response-shape requirement.
 */
export async function convertLeadWithHistory(
  db: Prisma.TransactionClient,
  input: ConvertLeadWithHistoryInput,
): Promise<LeadRecord> {
  return db.lead.update({
    where: { id: input.id },
    data: {
      clientId: input.clientId,
      status: LeadStatus.CONVERTED_TO_CLIENT,
      statusHistory: {
        create: {
          id: randomUUID(),
          previousStatus: LeadStatus.QUALIFIED,
          newStatus: LeadStatus.CONVERTED_TO_CLIENT,
          changedByUserId: input.changedByUserId,
        },
      },
    },
    select: LEAD_SELECT,
  });
}

export type LeadConversionAuditRow = {
  afterState: Prisma.JsonValue | null;
};

const LEAD_CONVERSION_AUDIT_SELECT = { afterState: true } as const;

/**
 * Reads the sanitized `LEAD_CONVERTED_TO_CLIENT` AuditLog entry for a Lead
 * (D-024 §7) — the sole persisted source the service layer validates an
 * idempotent conversion replay's `clientId`/`clientCreated` against, since
 * neither `Lead` nor `Client` itself records whether the original
 * conversion created or linked the Client. Not a general AuditLog reader:
 * scoped to exactly one `entityType`/`entityId`/`action` triple, reusing
 * `LEAD_AUDIT_ENTITY_TYPE`/`LEAD_AUDIT_ACTIONS.LEAD_CONVERTED_TO_CLIENT`
 * from features/leads/audit.ts (a safe, acyclic import — audit.ts imports
 * nothing itself) rather than duplicating those string literals here.
 * `findFirst` with deterministic `createdAt desc, id desc` ordering
 * (matching every other list query's tie-breaker discipline in this
 * feature) defensively picks the single most recent match — `AuditLog` has
 * no unique constraint preventing more than one such row, even though the
 * transaction that writes this entry (service.ts) never produces a second
 * one by construction, since the idempotency check it backs always
 * short-circuits before any write. Returns `null` when no such entry
 * exists, unchanged.
 */
export async function findLeadConversionAudit(
  db: Prisma.TransactionClient,
  leadId: string,
): Promise<LeadConversionAuditRow | null> {
  return db.auditLog.findFirst({
    where: {
      entityType: LEAD_AUDIT_ENTITY_TYPE,
      entityId: leadId,
      action: LEAD_AUDIT_ACTIONS.LEAD_CONVERTED_TO_CLIENT,
    },
    select: LEAD_CONVERSION_AUDIT_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}
