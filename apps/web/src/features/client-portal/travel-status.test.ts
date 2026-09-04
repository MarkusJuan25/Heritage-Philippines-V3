import { describe, expect, it } from 'vitest';

import type { NonDraftBookingStatus } from '@/features/bookings/service';

import {
  PROGRESS_LINE_SENTENCES,
  deriveTravelStatus,
  progressLineSentence,
  proposalLineSentence,
  type ProgressLineState,
  type ProposalLineState,
  type TravelStatusBookingFacts,
  type TravelStatusProposalFacts,
} from './travel-status';

// Exhaustive verification of the pure D-040 §6 travel-status derivation:
// the twelve first-match `progressLine` rules, the two `proposalLine`
// states plus `null`, the fifteen §6.4 scenario traces, the invariants
// D-040 proves, and the exact client-facing copy (D-040 §§6.1-6.2), which
// is quoted here verbatim and must never be paraphrased.

const ALL_NON_DRAFT_STATUSES: NonDraftBookingStatus[] = [
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'IN_PREPARATION',
  'DOCUMENTS_REQUIRED',
  'VISA_PROCESSING',
  'READY_FOR_TRAVEL',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
];

function byStatus(
  overrides: Partial<Record<NonDraftBookingStatus, number>> = {},
): Record<NonDraftBookingStatus, number> {
  const record = {} as Record<NonDraftBookingStatus, number>;
  for (const status of ALL_NON_DRAFT_STATUSES) {
    record[status] = overrides[status] ?? 0;
  }
  return record;
}

function proposalFacts(
  overrides: Partial<TravelStatusProposalFacts> = {},
): TravelStatusProposalFacts {
  const awaitingResponse = overrides.awaitingResponse ?? 0;
  const accepted = overrides.accepted ?? 0;
  const respondedNonAccept = overrides.respondedNonAccept ?? 0;
  return {
    awaitingResponse,
    accepted,
    acceptedWithoutClientVisibleBooking: overrides.acceptedWithoutClientVisibleBooking ?? 0,
    respondedNonAccept,
    // The D-040 §4 invariant: awaiting + accepted + respondedNonAccept ===
    // currentVisibleTotal. Callers may override it explicitly to test a
    // deliberately-inconsistent input.
    currentVisibleTotal:
      overrides.currentVisibleTotal ?? awaitingResponse + accepted + respondedNonAccept,
  };
}

function bookingFacts(
  overrides: Partial<Record<NonDraftBookingStatus, number>> = {},
): TravelStatusBookingFacts {
  return { byStatus: byStatus(overrides) };
}

const ALL_PROGRESS_STATES: ProgressLineState[] = [
  'BOOKING_PENDING_CONFIRMATION',
  'BOOKING_CONFIRMED',
  'TRIP_IN_PREPARATION',
  'DOCUMENTS_REQUIRED',
  'VISA_IN_PROGRESS',
  'READY_FOR_TRAVEL',
  'TRIP_IN_PROGRESS',
  'PROPOSAL_ACCEPTED_AWAITING_BOOKING',
  'TRIP_COMPLETED',
  'PROPOSAL_IN_REVIEW',
  'NO_ACTIVE_BOOKING',
  'AWAITING_FIRST_PROPOSAL',
];

// --- The fifteen D-040 §6.4 scenario traces ---

type ScenarioTrace = {
  n: number;
  label: string;
  proposal: TravelStatusProposalFacts;
  booking: TravelStatusBookingFacts;
  proposalLine: ProposalLineState | null;
  progressLine: ProgressLineState;
};

