import { randomUUID } from 'node:crypto';

import { LeadStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { canAccessClient, canAccessLead } from '@/features/assignments/authorization';
import {
  ASSIGNMENT_AUDIT_ACTIONS,
  ASSIGNMENT_AUDIT_ENTITY_TYPE,
  sanitizeAssignmentSnapshot,
} from '@/features/assignments/audit';
import * as assignmentRepository from '@/features/assignments/repository';

import {
  LEAD_AUDIT_ACTIONS,
  LEAD_AUDIT_ENTITY_TYPE,
  sanitizeLeadCreatedSnapshot,
  sanitizeLeadStatusSnapshot,
  sanitizeLeadUpdateSnapshot,
} from './audit';
import { LeadError } from './errors';
import { normalizeEmail, normalizePhone } from './normalize';
import * as repository from './repository';
import type { LeadActor, LeadRecord, UpdateLeadFieldsInput } from './repository';
import type {
  CreateLeadInput,
  ListLeadsQuery,
  UpdateLeadInput,
  UpdateLeadStatusInput,
} from './schemas';
import { getTransitionOutcome, isReasonRequired } from './transitions';

/**
 * Defense-in-depth service-boundary authorization
 * (.claude/rules/backend.md "Authentication vs. Authorization"), mirroring
 * features/bookings/service.ts's `assertBookingActor` exactly. `withRole`
 * already gates every Lead route before its handler runs — this protects
 * the service boundary itself.
 */
function assertLeadActor(actor: AuthenticatedUser): LeadActor {
  if (actor.role === 'ADMIN_MANAGER' || actor.role === 'TRAVEL_CONSULTANT') {
    return { id: actor.id, role: actor.role };
  }
  throw new LeadError('ROLE_NOT_PERMITTED', 'This role is not permitted to manage leads.');
}

// P2034: a SERIALIZABLE conflict that survived every retry in
// runSerializableWithRetry. P2002/P2004: a database-level uniqueness/CHECK
// conflict this service did not anticipate — a defense-in-depth backstop,
// mirroring features/bookings/service.ts's `isOtherKnownConflict`.
function isKnownConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002' || error.code === 'P2004')
  );
}

function notFoundOrForbidden(leadActor: LeadActor): LeadError {
  return leadActor.role === 'ADMIN_MANAGER'
    ? new LeadError('LEAD_NOT_FOUND', 'Lead not found.')
    : new LeadError('LEAD_FORBIDDEN', 'Lead not found or not accessible.');
}

export type AuthorizedDuplicateMatch = {
  type: 'LEAD' | 'CLIENT';
  id: string;
  fullName: string;
  status?: LeadStatus;
  matchedOn: ('EMAIL' | 'PHONE')[];
};

export type DuplicateMatchResult = {
  duplicateMatches: AuthorizedDuplicateMatch[];
  restrictedMatchDetected: boolean;
};

/**
 * Runs duplicate detection and shapes visibility per D-022 §5 (approved
 * envelope, Stage B2 §2): every Lead-type candidate is checked with
 * `canAccessLead`, every Client-type candidate with `canAccessClient` —
 * never cross-applied. An authorized match is returned in full
 * (`type`/`id`/`fullName`/`status?`/`matchedOn`); every unauthorized match
 * collapses into a single `restrictedMatchDetected: true` flag that never
 * reveals the inaccessible record's id, name, status, type, or count.
 *
 * Always run against the live `prisma` singleton, never a transaction
 * client: `canAccessLead`/`canAccessClient` (features/assignments/
 * authorization.ts) call their own repository functions with the module
 * singleton directly and accept no transaction-client parameter, so this
 * step cannot be composed into the Lead-creation/edit transaction — it
 * always runs as an independent read, before that transaction opens.
 */
