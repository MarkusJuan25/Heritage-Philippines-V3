import { LeadStatus } from '@/generated/prisma/client';

// The confirmed LeadStatus transition matrix
// (docs/HERITAGE_V3_DECISIONS_LOG.md D-022 §6). Deliberately kept separate
// from repository.ts (.claude/rules/backend.md's "Service-Level Business
// Rules": status-lifecycle transitions are service-layer policy, not
// persistence) — repository.ts only ever writes whatever transition this
// module has already approved.
//
// Same-status is not represented here at all — it is handled by the service
// layer as an idempotent no-op *before* this module is ever consulted
// (service.ts's `updateLeadStatus`, matching D-014's Booking precedent), so
// no status ever lists itself as a valid target.

export type TransitionOutcome = 'ALLOWED' | 'REJECTED' | 'DEFERRED_TO_CONVERSION_ENDPOINT';

// Every allowed target for a given source, excluding CONVERTED_TO_CLIENT —
// QUALIFIED's only legitimate path there is handled as a special case in
// getTransitionOutcome below, distinct from every other REJECTED source.
const TRANSITION_MATRIX: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  [LeadStatus.NEW]: [
    LeadStatus.UNDER_REVIEW,
    LeadStatus.CONTACTED,
    LeadStatus.CONSULTATION_SCHEDULED,
    LeadStatus.QUALIFIED,
    LeadStatus.NOT_PROCEEDING,
    LeadStatus.DUPLICATE,
    LeadStatus.SPAM,
    LeadStatus.ARCHIVED,
  ],
  [LeadStatus.UNDER_REVIEW]: [
    LeadStatus.CONTACTED,
    LeadStatus.CONSULTATION_SCHEDULED,
    LeadStatus.QUALIFIED,
    LeadStatus.NOT_PROCEEDING,
    LeadStatus.DUPLICATE,
    LeadStatus.SPAM,
    LeadStatus.ARCHIVED,
  ],
  [LeadStatus.CONTACTED]: [
    LeadStatus.CONSULTATION_SCHEDULED,
    LeadStatus.QUALIFIED,
    LeadStatus.NOT_PROCEEDING,
    LeadStatus.DUPLICATE,
    LeadStatus.SPAM,
    LeadStatus.ARCHIVED,
  ],
  [LeadStatus.CONSULTATION_SCHEDULED]: [
    LeadStatus.QUALIFIED,
    LeadStatus.NOT_PROCEEDING,
    LeadStatus.DUPLICATE,
    LeadStatus.SPAM,
    LeadStatus.ARCHIVED,
  ],
  [LeadStatus.QUALIFIED]: [
    LeadStatus.NOT_PROCEEDING,
    LeadStatus.DUPLICATE,
    LeadStatus.SPAM,
    LeadStatus.ARCHIVED,
  ],
  [LeadStatus.CONVERTED_TO_CLIENT]: [], // terminal
  [LeadStatus.NOT_PROCEEDING]: [LeadStatus.UNDER_REVIEW, LeadStatus.ARCHIVED],
  [LeadStatus.DUPLICATE]: [LeadStatus.UNDER_REVIEW, LeadStatus.ARCHIVED],
  [LeadStatus.SPAM]: [LeadStatus.UNDER_REVIEW, LeadStatus.ARCHIVED],
  [LeadStatus.ARCHIVED]: [LeadStatus.UNDER_REVIEW],
};

// The active-pipeline->UNDER_REVIEW reopening edges, and every
// active-pipeline-status->DUPLICATE/SPAM edge, require a mandatory reason
// (D-022 §6). Every other ALLOWED transition does not.
const REASON_REQUIRED_MATRIX: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  [LeadStatus.NEW]: [LeadStatus.DUPLICATE, LeadStatus.SPAM],
  [LeadStatus.UNDER_REVIEW]: [LeadStatus.DUPLICATE, LeadStatus.SPAM],
  [LeadStatus.CONTACTED]: [LeadStatus.DUPLICATE, LeadStatus.SPAM],
  [LeadStatus.CONSULTATION_SCHEDULED]: [LeadStatus.DUPLICATE, LeadStatus.SPAM],
  [LeadStatus.QUALIFIED]: [LeadStatus.DUPLICATE, LeadStatus.SPAM],
  [LeadStatus.CONVERTED_TO_CLIENT]: [],
  [LeadStatus.NOT_PROCEEDING]: [LeadStatus.UNDER_REVIEW],
  [LeadStatus.DUPLICATE]: [LeadStatus.UNDER_REVIEW],
  [LeadStatus.SPAM]: [LeadStatus.UNDER_REVIEW],
  [LeadStatus.ARCHIVED]: [LeadStatus.UNDER_REVIEW],
};

/**
 * Whether `current -> next` is ALLOWED, REJECTED, or
 * DEFERRED_TO_CONVERSION_ENDPOINT (D-022 §6). `QUALIFIED -> CONVERTED_TO_CLIENT`
 * is the one deferred cell — the generic status endpoint must return a
 * controlled CONVERSION_ENDPOINT_REQUIRED error for it rather than
 * performing the transition (Lead-to-Client conversion is a future,
 * separate checkpoint). Every other source -> CONVERTED_TO_CLIENT is a
 * plain REJECTED, not deferred: QUALIFIED is the only textually legitimate
 * pre-conversion source.
 */
export function getTransitionOutcome(current: LeadStatus, next: LeadStatus): TransitionOutcome {
  if (current === LeadStatus.QUALIFIED && next === LeadStatus.CONVERTED_TO_CLIENT) {
    return 'DEFERRED_TO_CONVERSION_ENDPOINT';
  }
  return TRANSITION_MATRIX[current].includes(next) ? 'ALLOWED' : 'REJECTED';
}

/** Whether `current -> next` requires a mandatory reason (D-022 §6). */
export function isReasonRequired(current: LeadStatus, next: LeadStatus): boolean {
  return REASON_REQUIRED_MATRIX[current].includes(next);
}