const SCENARIOS: ScenarioTrace[] = [
  {
    n: 1,
    label: 'No proposal and no booking',
    proposal: proposalFacts(),
    booking: bookingFacts(),
    proposalLine: null,
    progressLine: 'AWAITING_FIRST_PROPOSAL',
  },
  {
    n: 2,
    label: 'Awaiting proposal and no booking',
    proposal: proposalFacts({ awaitingResponse: 1 }),
    booking: bookingFacts(),
    proposalLine: 'PROPOSALS_AWAITING_YOU',
    progressLine: 'PROPOSAL_IN_REVIEW',
  },
  {
    n: 3,
    label: 'Accepted proposal with no booking',
    proposal: proposalFacts({ accepted: 1, acceptedWithoutClientVisibleBooking: 1 }),
    booking: bookingFacts(),
    proposalLine: null,
    progressLine: 'PROPOSAL_ACCEPTED_AWAITING_BOOKING',
  },
  {
    n: 4,
    label: 'Declined / request-changes proposal with no booking',
    proposal: proposalFacts({ respondedNonAccept: 1 }),
    booking: bookingFacts(),
    proposalLine: 'RESPONSE_RECORDED',
    progressLine: 'NO_ACTIVE_BOOKING',
  },
  {
    n: 5,
    label: 'Pending-confirmation booking',
    proposal: proposalFacts({ accepted: 1 }),
    booking: bookingFacts({ PENDING_CONFIRMATION: 1 }),
    proposalLine: null,
    progressLine: 'BOOKING_PENDING_CONFIRMATION',
  },
  {
    n: 6,
    label: 'Active booking + new awaiting proposal',
    proposal: proposalFacts({ awaitingResponse: 1, accepted: 1 }),
    booking: bookingFacts({ CONFIRMED: 1 }),
    proposalLine: 'PROPOSALS_AWAITING_YOU',
    progressLine: 'BOOKING_CONFIRMED',
  },
  {
    n: 7,
    label: 'Completed historical booking only',
    proposal: proposalFacts({ accepted: 1 }),
    booking: bookingFacts({ COMPLETED: 1 }),
    proposalLine: null,
    progressLine: 'TRIP_COMPLETED',
  },
  {
    n: 8,
    label: 'Completed historical booking + new awaiting proposal',
    proposal: proposalFacts({ awaitingResponse: 1, accepted: 1 }),
    booking: bookingFacts({ COMPLETED: 1 }),
    proposalLine: 'PROPOSALS_AWAITING_YOU',
    progressLine: 'PROPOSAL_IN_REVIEW',
  },
  {
    n: 9,
    label: 'Completed booking + accepted proposal awaiting a new booking',
    proposal: proposalFacts({ accepted: 2, acceptedWithoutClientVisibleBooking: 1 }),
    booking: bookingFacts({ COMPLETED: 1 }),
    proposalLine: null,
    progressLine: 'PROPOSAL_ACCEPTED_AWAITING_BOOKING',
  },
  {
    n: 10,
    label: 'Cancelled booking only',
    proposal: proposalFacts({ accepted: 1 }),
    booking: bookingFacts({ CANCELLED: 1 }),
    proposalLine: null,
    progressLine: 'NO_ACTIVE_BOOKING',
  },
  {
    n: 11,
    label: 'Accepted proposal linked to a cancelled booking',
    proposal: proposalFacts({ accepted: 1 }),
    booking: bookingFacts({ CANCELLED: 1 }),
    proposalLine: null,
    progressLine: 'NO_ACTIVE_BOOKING',
  },
  {
    n: 12,
    label: 'Cancelled booking + new awaiting proposal',
    proposal: proposalFacts({ awaitingResponse: 1, accepted: 1 }),
    booking: bookingFacts({ CANCELLED: 1 }),
    proposalLine: 'PROPOSALS_AWAITING_YOU',
    progressLine: 'PROPOSAL_IN_REVIEW',
  },
  {
    n: 13,
    label: 'Multiple active bookings',
    proposal: proposalFacts({ accepted: 2 }),
    booking: bookingFacts({ PENDING_CONFIRMATION: 1, IN_PREPARATION: 1 }),
    proposalLine: null,
    progressLine: 'TRIP_IN_PREPARATION',
  },
  {
    n: 14,
    label: 'Completed + active booking',
    proposal: proposalFacts({ accepted: 2 }),
    booking: bookingFacts({ COMPLETED: 1, CONFIRMED: 1 }),
    proposalLine: null,
    progressLine: 'BOOKING_CONFIRMED',
  },
  {
    n: 15,
    label: 'Accepted current-visible proposal + associated DRAFT booking',
    proposal: proposalFacts({ accepted: 1, acceptedWithoutClientVisibleBooking: 1 }),
    booking: bookingFacts(),
    proposalLine: null,
    progressLine: 'PROPOSAL_ACCEPTED_AWAITING_BOOKING',
  },
];