async function findDuplicateMatches(
  actor: AuthenticatedUser,
  params: { normalizedEmail?: string; normalizedPhone?: string; excludeLeadId?: string },
): Promise<DuplicateMatchResult> {
  if (!params.normalizedEmail && !params.normalizedPhone) {
    return { duplicateMatches: [], restrictedMatchDetected: false };
  }

  const [leadMatches, clientMatches] = await Promise.all([
    repository.findDuplicateLeadMatches(prisma, {
      normalizedEmail: params.normalizedEmail,
      normalizedPhone: params.normalizedPhone,
      excludeId: params.excludeLeadId,
    }),
    repository.findDuplicateClientMatches(prisma, {
      normalizedEmail: params.normalizedEmail,
      normalizedPhone: params.normalizedPhone,
    }),
  ]);

  const duplicateMatches: AuthorizedDuplicateMatch[] = [];
  let restrictedMatchDetected = false;

  for (const match of leadMatches) {
    const access = await canAccessLead(actor, match.id);
    if (access.allowed) {
      duplicateMatches.push({
        type: 'LEAD',
        id: match.id,
        fullName: match.fullName,
        status: match.status,
        matchedOn: match.matchedOn,
      });
    } else {
      restrictedMatchDetected = true;
    }
  }

  for (const match of clientMatches) {
    const access = await canAccessClient(actor, match.id);
    if (access.allowed) {
      duplicateMatches.push({
        type: 'CLIENT',
        id: match.id,
        fullName: match.fullName,
        matchedOn: match.matchedOn,
      });
    } else {
      restrictedMatchDetected = true;
    }
  }

  return { duplicateMatches, restrictedMatchDetected };
}

export type CreateLeadResult = { lead: LeadRecord } & DuplicateMatchResult;

/**
 * Creates a Lead (blueprint Section 6.8; D-022 §2/§3). Duplicate detection
 * runs *before* the Lead is inserted, against the submitted (not-yet-
 * persisted) contact values — the new row cannot appear in its own match
 * results by construction, so no id-based self-exclusion is needed or
 * possible here (D-022 §5 only specifies self-exclusion for edit-time,
 * where the row already exists).
 *
 * Creation itself (Lead + initial NEW LeadStatusHistory + LEAD_CREATED
 * audit, plus — for a TRAVEL_CONSULTANT creator — an atomic self-assignment
 * StaffAssignment row and its LEAD_ASSIGNED audit entry) is one plain
 * transaction, not `runSerializableWithRetry`: unlike Booking, Lead
 * creation has no natural-key uniqueness race to retry against (no
 * bookingReference/proposalVersionId-style contention), matching
 * features/staff/service.ts's `createStaffAccount`'s own plain-transaction
 * precedent. An ADMIN_MANAGER-created Lead is never auto-assigned (D-022
 * §2) — the existing `/api/leads/[id]/assignment` endpoint remains the only
 * way to assign one.
 */
export async function createLead(
  actor: AuthenticatedUser,
  input: CreateLeadInput,
): Promise<CreateLeadResult> {
  const leadActor = assertLeadActor(actor);

  const normalizedEmail = input.email ? normalizeEmail(input.email) : null;
  const normalizedPhone = input.phone ? normalizePhone(input.phone) : null;

  const duplicates = await findDuplicateMatches(actor, {
    normalizedEmail: normalizedEmail ?? undefined,
    normalizedPhone: normalizedPhone ?? undefined,
  });

  const leadId = randomUUID();

  const lead = await prisma.$transaction(async (tx) => {
    const created = await repository.createLeadWithInitialHistory(tx, {
      id: leadId,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      normalizedEmail,
      normalizedPhone,
      source: input.source,
      notes: input.notes ?? null,
      changedByUserId: leadActor.id,
    });

    await repository.insertAuditLog(tx, {
      actorId: leadActor.id,
      action: LEAD_AUDIT_ACTIONS.LEAD_CREATED,
      entityType: LEAD_AUDIT_ENTITY_TYPE,
      entityId: created.id,
      afterState: sanitizeLeadCreatedSnapshot(created),
    });

    if (leadActor.role === 'TRAVEL_CONSULTANT') {
      // Atomic creation-time self-assignment (D-022 §2) — reuses the
      // existing assignments repository/audit exports unchanged, never the
      // ADMIN_MANAGER-only `/api/leads/[id]/assignment` service path (that
      // path is for assigning/reassigning an *existing* Lead, not this
      // creation-time case).
      const assignment = await assignmentRepository.createAssignment(tx, {
        id: randomUUID(),
        assignedStaffId: leadActor.id,
        assignedByUserId: leadActor.id,
        leadId: created.id,
      });

      await assignmentRepository.insertAuditLog(tx, {
        actorId: leadActor.id,
        action: ASSIGNMENT_AUDIT_ACTIONS.LEAD_ASSIGNED,
        entityType: ASSIGNMENT_AUDIT_ENTITY_TYPE.LEAD,
        entityId: created.id,
        afterState: sanitizeAssignmentSnapshot(assignment),
      });
    }

    return created;
  });

  return { lead, ...duplicates };
}

/** Single-Lead read, authorized via the existing `canAccessLead` (D-022
 * §2/§8) — never a duplicated role/assignment check. */
