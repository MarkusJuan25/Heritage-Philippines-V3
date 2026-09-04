import type { NonDraftBookingStatus } from '@/features/bookings/service';

// The pure, portfolio-level travel-status derivation for the Client Home /
// Overview (docs/HERITAGE_V3_DECISIONS_LOG.md D-040 §6). No I/O, no Prisma,
// no feature imports beyond the `NonDraftBookingStatus` *type* — this module
// is a deterministic function of the two fact bundles Contracts B and D
// (D-040 §§3-5) produce, and nothing else. Every client-facing sentence
// here is quoted verbatim from D-040 §§6.1-6.2 and must never be
// paraphrased.
//
// The surface is a portfolio summary — "Your travel status" — not a claim
// about a single current journey: a client may simultaneously hold a
// completed trip and a brand-new proposal, and this function reports both
// lines without implying one supersedes the other (D-040 §6).

export type ProposalLineState = 'PROPOSALS_AWAITING_YOU' | 'RESPONSE_RECORDED';

export type ProgressLineState =
  | 'BOOKING_PENDING_CONFIRMATION'
  | 'BOOKING_CONFIRMED'
  | 'TRIP_IN_PREPARATION'
  | 'DOCUMENTS_REQUIRED'
  | 'VISA_IN_PROGRESS'
  | 'READY_FOR_TRAVEL'
  | 'TRIP_IN_PROGRESS'
  | 'PROPOSAL_ACCEPTED_AWAITING_BOOKING'
  | 'TRIP_COMPLETED'
  | 'PROPOSAL_IN_REVIEW'
  | 'NO_ACTIVE_BOOKING'
  | 'AWAITING_FIRST_PROPOSAL';

// The five complete-dataset proposal facts from Contract B (D-040 §4).
// `acceptedWithoutClientVisibleBooking` counts a current-client-visible
// ACCEPT version whose associated booking is null OR has `status = DRAFT`
// (D-040 §4) — from the client's perspective, an accepted proposal still
// awaiting a booking.
export type TravelStatusProposalFacts = {
  currentVisibleTotal: number;
  awaitingResponse: number;
  accepted: number;
  acceptedWithoutClientVisibleBooking: number;
  respondedNonAccept: number;
};

// The non-DRAFT booking aggregate from Contract D (D-040 §5) — a
// fixed-cardinality nine-key record; DRAFT is excluded entirely.
export type TravelStatusBookingFacts = {
  byStatus: Record<NonDraftBookingStatus, number>;
};

export type TravelStatus = {
  proposalLine: ProposalLineState | null;
  progressLine: ProgressLineState;
};

// D-040 §6: the active-booking peak-precedence ladder. A booking in one of
// these seven statuses is "active"; the most advanced active booking drives
// `progressLine` (rules 1-7). COMPLETED and CANCELLED are deliberately not
// here — they are handled by their own counts below.
const ACTIVE_ORDINAL: Record<string, number> = {
  PENDING_CONFIRMATION: 1,
  CONFIRMED: 2,
  IN_PREPARATION: 3,
  DOCUMENTS_REQUIRED: 4,
  VISA_PROCESSING: 5,
  READY_FOR_TRAVEL: 6,
  IN_PROGRESS: 7,
};

// Verbatim from D-040 §6.2 — never paraphrased, never given a recency claim,
// never "nothing needs your attention", never a future-action promise. The
// seven active-booking sentences all begin "At least one" so a peak status
// not shared by every booking is never misreported as universal
// (D-040 §6.2's portfolio-safe wording).
export const PROGRESS_LINE_SENTENCES: Record<ProgressLineState, string> = {
  BOOKING_PENDING_CONFIRMATION: 'At least one booking is awaiting confirmation by our team.',
  BOOKING_CONFIRMED: 'At least one booking is confirmed.',
  TRIP_IN_PREPARATION: 'At least one trip is being prepared.',
  DOCUMENTS_REQUIRED: 'At least one trip needs documents.',
  VISA_IN_PROGRESS: 'At least one trip has visa processing underway.',
  READY_FOR_TRAVEL: 'At least one trip is ready for travel.',
  TRIP_IN_PROGRESS: 'At least one trip is underway.',
  PROPOSAL_ACCEPTED_AWAITING_BOOKING: "You've accepted a proposal — we're setting up your booking.",
  TRIP_COMPLETED: 'You have a completed trip in your travel history.',
  PROPOSAL_IN_REVIEW: "You're at the proposal-review stage.",
  NO_ACTIVE_BOOKING:
    "You don't have an active booking right now. Your travel consultant can help with next steps.",
  AWAITING_FIRST_PROPOSAL: "We're preparing your first proposal.",
};