describe('deriveTravelStatus — the fifteen D-040 §6.4 scenario traces', () => {
  for (const scenario of SCENARIOS) {
    it(`scenario ${scenario.n}: ${scenario.label}`, () => {
      const result = deriveTravelStatus(scenario.proposal, scenario.booking);
      expect(result.proposalLine).toBe(scenario.proposalLine);
      expect(result.progressLine).toBe(scenario.progressLine);
    });
  }

  it('scenario 15 resolves the accepted-plus-DRAFT input to PROPOSAL_ACCEPTED_AWAITING_BOOKING, never AWAITING_FIRST_PROPOSAL', () => {
    const result = deriveTravelStatus(SCENARIOS[14]!.proposal, SCENARIOS[14]!.booking);
    expect(result.progressLine).toBe('PROPOSAL_ACCEPTED_AWAITING_BOOKING');
    expect(result.progressLine).not.toBe('AWAITING_FIRST_PROPOSAL');
  });

  it('every scenario satisfies the D-040 §4 count invariants', () => {
    for (const scenario of SCENARIOS) {
      const f = scenario.proposal;
      expect(f.awaitingResponse + f.accepted + f.respondedNonAccept).toBe(f.currentVisibleTotal);
      expect(f.acceptedWithoutClientVisibleBooking).toBeGreaterThanOrEqual(0);
      expect(f.acceptedWithoutClientVisibleBooking).toBeLessThanOrEqual(f.accepted);
    }
  });
});

