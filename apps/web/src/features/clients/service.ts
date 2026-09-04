import { Prisma, type LeadStatus } from '@/generated/prisma/client';
import { normalizeEmail, normalizePhone } from '@/lib/contact-normalization';
import { prisma } from '@/lib/db';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { canAccessClient, canAccessLead } from '@/features/assignments/authorization';
import * as assignmentRepository from '@/features/assignments/repository';

import {
  CLIENT_AUDIT_ACTIONS,
  CLIENT_AUDIT_ENTITY_TYPE,
  sanitizeClientUpdateSnapshot,
} from './audit';
import { ClientError } from './errors';
import * as repository from './repository';
import type {
  ClientActor,
  ClientDetailRecord,
  ClientListItem,
  UpdateClientFieldsInput,
} from './repository';
import type { ListClientsQuery, UpdateClientInput } from './schemas';

/**
 * Defense-in-depth service-boundary authorization
 * (.claude/rules/backend.md "Authentication vs. Authorization"), mirroring
 * features/leads/service.ts's `assertLeadActor` exactly. No route guard
 * exists yet for `/api/clients/**` (a later stage) — this is, for now, the
 * *only* authorization boundary this feature has, so it must reject every
 * role beyond the two D-025 §2 authorizes on its own, independent of
 * whatever route-level gate is added later.
 */
function assertClientActor(actor: AuthenticatedUser): ClientActor {
  if (actor.role === 'ADMIN_MANAGER' || actor.role === 'TRAVEL_CONSULTANT') {
    return { id: actor.id, role: actor.role };
  }
  throw new ClientError('ROLE_NOT_PERMITTED', 'This role is not permitted to manage clients.');
}

/**
 * D-025 §7/§9's exact role-aware anti-enumeration split: for `ADMIN_MANAGER`
 * (unconditional access), a missing Client is unambiguously `CLIENT_NOT_FOUND`
 * (404); for `TRAVEL_CONSULTANT` (access conditional on an active
 * assignment), "does not exist" and "exists but not assigned to this actor"
 * are indistinguishable and must both produce the identical
 * `CLIENT_FORBIDDEN` (403) — mirrors features/leads/service.ts's
 * `notFoundOrForbidden` exactly.
 */
function notFoundOrForbidden(clientActor: ClientActor): ClientError {
  return clientActor.role === 'ADMIN_MANAGER'
    ? new ClientError('CLIENT_NOT_FOUND', 'Client not found.')
    : new ClientError('CLIENT_FORBIDDEN', 'You do not have access to this client.');
}

// P2034: a SERIALIZABLE conflict that survived every retry in
// runSerializableWithRetry (D-031 F-01 — updateClient's own transaction was
// previously a plain, non-retrying prisma.$transaction, so this conflict
// code was never reachable here before). P2002/P2004: a database-level
// uniqueness/CHECK conflict this service did not anticipate — a
// defense-in-depth backstop, mirroring features/leads/service.ts's and
// features/bookings/service.ts's identical `isKnownConflict`/
// `isOtherKnownConflict` precedent.
function isKnownConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002' || error.code === 'P2004')
  );
}

// D-025 §6's exact, closed duplicate-match shape — deliberately this
// feature's own local type, not imported from features/leads/service.ts's
// identically-shaped `AuthorizedDuplicateMatch`/`DuplicateMatchResult`:
// D-025 §6 reuses D-022 §5's *behavior* (the same allow-listed fields and
// visibility-shaping rule), not a literal cross-feature type import — each
// feature's service layer, like its repository layer, stays self-contained
// (.claude/rules/architecture.md's cross-feature-reuse discipline).
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
 * Runs Client-edit duplicate detection and shapes visibility per D-025 §6
 * (reusing D-022 §5's approved envelope unchanged): every Client-type
 * candidate is checked with `canAccessClient`, every Lead-type candidate
 * with `canAccessLead` — never cross-applied. An authorized match is
 * returned in full (`type`/`id`/`fullName`/`status?`/`matchedOn`); every
 * unauthorized match collapses into a single `restrictedMatchDetected: true`
 * flag that never reveals the inaccessible record's id, name, status, type,
 * or count. The Client's own originating Lead(s) are already excluded by
 * `repository.findDuplicateLeadMatches`'s own self-exclusion (D-025 §6's
 * corrected rule) — they are never fetched here at all, so they can never
 * be surfaced or collapsed into `restrictedMatchDetected` either.
 *
 * Always runs against the live `prisma` singleton, never a transaction
 * client: `canAccessClient`/`canAccessLead` call their own repository
 * functions with the module singleton directly and accept no
 * transaction-client parameter, so this step cannot be composed into the
 * Client-edit transaction — it always runs as an independent read.
 */
