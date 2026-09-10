import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { Prisma, ProposalResponseType } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import { runSerializableWithRetry } from '@/lib/serializable-transaction';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { canAccessClient } from '@/features/assignments/authorization';
import * as assignmentRepository from '@/features/assignments/repository';
import { findClientProfileIdentityForUser } from '@/features/clients/repository';
import { getOwnClientForUser } from '@/features/clients/service';

import {
  PROPOSAL_AUDIT_ACTIONS,
  PROPOSAL_AUDIT_ENTITY_TYPE,
  sanitizeProposalCreatedSnapshot,
  sanitizeProposalResponseRecordedSnapshot,
  sanitizeProposalVersionCreatedSnapshot,
  sanitizeProposalVersionPublishedSnapshot,
} from './audit';
import { ProposalError, type ProposalErrorCode } from './errors';
import * as repository from './repository';
import type {
  ClientProposalReviewRow,
  ProposalAcceptanceRecord,
  ProposalActor,
  ProposalDetailRecord,
  ProposalListItem,
  ProposalRecord,
  ProposalVersionActorContext,
  ProposalVersionRecord,
} from './repository';
import type {
  CreateProposalInput,
  CreateProposalRevisionInput,
  ListProposalsQuery,
  PublishProposalVersionInput,
  RecordProposalResponseInput,
} from './schemas';

// The Proposal / ROS service layer (D-027) — authorization, transaction
// ownership, concurrency, audit orchestration, and controlled-error
// shaping. Never calls a Prisma model delegate directly: every
// Proposal/ProposalVersion/ProposalAcceptance/AuditLog database operation
// goes through repository.ts; the only assignment-feature primitive used
// directly is the existing, unchanged
// `assignmentRepository.findActiveAssignmentForClient` D-027 §3 requires.
// Never validates raw request bodies — Stage 2's schemas.ts owns that at
// the route boundary; every input here is already parsed.

// --- Controlled error messages, reused across call sites (mirrors
// features/bookings/service.ts's CONFLICT_MESSAGE/STALE_STATUS_MESSAGE
// convention) ---

const CLIENT_FORBIDDEN_MESSAGE = 'You do not have access to this client.';
const PROPOSAL_NOT_FOUND_MESSAGE = 'Proposal not found.';
const PROPOSAL_FORBIDDEN_MESSAGE = 'Proposal not found or not accessible.';
const PROPOSAL_VERSION_NOT_FOUND_MESSAGE = 'Proposal version not found.';
const PROPOSAL_VERSION_FORBIDDEN_MESSAGE = 'Proposal version not found or not accessible.';
const PROPOSAL_VERSION_SUPERSEDED_MESSAGE =
  'This proposal version has already been superseded by a later revision.';
const PROPOSAL_VERSION_NOT_CURRENT_MESSAGE =
  'A response can only be recorded for the current client-visible version of this proposal.';
const PROPOSAL_RESPONSE_ALREADY_RECORDED_MESSAGE =
  'A response has already been recorded for this proposal version.';
const PROPOSAL_CONFLICT_MESSAGE =
  'This proposal could not be completed because of a conflicting update. Please try again.';
// D-047 §9 — the acknowledgement checkbox and a valid response type are
// both re-validated server-side; a missing/false value is VALIDATION_ERROR.
const PROPOSAL_RESPONSE_VALIDATION_MESSAGE =
  'A valid response type and the final-response acknowledgement are both required.';
// D-027 §5's exact required wording — never paraphrased.
const PUBLISH_CONFLICT_MESSAGE =
  'The current version has changed since you last loaded this proposal. Refresh and try again.';

// --- Role assertions (D-027 §3's two distinct capability sets) ---

/**
 * Viewer/response actor: `ADMIN_MANAGER` and `TRAVEL_CONSULTANT` only
 * (D-027 §3 — list, detail, and Section 9.1 response-recording).
 * Defense-in-depth (.claude/rules/backend.md's "Authentication vs.
 * Authorization"): the future route layer's own `withRole` gate is not
 * this function's replacement — this protects the service boundary itself,
 * mirroring features/bookings/service.ts's `assertBookingActor` exactly.
 */
function assertProposalViewerActor(actor: AuthenticatedUser): ProposalActor {
  if (actor.role === 'ADMIN_MANAGER' || actor.role === 'TRAVEL_CONSULTANT') {
    return { id: actor.id, role: actor.role };
  }
  throw new ProposalError('ROLE_NOT_PERMITTED', 'This role is not permitted to view proposals.');
}

/**
 * Author actor: `TRAVEL_CONSULTANT` only (D-027 §3 — create, revise,
 * publish). `ADMIN_MANAGER` is rejected here exactly like every other
 * unsupported role — D-027 §3's asymmetric rule ("may not create a
 * Proposal, create a revision, or publish a version") is enforced by this
 * function returning `ROLE_NOT_PERMITTED` for it, before any repository,
 * authorization, assignment, or transaction call, satisfying D-027 §6's
 * route-level `withRole(['TRAVEL_CONSULTANT'])` gate with an independent
 * service-layer check.
 */
function assertProposalAuthorActor(actor: AuthenticatedUser): {
  id: string;
  role: 'TRAVEL_CONSULTANT';
} {
  if (actor.role === 'TRAVEL_CONSULTANT') {
    return { id: actor.id, role: 'TRAVEL_CONSULTANT' };
  }
  throw new ProposalError(
    'ROLE_NOT_PERMITTED',
    'This role is not permitted to author or publish proposals.',
  );
}

// --- Anti-enumeration NOT_FOUND/FORBIDDEN split (D-027 §3/§6) ---

function proposalNotFoundOrForbidden(actor: ProposalActor): ProposalError {
  return actor.role === 'ADMIN_MANAGER'
    ? new ProposalError('PROPOSAL_NOT_FOUND', PROPOSAL_NOT_FOUND_MESSAGE)
    : new ProposalError('PROPOSAL_FORBIDDEN', PROPOSAL_FORBIDDEN_MESSAGE);
}

function proposalVersionNotFoundOrForbidden(actor: ProposalActor): ProposalError {
  return actor.role === 'ADMIN_MANAGER'
    ? new ProposalError('PROPOSAL_VERSION_NOT_FOUND', PROPOSAL_VERSION_NOT_FOUND_MESSAGE)
    : new ProposalError('PROPOSAL_VERSION_FORBIDDEN', PROPOSAL_VERSION_FORBIDDEN_MESSAGE);
}

// --- Author-access assignment check (D-027 §3's feature-local
// assertProposalAuthorAccess) ---