describe('deriveProgressLine — the twelve first-match rules at their predicate boundary', () => {
  it('rule 1: BOOKING_PENDING_CONFIRMATION when the only active peak is PENDING_CONFIRMATION', () => {
    expect(
      deriveTravelStatus(proposalFacts({ accepted: 1 }), bookingFacts({ PENDING_CONFIRMATION: 2 }))
        .progressLine,
    ).toBe('BOOKING_PENDING_CONFIRMATION');
  });

  it('rules 2-7: peak precedence — the most advanced active status wins', () => {
    const cases: [NonDraftBookingStatus, ProgressLineState][] = [
      ['CONFIRMED', 'BOOKING_CONFIRMED'],
      ['IN_PREPARATION', 'TRIP_IN_PREPARATION'],
      ['DOCUMENTS_REQUIRED', 'DOCUMENTS_REQUIRED'],
      ['VISA_PROCESSING', 'VISA_IN_PROGRESS'],
      ['READY_FOR_TRAVEL', 'READY_FOR_TRAVEL'],
      ['IN_PROGRESS', 'TRIP_IN_PROGRESS'],
    ];
    for (const [status, expected] of cases) {
      // A lower-ordinal active booking is also present — the higher peak
      // must still win.
      expect(
        deriveTravelStatus(
          proposalFacts({ accepted: 2 }),
          bookingFacts({ PENDING_CONFIRMATION: 1, [status]: 1 }),
        ).progressLine,
      ).toBe(expected);
    }
  });

  it('rule 8: PROPOSAL_ACCEPTED_AWAITING_BOOKING only when activeCount === 0 and acwcvb > 0', () => {
    expect(
      deriveTravelStatus(
        proposalFacts({ accepted: 1, acceptedWithoutClientVisibleBooking: 1 }),
        bookingFacts(),
      ).progressLine,
    ).toBe('PROPOSAL_ACCEPTED_AWAITING_BOOKING');

    // acwcvb > 0 but an active booking exists — peak precedence (rules 1-7)
    // wins over rule 8.
    expect(
      deriveTravelStatus(
        proposalFacts({ accepted: 2, acceptedWithoutClientVisibleBooking: 1 }),
        bookingFacts({ CONFIRMED: 1 }),
      ).progressLine,
    ).toBe('BOOKING_CONFIRMED');

    // acwcvb === 0 — rule 8 does not fire.
    expect(
      deriveTravelStatus(proposalFacts({ accepted: 1 }), bookingFacts()).progressLine,
    ).not.toBe('PROPOSAL_ACCEPTED_AWAITING_BOOKING');
  });

  it('rule 9: TRIP_COMPLETED requires completedCount > 0 and awaitingResponse === 0; never fires when awaitingResponse > 0', () => {
    expect(
      deriveTravelStatus(proposalFacts({ accepted: 1 }), bookingFacts({ COMPLETED: 1 }))
        .progressLine,
    ).toBe('TRIP_COMPLETED');

    expect(
      deriveTravelStatus(
        proposalFacts({ awaitingResponse: 1, accepted: 1 }),
        bookingFacts({ COMPLETED: 1 }),
      ).progressLine,
    ).toBe('PROPOSAL_IN_REVIEW');
  });

  it('rule 10: PROPOSAL_IN_REVIEW requires awaitingResponse > 0 (and activeCount === 0, acwcvb === 0); never fires when awaitingResponse === 0', () => {
    expect(
      deriveTravelStatus(proposalFacts({ awaitingResponse: 1 }), bookingFacts()).progressLine,
    ).toBe('PROPOSAL_IN_REVIEW');

    for (const bookings of [
      bookingFacts(),
      bookingFacts({ CANCELLED: 1 }),
      bookingFacts({ COMPLETED: 1 }),
    ]) {
      expect(deriveTravelStatus(proposalFacts({ accepted: 1 }), bookings).progressLine).not.toBe(
        'PROPOSAL_IN_REVIEW',
      );
    }
  });

  it('rule 11: NO_ACTIVE_BOOKING when only a cancelled booking or only a non-accept response remains', () => {
    expect(
      deriveTravelStatus(proposalFacts({ accepted: 1 }), bookingFacts({ CANCELLED: 1 }))
        .progressLine,
    ).toBe('NO_ACTIVE_BOOKING');
    expect(
      deriveTravelStatus(proposalFacts({ respondedNonAccept: 1 }), bookingFacts()).progressLine,
    ).toBe('NO_ACTIVE_BOOKING');
    // A completed trip outranks NO_ACTIVE_BOOKING (rule 9 before rule 11).
    expect(
      deriveTravelStatus(
        proposalFacts({ accepted: 2 }),
        bookingFacts({ COMPLETED: 1, CANCELLED: 1 }),
      ).progressLine,
    ).toBe('TRIP_COMPLETED');
  });

  it('rule 12: AWAITING_FIRST_PROPOSAL when everything is zero', () => {
    expect(deriveTravelStatus(proposalFacts(), bookingFacts()).progressLine).toBe(
      'AWAITING_FIRST_PROPOSAL',
    );
  });

  it('progressLine is always exactly one of the twelve states (never null) across a wide input matrix', () => {
    const counts = [0, 1, 2];
    for (const aw of counts) {
      for (const acc of counts) {
        for (const acwcvb of [0, 1]) {
          for (const rNA of counts) {
            for (const status of [...ALL_NON_DRAFT_STATUSES, null]) {
              const bookings = status ? bookingFacts({ [status]: 1 }) : bookingFacts();
              const result = deriveTravelStatus(
                proposalFacts({
                  awaitingResponse: aw,
                  accepted: acc,
                  acceptedWithoutClientVisibleBooking: Math.min(acwcvb, acc),
                  respondedNonAccept: rNA,
                }),
                bookings,
              );
              expect(ALL_PROGRESS_STATES).toContain(result.progressLine);
            }
          }
        }
      }
    }
  });

  it('AWAITING_FIRST_PROPOSAL is only ever returned for an input whose currentVisibleTotal is 0 (D-040 §6.3 proof)', () => {
    // Each realistic per-proposal outcome the data layer can actually
    // produce — a current-client-visible ProposalVersion plus its booking
    // association, aggregated the way Contracts B and D aggregate real
    // rows. Every outcome that increments `accepted` also leaves booking
    // evidence somewhere (acwcvb, or one of the byStatus buckets), exactly
    // the premise D-040 §6.3's proof relies on.
    type Outcome = (facts: {
      awaitingResponse: number;
      accepted: number;
      acceptedWithoutClientVisibleBooking: number;
      respondedNonAccept: number;
      byStatus: Record<NonDraftBookingStatus, number>;
    }) => void;

    const outcomes: Outcome[] = [
      (f) => {
        f.awaitingResponse += 1;
      },
      (f) => {
        f.respondedNonAccept += 1;
      },
      (f) => {
        f.accepted += 1;
        f.acceptedWithoutClientVisibleBooking += 1; // ACCEPT + no booking OR DRAFT booking
      },
      (f) => {
        f.accepted += 1;
        f.byStatus.PENDING_CONFIRMATION += 1; // ACCEPT + active booking
      },
      (f) => {
        f.accepted += 1;
        f.byStatus.IN_PROGRESS += 1;
      },
      (f) => {
        f.accepted += 1;
        f.byStatus.COMPLETED += 1;
      },
      (f) => {
        f.accepted += 1;
        f.byStatus.CANCELLED += 1;
      },
    ];

    const buildCombo = (combo: number[]) => {
      const f = {
        awaitingResponse: 0,
        accepted: 0,
        acceptedWithoutClientVisibleBooking: 0,
        respondedNonAccept: 0,
        byStatus: byStatus(),
      };
      for (const idx of combo) {
        outcomes[idx]!(f);
      }
      const facts: TravelStatusProposalFacts = {
        awaitingResponse: f.awaitingResponse,
        accepted: f.accepted,
        acceptedWithoutClientVisibleBooking: f.acceptedWithoutClientVisibleBooking,
        respondedNonAccept: f.respondedNonAccept,
        currentVisibleTotal: f.awaitingResponse + f.accepted + f.respondedNonAccept,
      };
      return { facts, booking: { byStatus: f.byStatus } as TravelStatusBookingFacts };
    };

    // 0, 1, 2, and 3 outcomes.
    const combos: number[][] = [[]];
    for (const a of outcomes.keys()) {
      combos.push([a]);
      for (const b of outcomes.keys()) {
        combos.push([a, b]);
        for (const c of outcomes.keys()) {
          combos.push([a, b, c]);
        }
      }
    }

    for (const combo of combos) {
      const { facts, booking } = buildCombo(combo);
      if (deriveTravelStatus(facts, booking).progressLine === 'AWAITING_FIRST_PROPOSAL') {
        expect(facts.currentVisibleTotal).toBe(0);
      }
    }
  });
});