export async function getLeadById(actor: AuthenticatedUser, id: string): Promise<LeadRecord> {
  const leadActor = assertLeadActor(actor);

  const access = await canAccessLead(actor, id);
  if (!access.allowed) {
    throw notFoundOrForbidden(leadActor);
  }

  const found = await repository.findLeadById(prisma, id);
  if (!found) {
    // Unreachable for TRAVEL_CONSULTANT: an active assignment (proven by
    // canAccessLead above) implies the Lead exists (StaffAssignment.leadId
    // is onDelete: Restrict). Reachable only for ADMIN_MANAGER, whose
    // canAccessLead branch never checks existence.
    throw notFoundOrForbidden(leadActor);
  }
  return found;
}

export type ListLeadsResult = {
  items: LeadRecord[];
  page: number;
  pageSize: number;
  total: number;
};

/** Paginated Lead list, scoped to what `actor` may see
 * (repository.ts's `listLeadsForActor` composes the scoping into the
 * query itself). */
export async function listLeads(
  actor: AuthenticatedUser,
  query: ListLeadsQuery,
): Promise<ListLeadsResult> {
  const leadActor = assertLeadActor(actor);

  const skip = (query.page - 1) * query.pageSize;
  const { items, total } = await repository.listLeadsForActor(prisma, leadActor, {
    skip,
    take: query.pageSize,
    status: query.status,
    source: query.source,
    search: query.search,
  });
  return { items, page: query.page, pageSize: query.pageSize, total };
}

export type UpdateLeadResult = { lead: LeadRecord } & Partial<DuplicateMatchResult>;

/**
 * Edits a Lead's ordinary fields (D-022 §3). Rejects outright once the
 * Lead is CONVERTED_TO_CLIENT (LEAD_LOCKED). Computes the patch's *final
 * combined* email/phone state — the existing value for any field absent
 * from the patch, the patch's own value (including an explicit `null`
 * clear) for any field present — and rejects a final state where both
 * would be absent (VALIDATION_ERROR), never validating presence from the
 * partial request alone. Duplicate detection reruns only when `email` or
 * `phone` is present in the patch (Stage B2 §6), using the final combined
 * normalized values and excluding this Lead's own id.
 */
export async function updateLead(
  actor: AuthenticatedUser,
  id: string,
  input: UpdateLeadInput,
): Promise<UpdateLeadResult> {
  const leadActor = assertLeadActor(actor);

  const access = await canAccessLead(actor, id);
  if (!access.allowed) {
    throw notFoundOrForbidden(leadActor);
  }

  const existing = await repository.findLeadById(prisma, id);
  if (!existing) {
    throw notFoundOrForbidden(leadActor);
  }

  if (existing.status === LeadStatus.CONVERTED_TO_CLIENT) {
    throw new LeadError(
      'LEAD_LOCKED',
      'This lead has been converted to a client and can no longer be edited.',
    );
  }

  const emailProvided = Object.hasOwn(input, 'email');
  const phoneProvided = Object.hasOwn(input, 'phone');

  const finalEmail = emailProvided ? (input.email ?? null) : existing.email;
  const finalPhone = phoneProvided ? (input.phone ?? null) : existing.phone;

  if (!finalEmail && !finalPhone) {
    throw new LeadError('VALIDATION_ERROR', 'A lead must retain at least one of email or phone.');
  }

  const changedFields: string[] = [];
  const data: Omit<UpdateLeadFieldsInput, 'id'> = {};

  if (Object.hasOwn(input, 'fullName') && input.fullName !== existing.fullName) {
    data.fullName = input.fullName;
    changedFields.push('fullName');
  }
  if (Object.hasOwn(input, 'source') && input.source !== existing.source) {
    data.source = input.source;
    changedFields.push('source');
  }
  if (Object.hasOwn(input, 'notes') && (input.notes ?? null) !== existing.notes) {
    data.notes = input.notes ?? null;
    changedFields.push('notes');
  }

  let normalizedEmail = existing.normalizedEmail;
  let normalizedPhone = existing.normalizedPhone;
  const contactProvided = emailProvided || phoneProvided;

  if (emailProvided && finalEmail !== existing.email) {
    data.email = finalEmail;
    normalizedEmail = finalEmail ? normalizeEmail(finalEmail) : null;
    data.normalizedEmail = normalizedEmail;
    changedFields.push('email');
  }
  if (phoneProvided && finalPhone !== existing.phone) {
    data.phone = finalPhone;
    normalizedPhone = finalPhone ? normalizePhone(finalPhone) : null;
    data.normalizedPhone = normalizedPhone;
    changedFields.push('phone');
  }

  const duplicates: DuplicateMatchResult | undefined = contactProvided
    ? await findDuplicateMatches(actor, {
        normalizedEmail: normalizedEmail ?? undefined,
        normalizedPhone: normalizedPhone ?? undefined,
        excludeLeadId: id,
      })
    : undefined;

  if (changedFields.length === 0) {
    return { lead: existing, ...duplicates };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await repository.updateLeadFields(tx, { id, ...data });

    await repository.insertAuditLog(tx, {
      actorId: leadActor.id,
      action: LEAD_AUDIT_ACTIONS.LEAD_UPDATED,
      entityType: LEAD_AUDIT_ENTITY_TYPE,
      entityId: id,
      afterState: sanitizeLeadUpdateSnapshot({
        changedFields,
        hasEmail: Boolean(finalEmail),
        hasPhone: Boolean(finalPhone),
      }),
    });

    return result;
  });

  return { lead: updated, ...duplicates };
}

