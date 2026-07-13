import { describe, expect, it } from 'vitest';

import { authorize } from './authorize';
import { ROLES, STAFF_ROLES, isStaffRole } from './roles';

describe('authorize', () => {
  it('rejects an unauthenticated caller (no role) with 401, regardless of allowedRoles', () => {
    expect(authorize(null)).toEqual({ authorized: false, status: 401, reason: 'unauthenticated' });
    expect(authorize(null, STAFF_ROLES)).toEqual({
      authorized: false,
      status: 401,
      reason: 'unauthenticated',
    });
  });

  it('allows any authenticated role when allowedRoles is omitted', () => {
    for (const role of ROLES) {
      expect(authorize(role)).toEqual({ authorized: true });
    }
  });

  it('allows a role that is in allowedRoles', () => {
    expect(authorize('FINANCE_ACCOUNTING', ['FINANCE_ACCOUNTING', 'ADMIN_MANAGER'])).toEqual({
      authorized: true,
    });
  });

  it('rejects a role that is not in allowedRoles with 403', () => {
    expect(authorize('TRAVEL_CONSULTANT', ['FINANCE_ACCOUNTING'])).toEqual({
      authorized: false,
      status: 403,
      reason: 'forbidden',
    });
  });

  it('rejects CLIENT from a staff-only allowlist', () => {
    expect(authorize('CLIENT', STAFF_ROLES)).toEqual({
      authorized: false,
      status: 403,
      reason: 'forbidden',
    });
  });

  it('allows every staff role (not CLIENT) through STAFF_ROLES', () => {
    for (const role of STAFF_ROLES) {
      expect(authorize(role, STAFF_ROLES)).toEqual({ authorized: true });
    }
  });
});

describe('roles', () => {
  it('defines exactly the six blueprint-approved roles', () => {
    expect(ROLES).toHaveLength(6);
    expect(ROLES).toEqual([
      'SYSTEM_ADMINISTRATOR',
      'ADMIN_MANAGER',
      'TRAVEL_CONSULTANT',
      'FINANCE_ACCOUNTING',
      'VISA_DOCUMENTATION',
      'CLIENT',
    ]);
  });

  it('STAFF_ROLES excludes CLIENT and only CLIENT', () => {
    expect(STAFF_ROLES).toHaveLength(5);
    expect(STAFF_ROLES).not.toContain('CLIENT');
  });

  it('isStaffRole classifies CLIENT as the only non-staff role', () => {
    expect(isStaffRole('CLIENT')).toBe(false);
    for (const role of STAFF_ROLES) {
      expect(isStaffRole(role)).toBe(true);
    }
  });
});