/**
 * The `proposalLine` sentence for a resolved state (D-040 §6.1).
 * `PROPOSALS_AWAITING_YOU` interpolates the exact count, with the singular
 * noun only when `awaitingResponse === 1`.
 */
export function proposalLineSentence(
  state: ProposalLineState,
  facts: Pick<TravelStatusProposalFacts, 'awaitingResponse'>,
): string {
  switch (state) {
    case 'PROPOSALS_AWAITING_YOU': {
      const noun = facts.awaitingResponse === 1 ? 'proposal' : 'proposals';
      return `You have ${facts.awaitingResponse} ${noun} waiting for your response.`;
    }
    case 'RESPONSE_RECORDED':
      return "We've recorded your response to your proposal.";
  }
}

/** The `progressLine` sentence for a resolved state (D-040 §6.2). */
export function progressLineSentence(state: ProgressLineState): string {
  return PROGRESS_LINE_SENTENCES[state];
}

/**
 * D-040 §6.1: `proposalLine` is independent of `progressLine`. It reports
 * the currently relevant proposal state, which is not always a required
 * client action — hence "proposalLine", never "actionLine".
 */
function deriveProposalLine(facts: TravelStatusProposalFacts): ProposalLineState | null {
  if (facts.awaitingResponse > 0) {
    return 'PROPOSALS_AWAITING_YOU';
  }
  if (facts.respondedNonAccept > 0) {
    return 'RESPONSE_RECORDED';
  }
  return null;
}

/**
 * D-040 §6.2: twelve first-match rules, total — always exactly one. Rules
 * 1-7 preserve active-booking peak precedence. Rule 12
 * (`AWAITING_FIRST_PROPOSAL`) is the guaranteed fall-through once rules 1-11
 * have each failed: D-040 §6.3 proves that reaching it forces
 * `activeCount === 0 && acceptedWithoutClientVisibleBooking === 0 &&
 * awaitingResponse === 0 && completedCount === 0 && cancelledCount === 0 &&
 * respondedNonAccept === 0`, which is exactly rule 12's own predicate, and
 * further that this implies `currentVisibleTotal === 0`.
 */
function deriveProgressLine(
  proposalFacts: TravelStatusProposalFacts,
  bookingFacts: TravelStatusBookingFacts,
): ProgressLineState {
  const byStatus = bookingFacts.byStatus as Record<string, number>;

  let activeCount = 0;
  let peakActiveOrdinal = 0;
  for (const [status, ordinal] of Object.entries(ACTIVE_ORDINAL)) {
    const count = byStatus[status] ?? 0;
    if (count > 0) {
      activeCount += count;
      if (ordinal > peakActiveOrdinal) {
        peakActiveOrdinal = ordinal;
      }
    }
  }

  const completedCount = byStatus.COMPLETED ?? 0;
  const cancelledCount = byStatus.CANCELLED ?? 0;
  const { awaitingResponse, acceptedWithoutClientVisibleBooking: acwcvb } = proposalFacts;

  // Rules 1-7: the most advanced active booking wins.
  if (activeCount > 0) {
    switch (peakActiveOrdinal) {
      case 1:
        return 'BOOKING_PENDING_CONFIRMATION';
      case 2:
        return 'BOOKING_CONFIRMED';
      case 3:
        return 'TRIP_IN_PREPARATION';
      case 4:
        return 'DOCUMENTS_REQUIRED';
      case 5:
        return 'VISA_IN_PROGRESS';
      case 6:
        return 'READY_FOR_TRAVEL';
      case 7:
        return 'TRIP_IN_PROGRESS';
    }
  }

  // Rule 8.
  if (acwcvb > 0) {
    return 'PROPOSAL_ACCEPTED_AWAITING_BOOKING';
  }
  // Rule 9.
  if (completedCount > 0 && awaitingResponse === 0) {
    return 'TRIP_COMPLETED';
  }
  // Rule 10.
  if (awaitingResponse > 0) {
    return 'PROPOSAL_IN_REVIEW';
  }
  // Rule 11.
  if (completedCount === 0 && (cancelledCount > 0 || proposalFacts.respondedNonAccept > 0)) {
    return 'NO_ACTIVE_BOOKING';
  }
  // Rule 12 — guaranteed fall-through (D-040 §6.3).
  return 'AWAITING_FIRST_PROPOSAL';
}

/**
 * The complete D-040 §6 derivation. Returns only the two resolved states;
 * the composition layer (`getClientOverview`) pairs each with its exact
 * client-facing sentence via `proposalLineSentence` / `progressLineSentence`.
 */
export function deriveTravelStatus(
  proposalFacts: TravelStatusProposalFacts,
  bookingFacts: TravelStatusBookingFacts,
): TravelStatus {
  return {
    proposalLine: deriveProposalLine(proposalFacts),
    progressLine: deriveProgressLine(proposalFacts, bookingFacts),
  };
}
