import { ProposalResponseType } from '@/generated/prisma/client';

// Action names written to AuditLog.action (blueprint Section 14.9;
// .claude/rules/backend.md's Auditability rule; D-027 §9). This file
// defines audit metadata shapes and sanitizers only — no database insertion
// exists yet (a later, repository-layer stage of this checkpoint); mirrors
// features/bookings/audit.ts's/features/assignments/audit.ts's identical
// scope split between "what an audit entry looks like" (this file) and "how
// it gets written" (repository.ts, not yet implemented).
export const PROPOSAL_AUDIT_ACTIONS = {
  PROPOSAL_CREATED: 'PROPOSAL_CREATED',
  PROPOSAL_VERSION_CREATED: 'PROPOSAL_VERSION_CREATED',
  PROPOSAL_VERSION_PUBLISHED: 'PROPOSAL_VERSION_PUBLISHED',
  PROPOSAL_RESPONSE_RECORDED: 'PROPOSAL_RESPONSE_RECORDED',
} as const;

// D-027 §9: entity type `Proposal` for `PROPOSAL_CREATED`; `ProposalVersion`
// for the other three (for `PROPOSAL_RESPONSE_RECORDED`, "identifying the
// version the response was recorded against" — never the ProposalAcceptance
// row itself, which has no AuditLog entity type of its own).
export const PROPOSAL_AUDIT_ENTITY_TYPE = {
  PROPOSAL: 'Proposal',
  PROPOSAL_VERSION: 'ProposalVersion',
} as const;

export type ProposalCreatedSnapshot = {
  clientId: string;
  firstVersionId: string;
  firstVersionNumber: number;
};

/**
 * Builds the AuditLog.afterState snapshot for a newly created Proposal
 * (D-027 §9; `entityId` is the Proposal's own id, so it is not repeated
 * here). An explicit allow-list — it never includes `content` (D-027 §9's
 * absolute rule: no snapshot ever contains a ProposalVersion's authored
 * content) or any Client business field (fullName, email, phone, etc.),
 * only the linked Client's id and the identity of the first
 * ProposalVersion this same request created.
 */
export function sanitizeProposalCreatedSnapshot(input: {
  clientId: string;
  firstVersionId: string;
  firstVersionNumber: number;
}): ProposalCreatedSnapshot {
  return {
    clientId: input.clientId,
    firstVersionId: input.firstVersionId,
    firstVersionNumber: input.firstVersionNumber,
  };
}

export type ProposalVersionCreatedSnapshot = {
  proposalId: string;
  versionNumber: number;
};

/**
 * Builds the AuditLog.afterState snapshot for a new ProposalVersion
 * (revision) (D-027 §9; `entityId` is the new version's own id, so it is
 * not repeated here). Never includes `content`, or `createdByUserId` —
 * the latter is redundant with the AuditLog row's own `actorId`, mirroring
 * features/assignments/audit.ts's `createdAt`/`updatedAt` omission
 * rationale.
 */
export function sanitizeProposalVersionCreatedSnapshot(input: {
  proposalId: string;
  versionNumber: number;
}): ProposalVersionCreatedSnapshot {
  return {
    proposalId: input.proposalId,
    versionNumber: input.versionNumber,
  };
}

export type ProposalVersionPublishedSnapshot = {
  proposalId: string;
  versionNumber: number;
  previousCurrentVersionId: string | null;
};

/**
 * Builds the AuditLog.afterState snapshot for a publish (D-027 §5/§9;
 * `entityId` is the newly published version's own id, so it is not
 * repeated here). `previousCurrentVersionId` is the concurrency/lifecycle
 * fact D-027 §9 explicitly authorizes recording — the version (if any)
 * this publish superseded, i.e. what the caller's own
 * `expectedCurrentVersionId` was validated against — never the superseded
 * version's own `content`.
 */
export function sanitizeProposalVersionPublishedSnapshot(input: {
  proposalId: string;
  versionNumber: number;
  previousCurrentVersionId: string | null;
}): ProposalVersionPublishedSnapshot {
  return {
    proposalId: input.proposalId,
    versionNumber: input.versionNumber,
    previousCurrentVersionId: input.previousCurrentVersionId,
  };
}

export type ProposalResponseRecordedSnapshot = {
  acceptanceId: string;
  responseType: ProposalResponseType;
  respondedAt: string;
};

/**
 * Builds the AuditLog.afterState snapshot for a Section 9.1 externally
 * recorded response (D-027 §4/§9; `entityId` is the responded-to
 * ProposalVersion's own id, so it is not repeated here). Deliberately
 * excludes `responseMethod`, `evidenceReference`, and
 * `recordedByStaffUserId`: the latter is redundant with the AuditLog row's
 * own `actorId`; `responseMethod`/`evidenceReference` are staff-authored
 * free text D-027 §9 does not explicitly name as approved audit metadata
 * (unlike, e.g., D-022 §7's explicit approval of a Lead status-transition
 * `reason`), so this sanitizer takes the more conservative, data-minimal
 * reading and omits them — only the closed `responseType` enum value and
 * the client's stated `respondedAt` timestamp (a lifecycle/response value,
 * not free text) are recorded, alongside the new ProposalAcceptance row's
 * own id. `respondedAt` is serialized to an ISO string because AuditLog's
 * beforeState/afterState columns are JSON, which cannot hold a raw `Date`
 * — mirrors features/assignments/audit.ts's `sanitizeAssignmentSnapshot`'s
 * identical `endedAt` serialization.
 */
export function sanitizeProposalResponseRecordedSnapshot(input: {
  acceptanceId: string;
  responseType: ProposalResponseType;
  respondedAt: Date;
}): ProposalResponseRecordedSnapshot {
  return {
    acceptanceId: input.acceptanceId,
    responseType: input.responseType,
    respondedAt: input.respondedAt.toISOString(),
  };
}
