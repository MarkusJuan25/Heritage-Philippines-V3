import { describe, expect, it } from 'vitest';

import { LeadStatus } from '@/generated/prisma/client';

import { getTransitionOutcome, isReasonRequired, type TransitionOutcome } from './transitions';

const ALL_STATUSES = Object.values(LeadStatus);

// The confirmed matrix (docs/HERITAGE_V3_DECISIONS_LOG.md D-022 §6),
// expressed here independently of transitions.ts's own internal
// representation, so this test doesn't just re-assert the implementation's
// own data structure against itself — mirrors
// features/bookings/transitions.test.ts's discipline exactly.
const EXPECTED: Record<LeadStatus, Partial<Record<LeadStatus, TransitionOutcome>>> = {
  NEW: {
    UNDER_REVIEW: 'ALLOWED',
    CONTACTED: 'ALLOWED',
    CONSULTATION_SCHEDULED: 'ALLOWED',
    QUALIFIED: 'ALLOWED',
    NOT_PROCEEDING: 'ALLOWED',
    DUPLICATE: 'ALLOWED',
    SPAM: 'ALLOWED',
    ARCHIVED: 'ALLOWED',
  },
  UNDER_REVIEW: {
    CONTACTED: 'ALLOWED',
    CONSULTATION_SCHEDULED: 'ALLOWED',
    QUALIFIED: 'ALLOWED',
    NOT_PROCEEDING: 'ALLOWED',
    DUPLICATE: 'ALLOWED',
    SPAM: 'ALLOWED',
    ARCHIVED: 'ALLOWED',
  },
  CONTACTED: {
    CONSULTATION_SCHEDULED: 'ALLOWED',
    QUALIFIED: 'ALLOWED',
    NOT_PROCEEDING: 'ALLOWED',
    DUPLICATE: 'ALLOWED',
    SPAM: 'ALLOWED',
    ARCHIVED: 'ALLOWED',
  },
  CONSULTATION_SCHEDULED: {
    QUALIFIED: 'ALLOWED',
    NOT_PROCEEDING: 'ALLOWED',
    DUPLICATE: 'ALLOWED',
    SPAM: 'ALLOWED',
    ARCHIVED: 'ALLOWED',
  },
  QUALIFIED: {
    CONVERTED_TO_CLIENT: 'DEFERRED_TO_CONVERSION_ENDPOINT',
    NOT_PROCEEDING: 'ALLOWED',
    DUPLICATE: 'ALLOWED',
    SPAM: 'ALLOWED',
    ARCHIVED: 'ALLOWED',
  },
  CONVERTED_TO_CLIENT: {},
  NOT_PROCEEDING: {
    UNDER_REVIEW: 'ALLOWED',
    ARCHIVED: 'ALLOWED',
  },
  DUPLICATE: {
    UNDER_REVIEW: 'ALLOWED',
    ARCHIVED: 'ALLOWED',
  },
  SPAM: {
    UNDER_REVIEW: 'ALLOWED',
    ARCHIVED: 'ALLOWED',
  },
  ARCHIVED: {
    UNDER_REVIEW: 'ALLOWED',
  },
};

const EXPECTED_REASON_REQUIRED: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ['DUPLICATE', 'SPAM'],
  UNDER_REVIEW: ['DUPLICATE', 'SPAM'],
  CONTACTED: ['DUPLICATE', 'SPAM'],
  CONSULTATION_SCHEDULED: ['DUPLICATE', 'SPAM'],
  QUALIFIED: ['DUPLICATE', 'SPAM'],
  CONVERTED_TO_CLIENT: [],
  NOT_PROCEEDING: ['UNDER_REVIEW'],
  DUPLICATE: ['UNDER_REVIEW'],
  SPAM: ['UNDER_REVIEW'],
  ARCHIVED: ['UNDER_REVIEW'],
};

describe('getTransitionOutcome — exhaustive 10x10 matrix', () => {
  for (const current of ALL_STATUSES) {
    for (const next of ALL_STATUSES) {
      const expected: TransitionOutcome = EXPECTED[current][next] ?? 'REJECTED';
      it(`${current} -> ${next} is ${expected}`, () => {
        expect(getTransitionOutcome(current, next)).toBe(expected);
      });
    }
  }
});

describe('isReasonRequired — exhaustive matrix', () => {
  for (const current of ALL_STATUSES) {
    for (const next of ALL_STATUSES) {
      const expected = EXPECTED_REASON_REQUIRED[current].includes(next);
      it(`${current} -> ${next} reason required: ${expected}`, () => {
        expect(isReasonRequired(current, next)).toBe(expected);
      });
    }
  }
});

describe('terminality and special cases', () => {
  it('treats CONVERTED_TO_CLIENT as terminal — every outgoing transition is rejected', () => {
    for (const next of ALL_STATUSES) {
      if (next === 'CONVERTED_TO_CLIENT') continue; // same-status is out of this module's scope
      expect(getTransitionOutcome('CONVERTED_TO_CLIENT', next)).toBe('REJECTED');
    }
  });

  it('never allows a status to transition to itself', () => {
    for (const status of ALL_STATUSES) {
      expect(getTransitionOutcome(status, status)).toBe('REJECTED');
    }
  });

  it('distinguishes QUALIFIED -> CONVERTED_TO_CLIENT (deferred) from every other -> CONVERTED_TO_CLIENT (rejected)', () => {
    expect(getTransitionOutcome('QUALIFIED', 'CONVERTED_TO_CLIENT')).toBe(
      'DEFERRED_TO_CONVERSION_ENDPOINT',
    );
    for (const status of ALL_STATUSES) {
      if (status === 'QUALIFIED' || status === 'CONVERTED_TO_CLIENT') continue;
      expect(getTransitionOutcome(status, 'CONVERTED_TO_CLIENT')).toBe('REJECTED');
    }
  });

  it('does not require a reason for any backward or skip move that is itself rejected', () => {
    expect(isReasonRequired('QUALIFIED', 'UNDER_REVIEW')).toBe(false);
    expect(getTransitionOutcome('QUALIFIED', 'UNDER_REVIEW')).toBe('REJECTED');
  });
});