/**
 * D-027 §3's author-access check: the actor must be `TRAVEL_CONSULTANT`
 * (the caller narrows this before ever calling here — this function itself
 * only compares an already-known actor id against the target Client's
 * active assignment) and must hold the Client's current active assignment
 * — `assignmentRepository.findActiveAssignmentForClient`, the exact same
 * underlying primitive `canAccessClient` itself calls (D-027 §3: "reused
 * directly rather than duplicated"). Never modifies or duplicates
 * features/assignments authorization logic.
 *
 * Accepts `db: Prisma.TransactionClient` so the identical function runs
 * both pre-transaction (called with `prisma`) and transaction-locally
 * (called with `tx`, immediately before the write it gates) — D-027 §3's
 * required transaction-local recheck, mirroring D-024 §6(b)'s/D-025 §7's
 * already-shipped precedent exactly, since the actor's assignment could
 * change between the pre-transaction check and the write.
 *
 * `deniedCode`/`deniedMessage` let each calling workflow select the
 * resource-appropriate controlled error — `CLIENT_FORBIDDEN` for
 * first-Proposal creation, `PROPOSAL_FORBIDDEN` for revision creation,
 * `PROPOSAL_VERSION_FORBIDDEN` for publishing/response-recording — rather
 * than this shared helper hard-coding one.
 */
async function assertProposalAuthorAccess(
  db: Prisma.TransactionClient,
  actorId: string,
  clientId: string,
  deniedCode: 'CLIENT_FORBIDDEN' | 'PROPOSAL_FORBIDDEN' | 'PROPOSAL_VERSION_FORBIDDEN',
  deniedMessage: string,
): Promise<void> {
  const active = await assignmentRepository.findActiveAssignmentForClient(db, clientId);
  if (!active || active.assignedStaffId !== actorId) {
    throw new ProposalError(deniedCode, deniedMessage);
  }
}

// --- Conflict helpers (Section 10; mirrors
// features/bookings/service.ts's identical uniqueConstraintTarget/
// isUniqueConflictOn/isOtherKnownConflict trio exactly) ---

function uniqueConstraintTarget(error: Prisma.PrismaClientKnownRequestError): string {
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.join(',');
  return typeof target === 'string' ? target : '';
}

/**
 * True when `error` is a P2002 whose target names every one of `fields` —
 * a single field for a simple unique constraint (e.g. `proposalVersionId`
 * on `ProposalAcceptance`), or every field of a composite constraint (e.g.
 * both `proposalId` and `versionNumber` for `ProposalVersion`'s
 * `@@unique([proposalId, versionNumber])`). `.includes` (not exact
 * equality) mirrors `isUniqueConflictOn`'s established precedent, since a
 * driver-reported target may be either a joined field-name array or a raw
 * constraint-name string that still embeds each field name as a substring.
 */
function isUniqueConflictOn(error: unknown, ...fields: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = uniqueConstraintTarget(error);
  return fields.every((field) => target.includes(field));
}

// P2034: a SERIALIZABLE conflict that survived every retry in
// runSerializableWithRetry. P2002 (unmatched by a specific
// isUniqueConflictOn check above)/P2004: the database's own unique
// indexes/CHECK constraints (proposal_version_current_client_visible_key,
// proposal_version_content_nonblank, proposal_acceptance_response_path)
// rejecting a write for a reason this service did not anticipate — a
// defense-in-depth backstop, mirroring
// features/bookings/service.ts's/features/assignments/service.ts's
// identical `isOtherKnownConflict`/`isKnownConflict`.
function isOtherKnownConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002' || error.code === 'P2004')
  );
}

// --- List (D-027 §3/§6's GET /api/proposals) ---

