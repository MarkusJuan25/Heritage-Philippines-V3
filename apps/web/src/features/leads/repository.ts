import { randomUUID } from 'node:crypto';

import { LeadStatus, type Prisma } from '@/generated/prisma/client';

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

/** Plain, unscoped single-Lead fetch — the actor-authorization decision has
 * already been made by `canAccessLead` before this is called (service.ts). */
export async function findLeadById(
  db: Prisma.TransactionClient,
  id: string,
): Promise<LeadRecord | null> {
  return db.lead.findUnique({ where: { id }, select: LEAD_SELECT });
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
): Promise<{ items: LeadRecord[]; total: number }> {
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
      select: LEAD_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: params.skip,
      take: params.take,
    }),
    db.lead.count({ where }),
  ]);

  return { items, total };
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