async function findDuplicateMatchesForClient(
  actor: AuthenticatedUser,
  params: { normalizedEmail?: string; normalizedPhone?: string; excludeClientId: string },
): Promise<DuplicateMatchResult> {
  if (!params.normalizedEmail && !params.normalizedPhone) {
    return { duplicateMatches: [], restrictedMatchDetected: false };
  }

  const [clientMatches, leadMatches] = await Promise.all([
    repository.findDuplicateClientMatches(prisma, {
      normalizedEmail: params.normalizedEmail,
      normalizedPhone: params.normalizedPhone,
      excludeClientId: params.excludeClientId,
    }),
    repository.findDuplicateLeadMatches(prisma, {
      normalizedEmail: params.normalizedEmail,
      normalizedPhone: params.normalizedPhone,
      excludeClientId: params.excludeClientId,
    }),
  ]);

  const duplicateMatches: AuthorizedDuplicateMatch[] = [];
  let restrictedMatchDetected = false;

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

  return { duplicateMatches, restrictedMatchDetected };
}

export type ListClientsResult = {
  items: ClientListItem[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * Paginated Client list, scoped to what `actor` may see (D-025 §2/§3).
 * `repository.listClientsForActor` composes the assignment scoping directly
 * into the query itself — this function never calls `canAccessClient` per
 * row (that would mean fetching unscoped rows first, exactly what
 * .claude/rules/admin-dashboard.md's Visibility Scoping rule forbids).
 */
export async function listClients(
  actor: AuthenticatedUser,
  query: ListClientsQuery,
): Promise<ListClientsResult> {
  const clientActor = assertClientActor(actor);

  const skip = (query.page - 1) * query.pageSize;
  const { items, total } = await repository.listClientsForActor(prisma, clientActor, {
    skip,
    take: query.pageSize,
    search: query.search,
  });
  return { items, page: query.page, pageSize: query.pageSize, total };
}

/**
 * Single-Client read, authorized via the existing `canAccessClient`
 * (D-025 §2/§4) — never a duplicated role/assignment check. Uses
 * `repository.findClientByIdForRead` (not `findClientById`), so the
 * response carries `assignment` and the actor-scoped `originatingLeads`,
 * with `dateOfBirth` already reduced to a bare `YYYY-MM-DD` string by the
 * repository layer. Never returns the mutation-only `ClientRecord` shape or
 * any normalized contact field.
 */
export async function getClientById(
  actor: AuthenticatedUser,
  id: string,
): Promise<ClientDetailRecord> {
  const clientActor = assertClientActor(actor);

  const access = await canAccessClient(actor, id);
  if (!access.allowed) {
    throw notFoundOrForbidden(clientActor);
  }

  const found = await repository.findClientByIdForRead(prisma, id, clientActor);
  if (!found) {
    // Unreachable for TRAVEL_CONSULTANT: an active assignment (proven by
    // canAccessClient above) implies the Client exists (StaffAssignment's
    // clientId is onDelete: Restrict). Reachable only for ADMIN_MANAGER,
    // whose canAccessClient branch never checks existence.
    throw notFoundOrForbidden(clientActor);
  }
  return found;
}

export type UpdateClientResult = { client: ClientDetailRecord } & Partial<DuplicateMatchResult>;

const CONFLICT_MESSAGE = 'This client has changed since it was last loaded. Refresh and try again.';
const CONTACT_INVARIANT_MESSAGE = 'A client must retain at least one of email or phone.';

/**
 * Edits a Client's ordinary fields (D-025 §5/§7). Authorization happens in
 * two tiers: `canAccessClient` gates access *before* the transaction opens
 * (it cannot run inside a transaction client); for a `TRAVEL_CONSULTANT`
 * actor, the active Client assignment is *rechecked* transaction-locally, as
 * the very first operation inside the transaction — before any authoritative
 * Client state is read or acted upon and before any success or write is
 * returned (D-025 §2/§7, mirroring D-024 §6(b)'s identical
 * transaction-local-recheck precedent) — closing the race window between
 * the pre-transaction check and the actual write. `ADMIN_MANAGER` performs
 * no such recheck, remaining unconditionally authorized once the Client's
 * existence is confirmed. D-031 F-01 extends this same recheck's protection
 * to a second race window — an assignment change landing after the recheck
 * succeeds but before this transaction's own write commits — by moving the
 * whole transaction under SERIALIZABLE isolation (see below).
 *
 * The mutation runs inside `runSerializableWithRetry` (D-031 F-01): the
 * transaction-local `TRAVEL_CONSULTANT` assignment recheck above must be
 * re-evaluated fresh on every attempt (the whole callback re-runs fresh
 * each attempt — lib/serializable-transaction.ts) so that a concurrent
 * Admin/Manager reassignment landing after that recheck succeeds but before
 * this transaction's own write commits is detected as a genuine PostgreSQL
 * serialization conflict, not silently missed — SERIALIZABLE isolation is
 * what makes that detection possible, which a plain transaction cannot
 * provide. The Client row's own `expectedUpdatedAt` staleness comparison
 * remains additionally embedded in
 * `repository.updateClientFieldsIfUnstale`'s atomic update predicate
 * (`WHERE id AND updatedAt`), unchanged — that check never depended on the
 * elevated isolation level, and running under it does not weaken it. A
 * retry whose own recheck observes the assignment lost or reassigned throws
 * the existing `CLIENT_FORBIDDEN`; a `P2034` conflict that survives every
 * bounded attempt is caught below and mapped to the existing
 * `CLIENT_CONFLICT`, mirroring features/leads/service.ts's
 * `updateLeadStatus`/`convertLead` `isKnownConflict` pattern exactly — never
 * a forbidden result, and never a raw Prisma error.
 *
 * Computes the patch's *final combined* email/phone state — the existing
 * value for any field absent from the patch, the patch's own value
 * (including an explicit `null` clear) for any field present — and rejects
 * a final state where both would be absent (`VALIDATION_ERROR`), never
 * validating presence from the partial request alone. Field-change
 * detection runs in D-025's contracted order (`fullName`, `email`, `phone`,
 * `address`, `nationality`, `dateOfBirth`, `emergencyContact`, `notes`);
 * `dateOfBirth` is compared by timestamp value (`getTime()`), never by
 * `Date` object identity. Duplicate detection reruns whenever `email` or
 * `phone` is present in the patch — even when the final combined value is
 * unchanged — using the final combined normalized values, always excluding
 * this Client's own id.
 *
 * `expectedUpdatedAt` is verified against the Client's actual stored
 * `updatedAt` immediately after the authoritative row is read — before the
 * combined email/phone invariant, field-change detection, duplicate
 * querying, no-op handling, the conditional write, or any audit work (D-025
 * §7's required order); an already-stale token is rejected there,
 * uniformly, whether the request would otherwise be a no-op or a genuine
 * change. `repository.updateClientFieldsIfUnstale`'s atomic update
 * predicate (`WHERE id AND updatedAt`) still carries `expectedUpdatedAt`
 * unchanged — that second check is not redundant, since it also catches a
 * write that races in *after* this initial read, later in the same
 * transaction, which the initial comparison cannot see.
 *
 * A request whose change detection finds nothing to write is a permitted
 * no-op: duplicate detection still runs and its result pair is still
 * returned when contact was supplied, and — on success — no `updateMany`
 * call and no `AuditLog` insert occur.
 */
export async function updateClient(
  actor: AuthenticatedUser,
  id: string,
  input: UpdateClientInput,
): Promise<UpdateClientResult> {
  const clientActor = assertClientActor(actor);

  const access = await canAccessClient(actor, id);
  if (!access.allowed) {
    throw notFoundOrForbidden(clientActor);
  }

  const expectedUpdatedAt = new Date(input.expectedUpdatedAt);

  try {
    return await runSerializableWithRetry(async (tx) => {
      if (clientActor.role === 'TRAVEL_CONSULTANT') {
        const activeAssignment = await assignmentRepository.findActiveAssignmentForClient(tx, id);
        if (!activeAssignment || activeAssignment.assignedStaffId !== clientActor.id) {
          throw notFoundOrForbidden(clientActor);
        }
      }

      const existing = await repository.findClientById(tx, id);
      if (!existing) {
        throw notFoundOrForbidden(clientActor);
      }

      if (existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        throw new ClientError('CLIENT_CONFLICT', CONFLICT_MESSAGE);
      }

      const emailProvided = Object.hasOwn(input, 'email');
      const phoneProvided = Object.hasOwn(input, 'phone');

      const finalEmail = emailProvided ? (input.email ?? null) : existing.email;
      const finalPhone = phoneProvided ? (input.phone ?? null) : existing.phone;

      if (!finalEmail && !finalPhone) {
        throw new ClientError('VALIDATION_ERROR', CONTACT_INVARIANT_MESSAGE);
      }

      const changedFields: string[] = [];
      const data: Omit<UpdateClientFieldsInput, 'id' | 'expectedUpdatedAt'> = {};

      if (Object.hasOwn(input, 'fullName') && input.fullName !== existing.fullName) {
        data.fullName = input.fullName;
        changedFields.push('fullName');
      }

      let normalizedEmail = existing.normalizedEmail;
      if (emailProvided && finalEmail !== existing.email) {
        data.email = finalEmail;
        normalizedEmail = finalEmail ? normalizeEmail(finalEmail) : null;
        data.normalizedEmail = normalizedEmail;
        changedFields.push('email');
      }

      let normalizedPhone = existing.normalizedPhone;
      if (phoneProvided && finalPhone !== existing.phone) {
        data.phone = finalPhone;
        normalizedPhone = finalPhone ? normalizePhone(finalPhone) : null;
        data.normalizedPhone = normalizedPhone;
        changedFields.push('phone');
      }

      if (Object.hasOwn(input, 'address') && (input.address ?? null) !== existing.address) {
        data.address = input.address ?? null;
        changedFields.push('address');
      }
      if (
        Object.hasOwn(input, 'nationality') &&
        (input.nationality ?? null) !== existing.nationality
      ) {
        data.nationality = input.nationality ?? null;
        changedFields.push('nationality');
      }
      // `input.dateOfBirth !== undefined` is a defensive second condition,
      // alongside `Object.hasOwn`: after schemas.ts's Stage C correction,
      // `dateOfBirth` is a genuinely optional key whose transform only ever
      // produces `Date | null` — but should a caller-constructed input ever
      // carry the key with an explicit `undefined` value, that must still be
      // treated as "not provided," never as a clear. Only `null` is an
      // explicit clear after schema parsing.
      if (
        Object.hasOwn(input, 'dateOfBirth') &&
        input.dateOfBirth !== undefined &&
        (input.dateOfBirth?.getTime() ?? null) !== (existing.dateOfBirth?.getTime() ?? null)
      ) {
        data.dateOfBirth = input.dateOfBirth ?? null;
        changedFields.push('dateOfBirth');
      }
      if (
        Object.hasOwn(input, 'emergencyContact') &&
        (input.emergencyContact ?? null) !== existing.emergencyContact
      ) {
        data.emergencyContact = input.emergencyContact ?? null;
        changedFields.push('emergencyContact');
      }
      if (Object.hasOwn(input, 'notes') && (input.notes ?? null) !== existing.notes) {
        data.notes = input.notes ?? null;
        changedFields.push('notes');
      }

      const contactProvided = emailProvided || phoneProvided;
      const duplicates: DuplicateMatchResult | undefined = contactProvided
        ? await findDuplicateMatchesForClient(actor, {
            normalizedEmail: normalizedEmail ?? undefined,
            normalizedPhone: normalizedPhone ?? undefined,
            excludeClientId: id,
          })
        : undefined;

      if (changedFields.length === 0) {
        const currentDetail = await repository.findClientByIdForRead(tx, id, clientActor);
        if (!currentDetail) {
          throw notFoundOrForbidden(clientActor);
        }
        return { client: currentDetail, ...duplicates };
      }

      const { count } = await repository.updateClientFieldsIfUnstale(tx, {
        id,
        expectedUpdatedAt,
        ...data,
      });

      if (count === 0) {
        const stillExists = await repository.findClientById(tx, id);
        if (!stillExists) {
          throw notFoundOrForbidden(clientActor);
        }
        throw new ClientError('CLIENT_CONFLICT', CONFLICT_MESSAGE);
      }

      // Re-read the authoritative persisted result *before* auditing (D-025
      // §7's required order) — the audit entry is only ever written once we
      // know, from a real read, that the Client this entry describes still
      // exists and is readable; it is never written speculatively ahead of
      // that confirmation.
      const updatedDetail = await repository.findClientByIdForRead(tx, id, clientActor);
      if (!updatedDetail) {
        throw notFoundOrForbidden(clientActor);
      }

      await repository.insertAuditLog(tx, {
        actorId: clientActor.id,
        action: CLIENT_AUDIT_ACTIONS.CLIENT_UPDATED,
        entityType: CLIENT_AUDIT_ENTITY_TYPE,
        entityId: id,
        afterState: sanitizeClientUpdateSnapshot({
          changedFields,
          hasEmail: Boolean(finalEmail),
          hasPhone: Boolean(finalPhone),
        }),
      });

      return { client: updatedDetail, ...duplicates };
    });
  } catch (error) {
    if (error instanceof ClientError) {
      throw error;
    }
    if (isKnownConflict(error)) {
      throw new ClientError('CLIENT_CONFLICT', CONFLICT_MESSAGE);
    }
    throw error;
  }
}

// --- Client-portal owned-client resolution (docs/HERITAGE_V3_DECISIONS_LOG.md
// D-040 §§2, 3 Contract A) ---
// The inverse of `assertClientActor` above: this path is CLIENT-only. It
// resolves the owned Client EXCLUSIVELY from `actor.id` (via
// `ClientProfile.userId`), accepts no `clientId` from any caller, and —
// unlike every other client-facing read — deliberately does NOT call
// `canAccessClient`: its whole job is to *produce* the owned `clientId`
// that the other contracts (B-F) then re-check with `canAccessClient`
// (D-040 §2). A non-CLIENT actor never reaches here through the overview
// composition (which checks the role first), but this independent gate
// protects the service boundary for a direct or mis-wired caller.

function assertClientPortalActor(actor: AuthenticatedUser): { id: string } {
  if (actor.role === 'CLIENT') {
    return { id: actor.id };
  }
  throw new ClientError(
    'ROLE_NOT_PERMITTED',
    'This role is not permitted to access a client portal profile.',
  );
}

/**
 * The identity of the Client the authenticated portal user owns, or `null`
 * when their account is not fully set up yet (no `ClientProfile` row —
 * D-040 §7's "account setup in progress" state). Derived only from
 * `actor.id`; never learns, and never lets a caller supply, a `clientId`.
 */
export async function getOwnClientForUser(
  actor: AuthenticatedUser,
): Promise<repository.OwnedClientIdentity | null> {
  assertClientPortalActor(actor);
  return repository.findOwnedClientForUser(prisma, actor.id);
}