describe('deriveProposalLine — the three D-040 §6.1 states', () => {
  it('PROPOSALS_AWAITING_YOU whenever awaitingResponse > 0, regardless of progressLine', () => {
    expect(
      deriveTravelStatus(proposalFacts({ awaitingResponse: 1 }), bookingFacts()).proposalLine,
    ).toBe('PROPOSALS_AWAITING_YOU');
    expect(
      deriveTravelStatus(
        proposalFacts({ awaitingResponse: 2, accepted: 1 }),
        bookingFacts({ CONFIRMED: 1 }),
      ).proposalLine,
    ).toBe('PROPOSALS_AWAITING_YOU');
  });

  it('RESPONSE_RECORDED only when awaitingResponse === 0 and respondedNonAccept > 0', () => {
    expect(
      deriveTravelStatus(proposalFacts({ respondedNonAccept: 1 }), bookingFacts()).proposalLine,
    ).toBe('RESPONSE_RECORDED');
    expect(
      deriveTravelStatus(
        proposalFacts({ awaitingResponse: 1, respondedNonAccept: 1 }),
        bookingFacts(),
      ).proposalLine,
    ).toBe('PROPOSALS_AWAITING_YOU');
  });

  it('null when awaitingResponse === 0 and respondedNonAccept === 0', () => {
    expect(
      deriveTravelStatus(proposalFacts({ accepted: 1 }), bookingFacts({ CONFIRMED: 1 }))
        .proposalLine,
    ).toBeNull();
  });
});