export type ListProposalsResult = {
  items: ProposalListItem[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * Paginated, actor-scoped Proposal list. Never opens a transaction (a
 * read-only, single-query operation) and never calls `canAccessClient` per
 * row — `repository.listProposalsForActor` composes the assignment scoping
 * directly into the query itself.
 */
export async function listProposals(
  actor: AuthenticatedUser,
  query: ListProposalsQuery,
): Promise<ListProposalsResult> {
  const proposalActor = assertProposalViewerActor(actor);

  const skip = (query.page - 1) * query.pageSize;
  const { items, total } = await repository.listProposalsForActor(prisma, proposalActor, {
    skip,
    take: query.pageSize,
  });
  return { items, page: query.page, pageSize: query.pageSize, total };
}

// --- Detail (D-027 §3/§6's GET /api/proposals/[id]) ---

/**
 * Single-Proposal detail read. Never opens a transaction. Resolves the
 * narrow, unscoped `findProposalContext` first to obtain `clientId` for
 * `canAccessClient` — a genuinely missing Proposal is reported here via
 * the role-aware NOT_FOUND/FORBIDDEN split, before `canAccessClient` is
 * even called. `canAccessClient` denial is always `PROPOSAL_FORBIDDEN`
 * (never role-split): `canAccessClient` never denies `ADMIN_MANAGER` in
 * the first place, so only `TRAVEL_CONSULTANT` can ever reach that branch.
 * The actor-scoped `findProposalByIdForActor` read that follows is the
 * authoritative response — its own `null` result (which can only occur for
 * `TRAVEL_CONSULTANT`, since `ADMIN_MANAGER`'s unconditional access and the
 * context read above already proved existence) applies the identical
 * NOT_FOUND/FORBIDDEN split. Returns the detail, including any legacy
 * `content: null`, unchanged — "Content unavailable" is a UI concern, not
 * this service's.
 */
export async function getProposalById(
  actor: AuthenticatedUser,
  id: string,
): Promise<ProposalDetailRecord> {
  const proposalActor = assertProposalViewerActor(actor);

  const context = await repository.findProposalContext(prisma, id);
  if (!context) {
    throw proposalNotFoundOrForbidden(proposalActor);
  }

  const access = await canAccessClient(actor, context.clientId);
  if (!access.allowed) {
    throw new ProposalError('PROPOSAL_FORBIDDEN', PROPOSAL_FORBIDDEN_MESSAGE);
  }

  const found = await repository.findProposalByIdForActor(prisma, proposalActor, id);
  if (!found) {
    throw proposalNotFoundOrForbidden(proposalActor);
  }
  return found;
}

// --- Create first Proposal (D-027 §2/§3/§6's POST /api/proposals) ---

export type CreateProposalResult = { proposal: ProposalRecord; version: ProposalVersionRecord };

/**
 * Creates a Proposal and its first ProposalVersion (D-027 §2/§6) —
 * Travel-Consultant-only, and deliberately **not** idempotent: the schema
 * permits multiple Proposals per Client, so a repeated successful request
 * creates another Proposal (no replay/dedupe behavior is added).
 *
 * Authorization runs twice: once against `prisma` before any transaction
 * opens (so a doomed request never pays for one), and again,
 * transaction-locally against `tx`, as the very first operation inside the
 * transaction — before the Proposal id is even generated — closing the
 * race window between the two checks (D-027 §3). Both checks use the
 * identical `assertProposalAuthorAccess`.
 *
 * The Proposal id is generated server-side (`randomUUID()`) only after the
 * transaction-local recheck passes. `createProposalWithFirstVersion` and
 * the `PROPOSAL_CREATED` audit write both run inside this same transaction.
 * No `PROPOSAL_VERSION_CREATED` entry is written for the first version —
 * the `PROPOSAL_CREATED` snapshot already identifies it
 * (`firstVersionId`/`firstVersionNumber`), per the accepted audit contract.
 */
export async function createProposal(
  actor: AuthenticatedUser,
  input: CreateProposalInput,
): Promise<CreateProposalResult> {
  const authorActor = assertProposalAuthorActor(actor);

  await assertProposalAuthorAccess(
    prisma,
    authorActor.id,
    input.clientId,
    'CLIENT_FORBIDDEN',
    CLIENT_FORBIDDEN_MESSAGE,
  );

  try {
    return await runSerializableWithRetry(async (tx) => {
      await assertProposalAuthorAccess(
        tx,
        authorActor.id,
        input.clientId,
        'CLIENT_FORBIDDEN',
        CLIENT_FORBIDDEN_MESSAGE,
      );

      const proposalId = randomUUID();
      const { proposal, version } = await repository.createProposalWithFirstVersion(tx, {
        id: proposalId,
        clientId: input.clientId,
        content: input.content,
        createdByUserId: authorActor.id,
      });

      await repository.insertAuditLog(tx, {
        actorId: authorActor.id,
        action: PROPOSAL_AUDIT_ACTIONS.PROPOSAL_CREATED,
        entityType: PROPOSAL_AUDIT_ENTITY_TYPE.PROPOSAL,
        entityId: proposal.id,
        afterState: sanitizeProposalCreatedSnapshot({
          clientId: proposal.clientId,
          firstVersionId: version.id,
          firstVersionNumber: version.versionNumber,
        }),
      });

      return { proposal, version };
    });
  } catch (error) {
    if (isOtherKnownConflict(error)) {
      throw new ProposalError('PROPOSAL_CONFLICT', PROPOSAL_CONFLICT_MESSAGE);
    }
    throw error;
  }
}

// --- Create revision (D-027 §2/§3/§6's POST /api/proposals/[id]/versions) ---

const MAX_REVISION_ATTEMPTS = 3;

/**
 * Creates a new ProposalVersion for an existing Proposal (D-027 §6) —
 * Travel-Consultant-only, and deliberately **not** idempotent (D-027 §6:
 * multiple coexisting unpublished drafts are permitted; no natural key
 * exists to replay against).
 *
 * Pre-transaction: resolves the unscoped `findProposalContext` (a missing
 * Proposal here is `PROPOSAL_FORBIDDEN` — `createProposalRevision` is
 * Travel-Consultant-only, so, mirroring D-027 §5's publish rule, there is
 * no `ADMIN_MANAGER`-reachable branch left to ever report
 * `PROPOSAL_NOT_FOUND` from this function) and runs
 * `assertProposalAuthorAccess` against `prisma`.
 *
 * The write itself runs inside an outer, bounded retry loop of exactly
 * three attempts (D-027 §6, mirroring
 * features/bookings/service.ts's `createBooking`'s own
 * `bookingReference`-collision retry loop exactly): each attempt opens a
 * *fresh* `runSerializableWithRetry` transaction — a failed statement
 * aborts the Postgres transaction it ran in, so retrying inside the same
 * `tx` callback would not work — and, transaction-locally, re-reads the
 * Proposal context and reruns `assertProposalAuthorAccess` before calling
 * `repository.createProposalRevision` (which owns the
 * `MAX(versionNumber) + 1` allocation) and writing the
 * `PROPOSAL_VERSION_CREATED` audit entry. Because both the version write
 * and its audit entry live inside the same transaction, a rolled-back
 * attempt can never leave a surviving audit row.
 *
 * Only a P2002 conflict whose target names both `proposalId` and
 * `versionNumber` (the composite `@@unique` index, i.e. a genuine
 * concurrent revision-number race) triggers a retry; every other
 * conflict — an unrelated P2002, P2004, or an exhausted P2034 — maps
 * immediately to `PROPOSAL_CONFLICT`, never retried. `ProposalError`
 * business outcomes and any truly unexpected error propagate unchanged,
 * also never retried. After the third composite-conflict attempt, this
 * function gives up with the same controlled `PROPOSAL_CONFLICT`.
 */
export async function createProposalRevision(
  actor: AuthenticatedUser,
  proposalId: string,
  input: CreateProposalRevisionInput,
): Promise<ProposalVersionRecord> {
  const authorActor = assertProposalAuthorActor(actor);

  const preContext = await repository.findProposalContext(prisma, proposalId);
  if (!preContext) {
    throw new ProposalError('PROPOSAL_FORBIDDEN', PROPOSAL_FORBIDDEN_MESSAGE);
  }
  await assertProposalAuthorAccess(
    prisma,
    authorActor.id,
    preContext.clientId,
    'PROPOSAL_FORBIDDEN',
    PROPOSAL_FORBIDDEN_MESSAGE,
  );

  for (let attempt = 1; attempt <= MAX_REVISION_ATTEMPTS; attempt += 1) {
    try {
      return await runSerializableWithRetry(async (tx) => {
        const context = await repository.findProposalContext(tx, proposalId);
        if (!context) {
          throw new ProposalError('PROPOSAL_FORBIDDEN', PROPOSAL_FORBIDDEN_MESSAGE);
        }
        await assertProposalAuthorAccess(
          tx,
          authorActor.id,
          context.clientId,
          'PROPOSAL_FORBIDDEN',
          PROPOSAL_FORBIDDEN_MESSAGE,
        );

        const version = await repository.createProposalRevision(tx, {
          proposalId,
          content: input.content,
          createdByUserId: authorActor.id,
        });

        await repository.insertAuditLog(tx, {
          actorId: authorActor.id,
          action: PROPOSAL_AUDIT_ACTIONS.PROPOSAL_VERSION_CREATED,
          entityType: PROPOSAL_AUDIT_ENTITY_TYPE.PROPOSAL_VERSION,
          entityId: version.id,
          afterState: sanitizeProposalVersionCreatedSnapshot({
            proposalId: version.proposalId,
            versionNumber: version.versionNumber,
          }),
        });

        return version;
      });
    } catch (error) {
      if (isUniqueConflictOn(error, 'proposalId', 'versionNumber')) {
        if (attempt < MAX_REVISION_ATTEMPTS) {
          continue;
        }
        throw new ProposalError('PROPOSAL_CONFLICT', PROPOSAL_CONFLICT_MESSAGE);
      }
      if (isOtherKnownConflict(error)) {
        throw new ProposalError('PROPOSAL_CONFLICT', PROPOSAL_CONFLICT_MESSAGE);
      }
      // ProposalError business-rule outcomes (PROPOSAL_FORBIDDEN) and any
      // truly unexpected error propagate unchanged — never retried.
      throw error;
    }
  }

  // Unreachable: the loop above always returns or throws. Present only to
  // satisfy TypeScript's control-flow analysis, mirroring
  // features/bookings/service.ts's `createBooking` retry loop's identical
  // trailing statement.
  throw new ProposalError('PROPOSAL_CONFLICT', PROPOSAL_CONFLICT_MESSAGE);
}

// --- Publish (D-027 §5) ---

/**
 * Publishes a ProposalVersion — Travel-Consultant-only (D-027 §3/§5).
 *
 * Pre-transaction: resolves the unscoped `findProposalVersionContext` (a
 * missing/inaccessible target here is unconditionally
 * `PROPOSAL_VERSION_FORBIDDEN`, never `PROPOSAL_VERSION_NOT_FOUND` — D-027
 * §5: since publish is Travel-Consultant-only, `ADMIN_MANAGER` never
 * reaches this function at all, so there is no role branch left that could
 * ever legitimately report `NOT_FOUND`) and runs
 * `assertProposalAuthorAccess` against `prisma`.
 *
 * Inside exactly one `runSerializableWithRetry` transaction, in D-027 §5's
 * exact fixed order:
 *
 * A. `findProposalVersionForActor(tx, actor, versionId)` — the
 *    actor-scoped re-read, before the assignment recheck below (D-027 §5's
 *    required ordering). `null` → `PROPOSAL_VERSION_FORBIDDEN`.
 * B. Transaction-local `assertProposalAuthorAccess` recheck.
 * C. Idempotent same-outcome check — already current
 *    (`clientVisibleAt !== null && supersededAt === null`) → return the
 *    target unchanged, with no current-version read, no
 *    `expectedCurrentVersionId` comparison, no write, and no audit. This
 *    succeeds even when `expectedCurrentVersionId` is stale or `null`.
 * D. Superseded check — `supersededAt !== null` →
 *    `PROPOSAL_VERSION_SUPERSEDED`, with no current-version read and no
 *    write/audit.
 * E. Optimistic-concurrency check — the Proposal's authoritative current
 *    version (if any) is compared, by exact `string | null` equality,
 *    against `input.expectedCurrentVersionId`; a mismatch →
 *    `PROPOSAL_CONFLICT` with D-027's exact required refresh message, with
 *    no write/audit.
 * F. Successful publish — one `Date` instance is used for both writes: the
 *    prior current version (if any) is superseded first, then the target
 *    is marked client-visible, then one `PROPOSAL_VERSION_PUBLISHED` audit
 *    entry is written, all inside this same transaction.
 *
 * Both the idempotent (C) and successful (F) paths return the identical
 * `ProposalVersionActorContext` shape — deliberately not a full Proposal
 * detail fetch merely to obtain `content`, which this lifecycle result
 * never needs: the successful-publish result is constructed by combining
 * the already-authorized `target`'s stable identity/clientId with the
 * fresh `clientVisibleAt`/`supersededAt` the write just produced.
 *
 * Any residual P2002 (including the partial `proposal_version_current_
 * client_visible_key` unique index), P2004, or exhausted P2034 maps to
 * `PROPOSAL_CONFLICT` — never a raw Prisma/PostgreSQL error.
 */
export async function publishProposalVersion(
  actor: AuthenticatedUser,
  versionId: string,
  input: PublishProposalVersionInput,
): Promise<ProposalVersionActorContext> {
  const authorActor = assertProposalAuthorActor(actor);

  const preContext = await repository.findProposalVersionContext(prisma, versionId);
  if (!preContext) {
    throw new ProposalError('PROPOSAL_VERSION_FORBIDDEN', PROPOSAL_VERSION_FORBIDDEN_MESSAGE);
  }
  await assertProposalAuthorAccess(
    prisma,
    authorActor.id,
    preContext.clientId,
    'PROPOSAL_VERSION_FORBIDDEN',
    PROPOSAL_VERSION_FORBIDDEN_MESSAGE,
  );

  try {
    return await runSerializableWithRetry(async (tx) => {
      // A. Actor-scoped re-read — before the assignment recheck (D-027 §5).
      const target = await repository.findProposalVersionForActor(tx, authorActor, versionId);
      if (!target) {
        throw new ProposalError('PROPOSAL_VERSION_FORBIDDEN', PROPOSAL_VERSION_FORBIDDEN_MESSAGE);
      }

      // B. Transaction-local assignment recheck.
      await assertProposalAuthorAccess(
        tx,
        authorActor.id,
        target.clientId,
        'PROPOSAL_VERSION_FORBIDDEN',
        PROPOSAL_VERSION_FORBIDDEN_MESSAGE,
      );

      // C. Idempotent same-outcome check — checked first, before any other
      // comparison, mirroring setLeadAssignment's/setClientAssignment's
      // same-outcome-runs-first precedent.
      if (target.clientVisibleAt !== null && target.supersededAt === null) {
        return target;
      }

      // D. Superseded check — a superseded version can never be
      // resurrected as current by a later publish call.
      if (target.supersededAt !== null) {
        throw new ProposalError('PROPOSAL_VERSION_SUPERSEDED', PROPOSAL_VERSION_SUPERSEDED_MESSAGE);
      }

      // E. Optimistic-concurrency check.
      const current = await repository.findCurrentClientVisibleVersion(tx, target.proposalId);
      const actualCurrentVersionId = current?.id ?? null;
      if (actualCurrentVersionId !== input.expectedCurrentVersionId) {
        throw new ProposalError('PROPOSAL_CONFLICT', PUBLISH_CONFLICT_MESSAGE);
      }

      // F. Successful publish — one Date for both writes; supersede before
      // publish.
      const publishedAt = new Date();
      if (current) {
        await repository.markProposalVersionSuperseded(tx, current.id, publishedAt);
      }
      const updated = await repository.markProposalVersionClientVisible(tx, target.id, publishedAt);

      await repository.insertAuditLog(tx, {
        actorId: authorActor.id,
        action: PROPOSAL_AUDIT_ACTIONS.PROPOSAL_VERSION_PUBLISHED,
        entityType: PROPOSAL_AUDIT_ENTITY_TYPE.PROPOSAL_VERSION,
        entityId: target.id,
        afterState: sanitizeProposalVersionPublishedSnapshot({
          proposalId: target.proposalId,
          versionNumber: target.versionNumber,
          previousCurrentVersionId: current?.id ?? null,
        }),
      });

      return {
        id: updated.id,
        proposalId: target.proposalId,
        clientId: target.clientId,
        versionNumber: target.versionNumber,
        clientVisibleAt: updated.clientVisibleAt,
        supersededAt: updated.supersededAt,
      };
    });
  } catch (error) {
    if (isOtherKnownConflict(error)) {
      throw new ProposalError('PROPOSAL_CONFLICT', PROPOSAL_CONFLICT_MESSAGE);
    }
    throw error;
  }
}

// --- Record external response (D-027 §4/§7/§9.1) ---

/**
 * Records a Section 9.1 externally received response — `ADMIN_MANAGER` and
 * `TRAVEL_CONSULTANT` (D-027 §3).
 *
 * Pre-transaction: resolves the unscoped `findProposalVersionContext`
 * (`null` → role-split `PROPOSAL_VERSION_NOT_FOUND`/`PROPOSAL_VERSION_
 * FORBIDDEN`) and calls `canAccessClient` (denial → `PROPOSAL_VERSION_
 * FORBIDDEN`, never role-split — `canAccessClient` never denies
 * `ADMIN_MANAGER`).
 *
 * Inside one `runSerializableWithRetry` transaction: re-fetches the target
 * via the actor-scoped `findProposalVersionForActor` (`null` → the same
 * role-split NOT_FOUND/FORBIDDEN), and, for `TRAVEL_CONSULTANT` only, reruns
 * `assertProposalAuthorAccess` transaction-locally (`ADMIN_MANAGER`
 * performs no assignment recheck — D-027 §3's Admin/Manager
 * response-recording capability is unconditional). Then, in D-027 §7's
 * exact fixed order:
 *
 * A. Existing-response check first — `findProposalAcceptanceForVersion`;
 *    any existing row → `PROPOSAL_RESPONSE_ALREADY_RECORDED`,
 *    unconditionally, regardless of the submitted values and regardless of
 *    `target`'s current lifecycle state (an already-superseded version
 *    that already carries a response still reports this code, never
 *    `PROPOSAL_VERSION_NOT_CURRENT`) — no current-version read, no write,
 *    no audit.
 * B. Current-version check second — only reached when no acceptance
 *    exists yet; the target must be the Proposal's authoritative current
 *    client-visible version, or `PROPOSAL_VERSION_NOT_CURRENT`, with no
 *    write/audit.
 * C. Creates the external `ProposalAcceptance` — `input.respondedAt` (an
 *    already-validated ISO-8601 string, `Z` or numeric-offset per
 *    schemas.ts's `z.iso.datetime({ offset: true })`) is converted to a
 *    `Date` via the native constructor, which already preserves the
 *    represented instant for either form; `recordedByStaffUserId` is the
 *    acting staff member; no portal attribution field is ever populated
 *    (D-027 §4's two attribution paths are mutually exclusive, and portal
 *    acceptance is deferred to Phase 3).
 * D. Writes one `PROPOSAL_RESPONSE_RECORDED` audit entry, atomically, in
 *    the same transaction.
 *
 * A concurrent response that loses the `ProposalAcceptance.proposalVersionId`
 * unique race is translated to the same controlled
 * `PROPOSAL_RESPONSE_ALREADY_RECORDED` — never exposed as a raw Prisma
 * error, and never treated as an idempotent success. Every other residual
 * P2002, P2004, or exhausted P2034 maps to `PROPOSAL_CONFLICT`.
 */
export async function recordProposalResponse(
  actor: AuthenticatedUser,
  versionId: string,
  input: RecordProposalResponseInput,
): Promise<ProposalAcceptanceRecord> {
  const proposalActor = assertProposalViewerActor(actor);

  const preContext = await repository.findProposalVersionContext(prisma, versionId);
  if (!preContext) {
    throw proposalVersionNotFoundOrForbidden(proposalActor);
  }

  const access = await canAccessClient(actor, preContext.clientId);
  if (!access.allowed) {
    throw new ProposalError('PROPOSAL_VERSION_FORBIDDEN', PROPOSAL_VERSION_FORBIDDEN_MESSAGE);
  }

  try {
    return await runSerializableWithRetry(async (tx) => {
      const target = await repository.findProposalVersionForActor(tx, proposalActor, versionId);
      if (!target) {
        throw proposalVersionNotFoundOrForbidden(proposalActor);
      }

      if (proposalActor.role === 'TRAVEL_CONSULTANT') {
        await assertProposalAuthorAccess(
          tx,
          proposalActor.id,
          target.clientId,
          'PROPOSAL_VERSION_FORBIDDEN',
          PROPOSAL_VERSION_FORBIDDEN_MESSAGE,
        );
      }

      // A. Existing-response check first — fixed ordering, D-027 §7.
      const existing = await repository.findProposalAcceptanceForVersion(tx, versionId);
      if (existing) {
        throw new ProposalError(
          'PROPOSAL_RESPONSE_ALREADY_RECORDED',
          PROPOSAL_RESPONSE_ALREADY_RECORDED_MESSAGE,
        );
      }

      // B. Current-version check second.
      const current = await repository.findCurrentClientVisibleVersion(tx, target.proposalId);
      if ((current?.id ?? null) !== target.id) {
        throw new ProposalError(
          'PROPOSAL_VERSION_NOT_CURRENT',
          PROPOSAL_VERSION_NOT_CURRENT_MESSAGE,
        );
      }

      // C. Create the external response.
      const acceptance = await repository.createExternalProposalAcceptance(tx, {
        proposalVersionId: target.id,
        responseType: input.responseType,
        respondedAt: new Date(input.respondedAt),
        recordedByStaffUserId: proposalActor.id,
        responseMethod: input.responseMethod,
        evidenceReference: input.evidenceReference,
      });

      // D. Audit atomically, in the same transaction.
      await repository.insertAuditLog(tx, {
        actorId: proposalActor.id,
        action: PROPOSAL_AUDIT_ACTIONS.PROPOSAL_RESPONSE_RECORDED,
        entityType: PROPOSAL_AUDIT_ENTITY_TYPE.PROPOSAL_VERSION,
        entityId: target.id,
        afterState: sanitizeProposalResponseRecordedSnapshot({
          acceptanceId: acceptance.id,
          responseType: acceptance.responseType,
          respondedAt: acceptance.respondedAt,
        }),
      });

      return acceptance;
    });
  } catch (error) {
    if (isUniqueConflictOn(error, 'proposalVersionId')) {
      throw new ProposalError(
        'PROPOSAL_RESPONSE_ALREADY_RECORDED',
        PROPOSAL_RESPONSE_ALREADY_RECORDED_MESSAGE,
      );
    }
    if (isOtherKnownConflict(error)) {
      throw new ProposalError('PROPOSAL_CONFLICT', PROPOSAL_CONFLICT_MESSAGE);
    }
    throw error;
  }
}

// --- Client-portal reads (docs/HERITAGE_V3_DECISIONS_LOG.md D-040 §§2, 3, 4) ---
// Contracts B and C: the Proposal / ROS feature's own CLIENT-safe reads for
// the Client Home / Overview. Read-only, no transaction, no audit.
// Authorization is two independent checks, in this order: a CLIENT-role
// gate (defense in depth), then `canAccessClient(actor, clientId)` — the
// exact ownership re-check D-040 §2 layer 4 requires on every client-facing
// read, run BEFORE the repository is touched. The `clientId` is only ever
// the server-resolved owned id from Contract A
// (features/clients/service.ts's `getOwnClientForUser`); this feature never
// accepts a client identifier from a path, query, body, or caller-controlled
// object here.

const CLIENT_PORTAL_ROLE_MESSAGE = 'This role is not permitted to access client portal proposals.';

function assertClientPortalActor(actor: AuthenticatedUser): { id: string } {
  if (actor.role === 'CLIENT') {
    return { id: actor.id };
  }
  throw new ProposalError('ROLE_NOT_PERMITTED', CLIENT_PORTAL_ROLE_MESSAGE);
}

async function assertClientPortalAccess(actor: AuthenticatedUser, clientId: string): Promise<void> {
  assertClientPortalActor(actor);
  const access = await canAccessClient(actor, clientId);
  if (!access.allowed) {
    throw new ProposalError('CLIENT_FORBIDDEN', CLIENT_FORBIDDEN_MESSAGE);
  }
}

// D-040 §4's exact client-facing per-item labels, derived from the
// ProposalVersion's acceptance response type (or its absence).
const CLIENT_PROPOSAL_STATUS_LABELS = {
  AWAITING: 'Awaiting your response',
  ACCEPT: 'Accepted',
  DECLINE: 'Declined',
  REQUEST_CHANGES: 'Changes requested',
} as const;

function clientProposalStatusLabel(
  responseType: 'ACCEPT' | 'DECLINE' | 'REQUEST_CHANGES' | null,
): string {
  return responseType === null
    ? CLIENT_PROPOSAL_STATUS_LABELS.AWAITING
    : CLIENT_PROPOSAL_STATUS_LABELS[responseType];
}

export type ClientProposalPreviewItem = { versionNumber: number; statusLabel: string };
export type ClientProposalPreview = { items: ClientProposalPreviewItem[] };

/**
 * Contract B (D-040 §3/§4): the five bounded, complete-dataset proposal
 * facts for the authenticated client's owned Client — every current-
 * client-visible ProposalVersion count, including
 * `acceptedWithoutClientVisibleBooking` (ACCEPT with a missing or DRAFT
 * booking).
 */
export async function getClientProposalFacts(
  actor: AuthenticatedUser,
  clientId: string,
): Promise<repository.ClientProposalFacts> {
  await assertClientPortalAccess(actor, clientId);
  return repository.findClientProposalFacts(prisma, clientId);
}

/**
 * Contract C (D-040 §3/§4): the five-item, deterministically ordered
 * client-visible proposal preview, each item carrying only `versionNumber`
 * and a client-facing `statusLabel` — never proposal content or any
 * internal identifier.
 */
export async function getClientProposalPreview(
  actor: AuthenticatedUser,
  clientId: string,
): Promise<ClientProposalPreview> {
  await assertClientPortalAccess(actor, clientId);
  const rows = await repository.findClientProposalPreview(prisma, clientId);
  return {
    items: rows.map((row) => ({
      versionNumber: row.versionNumber,
      statusLabel: clientProposalStatusLabel(row.responseType),
    })),
  };
}

// --- Client proposal-review page (docs/HERITAGE_V3_DECISIONS_LOG.md D-047
// §5) ---
// The CLIENT-safe read backing the paginated `/client/my-journey`
// proposal-review route. Read-only: no transaction, no audit, no mutation.
// Authorization mirrors Contracts B/C above exactly — the CLIENT-role gate
// then `canAccessClient(actor, clientId)` via `assertClientPortalAccess`,
// run BEFORE any proposal repository read; `clientId` is only ever the
// server-resolved owned id Stage 4 resolves from Contract A
// (`clients.getOwnClientForUser`), never a value from a path, query, body,
// or caller object.
//
// D-047 §4's internal-identifier boundary is enforced here by returning two
// distinct shapes: `render` (the identifier-free DTO Stage 4 passes to
// client components — `versionNumber`, ISO `publishedAt`, `content` or a
// `{ available: false }` marker, the `{ responseType, respondedAt }`
// response summary or `null`, and the reused status label; NO `Proposal` /
// `ProposalVersion` / `ProposalAcceptance` identifier), and `serverModel`
// (index-aligned with `render.cards`, carrying `proposalVersionId` /
// `proposalId` for Stage 5 action binding; never passed to a client
// component).

export type ClientProposalReviewContent = { available: true; text: string } | { available: false };

export type ClientProposalReviewResponse = {
  responseType: 'ACCEPT' | 'DECLINE' | 'REQUEST_CHANGES';
  respondedAt: string;
};

export type ClientProposalReviewCard = {
  versionNumber: number;
  publishedAt: string;
  content: ClientProposalReviewContent;
  response: ClientProposalReviewResponse | null;
  statusLabel: string;
};

export type ClientProposalReviewRender = {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  isEmpty: boolean;
  cards: ClientProposalReviewCard[];
};

export type ClientProposalReviewServerCard = { proposalVersionId: string; proposalId: string };

export type ClientProposalReviewServerModel = { cards: ClientProposalReviewServerCard[] };

export type ClientProposalReviewPageResult =
  | { kind: 'redirect' }
  | {
      kind: 'page';
      render: ClientProposalReviewRender;
      serverModel: ClientProposalReviewServerModel;
    };

function toClientProposalReviewContent(content: string | null): ClientProposalReviewContent {
  return content === null ? { available: false } : { available: true, text: content };
}

function toClientProposalReviewResponse(
  acceptance: ClientProposalReviewRow['acceptance'],
): ClientProposalReviewResponse | null {
  return acceptance === null
    ? null
    : { responseType: acceptance.responseType, respondedAt: acceptance.respondedAt.toISOString() };
}

/**
 * Splits one fetched-and-bounded row set (up to `PAGE_SIZE + 1` rows) into
 * the identifier-free `render` DTO and the server-only `serverModel`. The
 * `PAGE_SIZE + 1`th row, if present, only sets `hasNext` — at most
 * `PAGE_SIZE` cards are ever emitted. `render.cards` and `serverModel.cards`
 * are built from the same sliced list, so they stay index-aligned.
 */
function toClientProposalReviewPage(
  rows: ClientProposalReviewRow[],
  page: number,
  hasPrevious: boolean,
): { render: ClientProposalReviewRender; serverModel: ClientProposalReviewServerModel } {
  const pageRows = rows.slice(0, repository.CLIENT_PROPOSAL_REVIEW_PAGE_SIZE);
  const hasNext = rows.length > repository.CLIENT_PROPOSAL_REVIEW_PAGE_SIZE;
  return {
    render: {
      page,
      hasPrevious,
      hasNext,
      isEmpty: pageRows.length === 0,
      cards: pageRows.map((row) => ({
        versionNumber: row.versionNumber,
        publishedAt: row.clientVisibleAt.toISOString(),
        content: toClientProposalReviewContent(row.content),
        response: toClientProposalReviewResponse(row.acceptance),
        statusLabel: clientProposalStatusLabel(row.acceptance?.responseType ?? null),
      })),
    },
    serverModel: {
      cards: pageRows.map((row) => ({
        proposalVersionId: row.proposalVersionId,
        proposalId: row.proposalId,
      })),
    },
  };
}

/**
 * D-047 §5: one page of the authenticated client's current-client-visible
 * proposal-review cards for `/client/my-journey`.
 *
 * - Authorization first — `assertClientPortalAccess(actor, clientId)`
 *   (CLIENT role + `canAccessClient`), before any repository read.
 * - Page 1 uses the bounded card query directly (`skip 0`,
 *   `take PAGE_SIZE + 1`); an empty result is the page-1 global empty state
 *   (`kind: 'page'`, `isEmpty: true`), NOT a redirect.
 * - Page > 1 first COUNTS (same ownership + current-visible predicate as
 *   the card query), derives the last existing page (`ceil(count / 10)`),
 *   and returns `{ kind: 'redirect' }` when the requested page exceeds it —
 *   BEFORE computing `(page - 1) * PAGE_SIZE` or issuing any offset query.
 *   A confirmed page > 1 that still returns no rows (concurrent change)
 *   also returns `{ kind: 'redirect' }`.
 * - The `render` DTO carries no database identifier; `proposalVersionId` /
 *   `proposalId` live only in `serverModel`, index-aligned with
 *   `render.cards`.
 *
 * `page` is expected already normalized to a positive safe integer by
 * `parseProposalReviewPageParam` (schemas.ts); as defense in depth this
 * function still clamps any non-safe-integer or `< 1` value to page 1, so
 * an offset is never derived from an unsafe integer even via a mis-wired
 * caller.
 */
export async function getClientProposalReviewPage(
  actor: AuthenticatedUser,
  clientId: string,
  page: number,
): Promise<ClientProposalReviewPageResult> {
  await assertClientPortalAccess(actor, clientId);

  const pageSize = repository.CLIENT_PROPOSAL_REVIEW_PAGE_SIZE;
  const requestedPage = Number.isSafeInteger(page) && page >= 1 ? page : 1;

  if (requestedPage === 1) {
    const rows = await repository.findClientProposalReviewPage(prisma, clientId, {
      skip: 0,
      take: pageSize + 1,
    });
    return { kind: 'page', ...toClientProposalReviewPage(rows, 1, false) };
  }

  const total = await repository.countCurrentClientVisibleProposalVersions(prisma, clientId);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (requestedPage > lastPage) {
    return { kind: 'redirect' };
  }

  const skip = (requestedPage - 1) * pageSize;
  const rows = await repository.findClientProposalReviewPage(prisma, clientId, {
    skip,
    take: pageSize + 1,
  });
  if (rows.length === 0) {
    return { kind: 'redirect' };
  }
  return { kind: 'page', ...toClientProposalReviewPage(rows, requestedPage, true) };
}

// --- Client proposal-response mutation (docs/HERITAGE_V3_DECISIONS_LOG.md
// D-047 §6–§10) ---
// The write path behind the `/client/my-journey` response form. The inline
// `'use server'` action in `page.tsx` owns the request boundary — the
// verified session lookup (`getCurrentSession()`), the `.strict()` schema
// parse of the FormData, mapping the outcome to an identifier-free result,
// and `revalidatePath('/client/my-journey')` on success. This module owns
// the business rules: the D-047 §7 fixed check order, the one SERIALIZABLE
// transaction, conflict mapping, and the atomic audit. Every check is
// re-derived on every call — the action is treated as directly invocable
// with a forged payload (§6). No `content`, identifier, staff field,
// session value, or Prisma detail is ever placed in a value the client can
// observe (§11); a truly unexpected error propagates to the segment error
// boundary unchanged.

// D-047 §6/§9. The only two fields the form submits. `.strict()` rejects any
// extra key — a forged `respondedAt` / `clientId` / `clientProfileId` /
// `sessionId` / `proposalId` / `proposalVersionId` is a `VALIDATION_ERROR`,
// never trusted. An unchecked acknowledgement checkbox is absent from the
// FormData, so `z.literal('on')` (not `.optional()`) makes a missing or
// non-`'on'` value a `VALIDATION_ERROR` with no write (§9).
export const clientProposalResponseSchema = z
  .object({
    responseType: z.nativeEnum(ProposalResponseType),
    acknowledgement: z.literal('on'),
  })
  .strict();
export type ClientProposalResponseInput = z.infer<typeof clientProposalResponseSchema>;

// D-047 §6. The controlled, identifier-free code union the Server Action
// returns to the client. Distinct from `ProposalErrorCode`: the forbidden /
// not-found / role family all collapse to one `FORBIDDEN` outcome
// (anti-enumeration — never confirming whether a target exists, §7 step 4).
export type ClientProposalResponseCode =
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'PROPOSAL_RESPONSE_ALREADY_RECORDED'
  | 'PROPOSAL_VERSION_NOT_CURRENT'
  | 'PROPOSAL_VERSION_SUPERSEDED'
  | 'PROPOSAL_CONFLICT';

// The `useActionState` value the response form renders from. `idle` before
// the first submit; `success` swaps the form for the read-only summary (and
// the action has revalidated `/client/my-journey`); `error` keeps the form
// and shows a client-safe message. Carries no identifier or `content`.
export type ClientProposalResponseState =
  | { status: 'idle' }
  | { status: 'success'; responseType: ProposalResponseType }
  | { status: 'error'; code: ClientProposalResponseCode };

export type ClientProposalResponseAction = (
  state: ClientProposalResponseState,
  formData: FormData,
) => Promise<ClientProposalResponseState>;

const PROPOSAL_ERROR_TO_RESPONSE_CODE: Partial<
  Record<ProposalErrorCode, ClientProposalResponseCode>
> = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PROPOSAL_RESPONSE_ALREADY_RECORDED: 'PROPOSAL_RESPONSE_ALREADY_RECORDED',
  PROPOSAL_VERSION_NOT_CURRENT: 'PROPOSAL_VERSION_NOT_CURRENT',
  PROPOSAL_VERSION_SUPERSEDED: 'PROPOSAL_VERSION_SUPERSEDED',
  PROPOSAL_CONFLICT: 'PROPOSAL_CONFLICT',
};

/**
 * Maps a `ProposalError` raised by `submitClientProposalResponse` to the
 * controlled client-facing code. Anything not in the explicit table —
 * `ROLE_NOT_PERMITTED`, `CLIENT_FORBIDDEN`, `PROPOSAL*_FORBIDDEN`,
 * `*_NOT_FOUND` — becomes the single generic `FORBIDDEN` (§6/§7 step 4).
 */
export function clientProposalResponseCodeFor(error: ProposalError): ClientProposalResponseCode {
  return PROPOSAL_ERROR_TO_RESPONSE_CODE[error.code] ?? 'FORBIDDEN';
}

export type SubmitClientProposalResponseInput = {
  actor: AuthenticatedUser;
  sessionId: string;
  proposalVersionId: string;
  responseType: ProposalResponseType;
  acknowledged: boolean;
};

const RESPONSE_TYPE_VALUES: readonly ProposalResponseType[] = [
  ProposalResponseType.ACCEPT,
  ProposalResponseType.DECLINE,
  ProposalResponseType.REQUEST_CHANGES,
];

/**
 * Records a client's portal response to a proposal version — D-047 §6–§10.
 *
 * Pre-transaction (§7 steps 1–2), all failing closed with **no write**:
 *  - `CLIENT` role (`assertClientPortalActor`) and a usable non-empty
 *    `sessionId` — else `ROLE_NOT_PERMITTED` / `CLIENT_FORBIDDEN`.
 *  - server-side re-validation of `responseType` (closed enum) and the
 *    required `acknowledged === true` — else `VALIDATION_ERROR` (§9/§15).
 *  - Contract A `getOwnClientForUser(actor)` → `ownedClientId`; the §8
 *    `{ clientProfileId, clientId }` identity read on the ordinary Prisma
 *    path; `clientId` must equal `ownedClientId`; then the ordinary
 *    `canAccessClient(actor, ownedClientId)` defense-in-depth check
 *    (its existing global-Prisma-path signature; `features/assignments/**`
 *    is not modified). Any unresolved / mismatched / denied value →
 *    `CLIENT_FORBIDDEN`.
 *
 * Inside one `runSerializableWithRetry` (SERIALIZABLE) transaction, in D-027
 * §7's fixed order (§7 steps 3–8):
 *  4. `tx`-capable re-resolve of `{ clientProfileId, clientId }` and read of
 *     the captured target `ProposalVersion` with its `Proposal.clientId`;
 *     require both `clientId`s equal `ownedClientId`. An absent identity, an
 *     absent target, or an ownership mismatch → **one identical generic
 *     `CLIENT_FORBIDDEN`**, never confirming whether the target exists.
 *     `canAccessClient` is **not** re-called here.
 *  5. Existing-response check first — any `ProposalAcceptance` row →
 *     `PROPOSAL_RESPONSE_ALREADY_RECORDED`, unconditionally (response
 *     before current-version, mirroring D-027 §7).
 *  6. Current-visible check — if the Proposal's current client-visible
 *     version is not this target → `PROPOSAL_VERSION_SUPERSEDED` when the
 *     target is superseded, else `PROPOSAL_VERSION_NOT_CURRENT`.
 *  7. Portal `ProposalAcceptance` insert — server-generated `respondedAt`,
 *     the `tx`-resolved `clientProfileId`, the live `sessionId`; external
 *     fields left `NULL`.
 *  8. Atomic `PROPOSAL_RESPONSE_RECORDED` audit — `actorId` = the client's
 *     `User.id`, `entityId` = the target `ProposalVersion.id`, snapshot via
 *     the existing portal-neutral `sanitizeProposalResponseRecordedSnapshot`
 *     ({ acceptanceId, responseType, respondedAt } only — no `content`, no
 *     staff/session field, no acknowledgement).
 *
 * A P2002 unique-race on `proposalVersionId` → `PROPOSAL_RESPONSE_ALREADY_
 * RECORDED` (never an idempotent success, never a raw error). Every other
 * residual P2002 / P2004 / exhausted P2034 → `PROPOSAL_CONFLICT`. A truly
 * unexpected error propagates unchanged.
 */
export async function submitClientProposalResponse(
  input: SubmitClientProposalResponseInput,
): Promise<{ responseType: ProposalResponseType }> {
  // §7 step 1 — role + live session id.
  assertClientPortalActor(input.actor);
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    throw new ProposalError('CLIENT_FORBIDDEN', CLIENT_FORBIDDEN_MESSAGE);
  }

  // §9/§15 — server-side re-validation, independent of the action's schema.
  if (input.acknowledged !== true || !RESPONSE_TYPE_VALUES.includes(input.responseType)) {
    throw new ProposalError('VALIDATION_ERROR', PROPOSAL_RESPONSE_VALIDATION_MESSAGE);
  }

  // §7 step 2 — Contract A + identity read + canAccessClient (pre-transaction).
  const owned = await getOwnClientForUser(input.actor);
  if (!owned) {
    throw new ProposalError('CLIENT_FORBIDDEN', CLIENT_FORBIDDEN_MESSAGE);
  }
  const ownedClientId = owned.clientId;

  const preIdentity = await findClientProfileIdentityForUser(prisma, input.actor.id);
  if (!preIdentity || preIdentity.clientId !== ownedClientId) {
    throw new ProposalError('CLIENT_FORBIDDEN', CLIENT_FORBIDDEN_MESSAGE);
  }

  const access = await canAccessClient(input.actor, ownedClientId);
  if (!access.allowed) {
    throw new ProposalError('CLIENT_FORBIDDEN', CLIENT_FORBIDDEN_MESSAGE);
  }

  try {
    return await runSerializableWithRetry(async (tx) => {
      // §7 step 4 — transaction-local ownership re-validation. One identical
      // generic FORBIDDEN for every mismatch/absence — never confirming a
      // target exists. `canAccessClient` is NOT re-called here.
      const txIdentity = await findClientProfileIdentityForUser(tx, input.actor.id);
      if (!txIdentity || txIdentity.clientId !== ownedClientId) {
        throw new ProposalError('CLIENT_FORBIDDEN', CLIENT_FORBIDDEN_MESSAGE);
      }

      const target = await repository.findProposalVersionOwnershipContext(
        tx,
        input.proposalVersionId,
      );
      if (!target || target.clientId !== ownedClientId) {
        throw new ProposalError('CLIENT_FORBIDDEN', CLIENT_FORBIDDEN_MESSAGE);
      }

      // §7 step 5 — existing-response check first (before current-version).
      const existing = await repository.findProposalAcceptanceForVersion(
        tx,
        input.proposalVersionId,
      );
      if (existing) {
        throw new ProposalError(
          'PROPOSAL_RESPONSE_ALREADY_RECORDED',
          PROPOSAL_RESPONSE_ALREADY_RECORDED_MESSAGE,
        );
      }

      // §7 step 6 — current-visible check.
      const current = await repository.findCurrentClientVisibleVersion(tx, target.proposalId);
      if ((current?.id ?? null) !== input.proposalVersionId) {
        throw target.supersededAt !== null
          ? new ProposalError('PROPOSAL_VERSION_SUPERSEDED', PROPOSAL_VERSION_SUPERSEDED_MESSAGE)
          : new ProposalError('PROPOSAL_VERSION_NOT_CURRENT', PROPOSAL_VERSION_NOT_CURRENT_MESSAGE);
      }

      // §7 step 7 — portal ProposalAcceptance insert (server-generated time).
      const respondedAt = new Date();
      const acceptance = await repository.createPortalProposalAcceptance(tx, {
        proposalVersionId: input.proposalVersionId,
        responseType: input.responseType,
        respondedAt,
        respondingClientProfileId: txIdentity.clientProfileId,
        respondingSessionIdAtResponse: input.sessionId,
      });

      // §7 step 8 — atomic audit in the same transaction.
      await repository.insertAuditLog(tx, {
        actorId: input.actor.id,
        action: PROPOSAL_AUDIT_ACTIONS.PROPOSAL_RESPONSE_RECORDED,
        entityType: PROPOSAL_AUDIT_ENTITY_TYPE.PROPOSAL_VERSION,
        entityId: input.proposalVersionId,
        afterState: sanitizeProposalResponseRecordedSnapshot({
          acceptanceId: acceptance.id,
          responseType: acceptance.responseType,
          respondedAt: acceptance.respondedAt,
        }),
      });

      return { responseType: acceptance.responseType };
    });
  } catch (error) {
    if (isUniqueConflictOn(error, 'proposalVersionId')) {
      throw new ProposalError(
        'PROPOSAL_RESPONSE_ALREADY_RECORDED',
        PROPOSAL_RESPONSE_ALREADY_RECORDED_MESSAGE,
      );
    }
    if (isOtherKnownConflict(error)) {
      throw new ProposalError('PROPOSAL_CONFLICT', PROPOSAL_CONFLICT_MESSAGE);
    }
    throw error;
  }
}
