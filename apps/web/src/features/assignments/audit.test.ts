import { describe, expect, it } from 'vitest';

import { sanitizeAssignmentSnapshot } from './audit';

describe('sanitizeAssignmentSnapshot', () => {
  it('picks only id, assignedStaffId, assignedByUserId, leadId, clientId, and endedAt', () => {
    const snapshot = sanitizeAssignmentSnapshot({
      id: 'assignment-1',
      assignedStaffId: 'staff-1',
      assignedByUserId: 'admin-1',
      leadId: 'lead-1',
      clientId: null,
      endedAt: null,
    });

    expect(snapshot).toEqual({
      id: 'assignment-1',
      assignedStaffId: 'staff-1',
      assignedByUserId: 'admin-1',
      leadId: 'lead-1',
      clientId: null,
      endedAt: null,
    });
    expect(Object.keys(snapshot).sort()).toEqual(
      ['assignedByUserId', 'assignedStaffId', 'clientId', 'endedAt', 'id', 'leadId'].sort(),
    );
  });

  it('serializes a non-null endedAt to an ISO string, since JSON cannot hold a raw Date', () => {
    const endedAt = new Date('2026-07-20T10:00:00.000Z');
    const snapshot = sanitizeAssignmentSnapshot({
      id: 'assignment-1',
      assignedStaffId: 'staff-1',
      assignedByUserId: 'admin-1',
      leadId: 'lead-1',
      clientId: null,
      endedAt,
    });

    expect(snapshot.endedAt).toBe('2026-07-20T10:00:00.000Z');
  });

  it('never leaks Lead/Client business fields, createdAt/updatedAt, or other extra fields the source record may carry', () => {
    const recordWithExtraFields = {
      id: 'assignment-1',
      assignedStaffId: 'staff-1',
      assignedByUserId: 'admin-1',
      leadId: 'lead-1',
      clientId: null,
      endedAt: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      // Simulates an accidentally widened repository select that joined in
      // the target's business record.
      lead: { fullName: 'Jordan Cruz', email: 'jordan.cruz@example.test' },
    };

    const snapshot = sanitizeAssignmentSnapshot(recordWithExtraFields);

    expect(snapshot).not.toHaveProperty('createdAt');
    expect(snapshot).not.toHaveProperty('updatedAt');
    expect(snapshot).not.toHaveProperty('lead');
    expect(JSON.stringify(snapshot)).not.toContain('Jordan Cruz');
    expect(JSON.stringify(snapshot)).not.toContain('jordan.cruz@example.test');
  });
});