const STALE_STATUS_MESSAGE =
  'This lead has changed since it was last loaded. Refresh and try again.';
const CONFLICT_MESSAGE =
  'This lead could not be updated because of a conflicting update. Please try again.';

/**
 * Transitions a Lead's status (D-022 §6/§7). Execution order, matching
 * Stage B2 §8 exactly: (1) authorize via `canAccessLead`; (2) read current
 * status inside the transaction; (3) same-status is an idempotent no-op,
 * checked *before* `expectedStatus`, so a stale `expectedStatus` still
 * succeeds if the Lead already reflects the desired outcome; (4) otherwise
 * a mismatched `expectedStatus` is LEAD_CONFLICT; (5) the transition itself
 * is validated against transitions.ts (DEFERRED -> CONVERSION_ENDPOINT_
 * REQUIRED, REJECTED -> INVALID_STATUS_TRANSITION); (6) a required-but-
 * missing reason is REASON_REQUIRED; (7) only then is the real transition
 * performed, atomically, inside `runSerializableWithRetry` — mirroring
 * features/bookings/service.ts's `updateBookingStatus` (D-014) exactly.
 */
export async function updateLeadStatus(
  actor: AuthenticatedUser,
  id: string,
  input: UpdateLeadStatusInput,
): Promise<LeadRecord> {
  const leadActor = assertLeadActor(actor);

  const access = await canAccessLead(actor, id);
  if (!access.allowed) {
    throw notFoundOrForbidden(leadActor);
  }

  try {
    return await runSerializableWithRetry(async (tx) => {
      const found = await repository.findLeadById(tx, id);
      if (!found) {
        throw notFoundOrForbidden(leadActor);
      }

      if (found.status === input.newStatus) {
        return found;
      }

      if (found.status !== input.expectedStatus) {
        throw new LeadError('LEAD_CONFLICT', STALE_STATUS_MESSAGE);
      }

      const outcome = getTransitionOutcome(found.status, input.newStatus);
      if (outcome === 'DEFERRED_TO_CONVERSION_ENDPOINT') {
        throw new LeadError(
          'CONVERSION_ENDPOINT_REQUIRED',
          'Converting a lead to a client requires the dedicated conversion workflow, not the generic status endpoint.',
        );
      }
      if (outcome === 'REJECTED') {
        throw new LeadError(
          'INVALID_STATUS_TRANSITION',
          `Cannot transition a lead from ${found.status} to ${input.newStatus}.`,
        );
      }

      if (isReasonRequired(found.status, input.newStatus) && !input.reason) {
        throw new LeadError('REASON_REQUIRED', 'A reason is required for this transition.');
      }

      const updated = await repository.updateLeadStatusWithHistory(tx, {
        id,
        previousStatus: found.status,
        newStatus: input.newStatus,
        changedByUserId: leadActor.id,
      });

      await repository.insertAuditLog(tx, {
        actorId: leadActor.id,
        action: LEAD_AUDIT_ACTIONS.LEAD_STATUS_CHANGED,
        entityType: LEAD_AUDIT_ENTITY_TYPE,
        entityId: id,
        beforeState: sanitizeLeadStatusSnapshot(found.status),
        afterState: sanitizeLeadStatusSnapshot(updated.status, input.reason),
      });

      return updated;
    });
  } catch (error) {
    if (error instanceof LeadError) {
      throw error;
    }
    if (isKnownConflict(error)) {
      throw new LeadError('LEAD_CONFLICT', CONFLICT_MESSAGE);
    }
    throw error;
  }
}
