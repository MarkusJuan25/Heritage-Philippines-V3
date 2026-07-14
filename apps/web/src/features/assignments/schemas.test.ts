import { describe, expect, it } from 'vitest';

import { assignmentTargetIdParamSchema, endAssignmentSchema, setAssignmentSchema } from './schemas';

const VALID_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER_VALID_UUID = '4fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('assignmentTargetIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(assignmentTargetIdParamSchema.safeParse({ id: VALID_UUID }).success).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(assignmentTargetIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects a missing id', () => {
    expect(assignmentTargetIdParamSchema.safeParse({}).success).toBe(false);
  });
});

describe('setAssignmentSchema', () => {
  it('accepts a valid assignedStaffId without a reason', () => {
    const result = setAssignmentSchema.safeParse({ assignedStaffId: VALID_UUID });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBeUndefined();
    }
  });

  it('accepts a valid assignedStaffId with a reason', () => {
    const result = setAssignmentSchema.safeParse({
      assignedStaffId: VALID_UUID,
      reason: 'Rebalancing consultant workload',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID assignedStaffId', () => {
    expect(setAssignmentSchema.safeParse({ assignedStaffId: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects a missing assignedStaffId', () => {
    expect(setAssignmentSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty-string reason (must be omitted, not blank)', () => {
    expect(setAssignmentSchema.safeParse({ assignedStaffId: VALID_UUID, reason: '' }).success).toBe(
      false,
    );
  });

  it('accepts assignedStaffId and reason as independent, unrelated UUIDs', () => {
    const result = setAssignmentSchema.safeParse({
      assignedStaffId: OTHER_VALID_UUID,
      reason: 'Reassigning after consultant left the team',
    });
    expect(result.success).toBe(true);
  });
});

describe('endAssignmentSchema', () => {
  it('requires a non-empty reason', () => {
    expect(endAssignmentSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(endAssignmentSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a valid reason', () => {
    expect(
      endAssignmentSchema.safeParse({ reason: 'Lead archived; no further follow-up needed.' })
        .success,
    ).toBe(true);
  });

  it('trims and rejects a whitespace-only reason', () => {
    expect(endAssignmentSchema.safeParse({ reason: '   ' }).success).toBe(false);
  });
});
