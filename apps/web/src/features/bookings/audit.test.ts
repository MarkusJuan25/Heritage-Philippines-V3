import { describe, expect, it } from 'vitest';

import { sanitizeBookingSnapshot } from './audit';

describe('sanitizeBookingSnapshot', () => {
  it('picks only the five allow-listed fields, never spreading the source record', () => {
    const record = {
      id: 'booking-1',
      bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD',
      clientId: 'client-1',
      proposalVersionId: 'pv-1',
      status: 'DRAFT',
      // Fields that must never leak into an audit snapshot:
      internalNotes: 'sensitive staff commentary',
      clientVisibleNotes: 'client-visible text',
      destination: 'Palawan',
      travelerCount: 4,
      createdAt: new Date('2026-07-20T00:00:00Z'),
      updatedAt: new Date('2026-07-20T00:00:00Z'),
    };

    const snapshot = sanitizeBookingSnapshot(record);

    expect(snapshot).toEqual({
      id: 'booking-1',
      bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD',
      clientId: 'client-1',
      proposalVersionId: 'pv-1',
      status: 'DRAFT',
    });
    expect(snapshot).not.toHaveProperty('internalNotes');
    expect(snapshot).not.toHaveProperty('clientVisibleNotes');
    expect(snapshot).not.toHaveProperty('createdAt');
  });
});
