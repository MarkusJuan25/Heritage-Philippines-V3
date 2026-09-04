import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ClientOverview,
  ClientOverviewBookingPreviewItem,
  ClientOverviewProposalPreviewItem,
} from './schemas';

// `schemas.ts` is types-only (D-040 §3 — this feature accepts no request
// input). These checks lock the id-free, data-minimized shape of the
// overview render DTO (D-040 §8): `expectTypeOf` equality assertions fail if
// any extra key (e.g. a database id) is ever added to a preview item, and a
// runtime scan of a representative value proves no server-only identifier
// key appears at any depth.

describe('ClientOverview DTO shape (D-040 §8)', () => {
  it('exposes exactly the five top-level sections', () => {
    expectTypeOf<keyof ClientOverview>().toEqualTypeOf<
      'identity' | 'proposals' | 'bookings' | 'travelStatus' | 'consultant'
    >();
  });

  it('the identity card is fullName / email / phone only', () => {
    expectTypeOf<ClientOverview['identity']>().toEqualTypeOf<{
      fullName: string;
      email: string | null;
      phone: string | null;
    }>();
  });

  it('a proposal preview item is versionNumber + statusLabel only — no id, no content', () => {
    expectTypeOf<ClientOverviewProposalPreviewItem>().toEqualTypeOf<{
      versionNumber: number;
      statusLabel: string;
    }>();
  });

  it('a booking preview item carries bookingReference and only the D-040 §5 allow-list — no database id or forbidden field', () => {
    expectTypeOf<keyof ClientOverviewBookingPreviewItem>().toEqualTypeOf<
      | 'bookingReference'
      | 'statusLabel'
      | 'travelStartDate'
      | 'travelEndDate'
      | 'destination'
      | 'tourPackageName'
    >();
  });

  it('a representative value contains no server-only identifier key at any depth, but keeps bookingReference', () => {
    const sample: ClientOverview = {
      identity: { fullName: 'Sample Client', email: 'sample@example.test', phone: null },
      proposals: {
        currentVisibleTotal: 1,
        preview: [{ versionNumber: 1, statusLabel: 'Accepted' }],
      },
      bookings: {
        total: 1,
        byStatus: {
          PENDING_CONFIRMATION: 1,
          CONFIRMED: 0,
          IN_PREPARATION: 0,
          DOCUMENTS_REQUIRED: 0,
          VISA_PROCESSING: 0,
          READY_FOR_TRAVEL: 0,
          IN_PROGRESS: 0,
          COMPLETED: 0,
          CANCELLED: 0,
        },
        preview: [
          {
            bookingReference: 'HPB-ABCDEF0123456789ABCD',
            statusLabel: 'Pending confirmation',
            travelStartDate: null,
            travelEndDate: null,
            destination: null,
            tourPackageName: null,
          },
        ],
      },
      travelStatus: {
        proposalLine: null,
        progressLine: {
          state: 'BOOKING_PENDING_CONFIRMATION',
          sentence: 'At least one booking is awaiting confirmation by our team.',
        },
      },
      consultant: { name: 'Sample Consultant' },
    };

    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          walk(nested);
        }
      }
    };
    walk(sample);

    for (const forbidden of [
      'id',
      'clientId',
      'userId',
      'clientProfileId',
      'proposalId',
      'proposalVersionId',
      'versionId',
      'bookingId',
      'invitationId',
      'internalNotes',
      'clientVisibleNotes',
      'totalAmount',
      'currencyCode',
      'travelerCount',
      'content',
      'normalizedEmail',
      'normalizedPhone',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(keys.has('bookingReference')).toBe(true);
  });
});
