import { describe, expect, it } from 'vitest';

import { BookingStatus } from '@/generated/prisma/client';

import { isTransitionAllowed } from './transitions';

const ALL_STATUSES = Object.values(BookingStatus);

// The confirmed matrix (docs/HERITAGE_V3_DECISIONS_LOG.md D-014), expressed
// here independently of transitions.ts's own internal representation, so
// this test doesn't just re-assert the implementation's own data structure
// against itself.
const ALLOWED: Record<BookingStatus, BookingStatus[]> = {
  DRAFT: ['PENDING_CONFIRMATION', 'CANCELLED'],
  PENDING_CONFIRMATION: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PREPARATION', 'CANCELLED'],
  IN_PREPARATION: ['DOCUMENTS_REQUIRED', 'VISA_PROCESSING', 'READY_FOR_TRAVEL', 'CANCELLED'],
  DOCUMENTS_REQUIRED: ['VISA_PROCESSING', 'READY_FOR_TRAVEL', 'CANCELLED'],
  VISA_PROCESSING: ['DOCUMENTS_REQUIRED', 'READY_FOR_TRAVEL', 'CANCELLED'],
  READY_FOR_TRAVEL: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

describe('isTransitionAllowed', () => {
  for (const current of ALL_STATUSES) {
    for (const next of ALL_STATUSES) {
      const expected = ALLOWED[current].includes(next);
      it(`${expected ? 'allows' : 'rejects'} ${current} -> ${next}`, () => {
        expect(isTransitionAllowed(current, next)).toBe(expected);
      });
    }
  }

  it('treats COMPLETED as terminal — every outgoing transition is rejected', () => {
    for (const next of ALL_STATUSES) {
      expect(isTransitionAllowed('COMPLETED', next)).toBe(false);
    }
  });

  it('treats CANCELLED as terminal — every outgoing transition is rejected', () => {
    for (const next of ALL_STATUSES) {
      expect(isTransitionAllowed('CANCELLED', next)).toBe(false);
    }
  });

  it('never allows a status to transition to itself', () => {
    for (const status of ALL_STATUSES) {
      expect(isTransitionAllowed(status, status)).toBe(false);
    }
  });
});