describe('exact client-facing copy (D-040 §§6.1-6.2, verbatim)', () => {
  it('progressLine sentences match D-040 §6.2 exactly', () => {
    expect(PROGRESS_LINE_SENTENCES).toEqual({
      BOOKING_PENDING_CONFIRMATION: 'At least one booking is awaiting confirmation by our team.',
      BOOKING_CONFIRMED: 'At least one booking is confirmed.',
      TRIP_IN_PREPARATION: 'At least one trip is being prepared.',
      DOCUMENTS_REQUIRED: 'At least one trip needs documents.',
      VISA_IN_PROGRESS: 'At least one trip has visa processing underway.',
      READY_FOR_TRAVEL: 'At least one trip is ready for travel.',
      TRIP_IN_PROGRESS: 'At least one trip is underway.',
      PROPOSAL_ACCEPTED_AWAITING_BOOKING:
        "You've accepted a proposal — we're setting up your booking.",
      TRIP_COMPLETED: 'You have a completed trip in your travel history.',
      PROPOSAL_IN_REVIEW: "You're at the proposal-review stage.",
      NO_ACTIVE_BOOKING:
        "You don't have an active booking right now. Your travel consultant can help with next steps.",
      AWAITING_FIRST_PROPOSAL: "We're preparing your first proposal.",
    });
    for (const state of ALL_PROGRESS_STATES) {
      expect(progressLineSentence(state)).toBe(PROGRESS_LINE_SENTENCES[state]);
    }
  });

  it('the seven active-booking sentences all begin "At least one" and stay true when the peak is not shared by every booking', () => {
    const activeStates: ProgressLineState[] = [
      'BOOKING_PENDING_CONFIRMATION',
      'BOOKING_CONFIRMED',
      'TRIP_IN_PREPARATION',
      'DOCUMENTS_REQUIRED',
      'VISA_IN_PROGRESS',
      'READY_FOR_TRAVEL',
      'TRIP_IN_PROGRESS',
    ];
    for (const state of activeStates) {
      expect(PROGRESS_LINE_SENTENCES[state].startsWith('At least one ')).toBe(true);
    }
    // A two-booking portfolio whose peak (IN_PREPARATION) is not shared by
    // the other booking (PENDING_CONFIRMATION) — the "At least one" wording
    // is still truthful.
    const result = deriveTravelStatus(
      proposalFacts({ accepted: 2 }),
      bookingFacts({ PENDING_CONFIRMATION: 1, IN_PREPARATION: 1 }),
    );
    expect(result.progressLine).toBe('TRIP_IN_PREPARATION');
    expect(progressLineSentence(result.progressLine)).toBe('At least one trip is being prepared.');
  });

  it('TRIP_COMPLETED carries no recency claim', () => {
    const sentence = PROGRESS_LINE_SENTENCES.TRIP_COMPLETED;
    expect(sentence).toBe('You have a completed trip in your travel history.');
    for (const forbidden of ['most recent', 'latest', ' last ', 'recently']) {
      expect(sentence.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('NO_ACTIVE_BOOKING carries the approved copy and no future-action promise or "nothing needs your attention"', () => {
    const sentence = PROGRESS_LINE_SENTENCES.NO_ACTIVE_BOOKING;
    expect(sentence).toBe(
      "You don't have an active booking right now. Your travel consultant can help with next steps.",
    );
    expect(sentence.toLowerCase()).not.toContain('nothing needs your attention');
    expect(sentence.toLowerCase()).not.toContain('will be in touch');
  });

  it('proposalLine sentences interpolate the exact count with correct singular/plural', () => {
    expect(proposalLineSentence('PROPOSALS_AWAITING_YOU', { awaitingResponse: 1 })).toBe(
      'You have 1 proposal waiting for your response.',
    );
    expect(proposalLineSentence('PROPOSALS_AWAITING_YOU', { awaitingResponse: 3 })).toBe(
      'You have 3 proposals waiting for your response.',
    );
    expect(proposalLineSentence('RESPONSE_RECORDED', { awaitingResponse: 0 })).toBe(
      "We've recorded your response to your proposal.",
    );
  });

  it('proposalLine and progressLine never resolve to the same sentence for any scenario', () => {
    for (const scenario of SCENARIOS) {
      const result = deriveTravelStatus(scenario.proposal, scenario.booking);
      if (result.proposalLine !== null) {
        expect(proposalLineSentence(result.proposalLine, scenario.proposal)).not.toBe(
          progressLineSentence(result.progressLine),
        );
      }
    }
  });
});
