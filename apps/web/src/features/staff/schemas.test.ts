import { describe, expect, it } from 'vitest';

import { STAFF_ROLES } from '@/lib/auth/roles';

import {
  changeStaffRoleSchema,
  createStaffAccountSchema,
  deactivateStaffAccountSchema,
  listStaffAccountsQuerySchema,
  staffAccountIdParamSchema,
  staffRoleSchema,
} from './schemas';

describe('staffRoleSchema', () => {
  it('accepts every staff role', () => {
    for (const role of STAFF_ROLES) {
      expect(staffRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it('rejects CLIENT', () => {
    expect(staffRoleSchema.safeParse('CLIENT').success).toBe(false);
  });

  it('rejects an unknown role string', () => {
    expect(staffRoleSchema.safeParse('SUPER_ADMIN').success).toBe(false);
  });
});

describe('createStaffAccountSchema', () => {
  const valid = {
    name: 'Jordan Cruz',
    email: 'Jordan.Cruz@Example.com',
    role: 'TRAVEL_CONSULTANT',
  };

  it('accepts a minimal valid payload and lowercases/trims email', () => {
    const result = createStaffAccountSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('jordan.cruz@example.com');
    }
  });

  it('rejects role CLIENT even though it is a valid platform Role value', () => {
    const result = createStaffAccountSchema.safeParse({ ...valid, role: 'CLIENT' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email', () => {
    const result = createStaffAccountSchema.safeParse({ ...valid, email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing name', () => {
    const result = createStaffAccountSchema.safeParse({ ...valid, name: '' });
    expect(result.success).toBe(false);
  });

  it('accepts an optional password of sufficient length, rejects a short one', () => {
    expect(
      createStaffAccountSchema.safeParse({ ...valid, password: 'longenoughpassword' }).success,
    ).toBe(true);
    expect(createStaffAccountSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  it('accepts optional title and phone', () => {
    const result = createStaffAccountSchema.safeParse({
      ...valid,
      title: 'Senior Consultant',
      phone: '+63 900 000 0000',
    });
    expect(result.success).toBe(true);
  });
});

describe('changeStaffRoleSchema', () => {
  it('accepts a valid staff role', () => {
    expect(changeStaffRoleSchema.safeParse({ role: 'FINANCE_ACCOUNTING' }).success).toBe(true);
  });

  it('rejects CLIENT', () => {
    expect(changeStaffRoleSchema.safeParse({ role: 'CLIENT' }).success).toBe(false);
  });

  it('rejects a missing role', () => {
    expect(changeStaffRoleSchema.safeParse({}).success).toBe(false);
  });
});

describe('deactivateStaffAccountSchema', () => {
  it('requires a non-empty reason', () => {
    expect(deactivateStaffAccountSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(deactivateStaffAccountSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a valid reason', () => {
    expect(
      deactivateStaffAccountSchema.safeParse({ reason: 'Departed the company on 2026-07-01.' })
        .success,
    ).toBe(true);
  });
});

describe('staffAccountIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(
      staffAccountIdParamSchema.safeParse({ id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }).success,
    ).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(staffAccountIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('listStaffAccountsQuerySchema', () => {
  it('defaults page to 1 and pageSize to 20 when omitted', () => {
    const result = listStaffAccountsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(20);
    }
  });

  it('coerces string query params for page and pageSize', () => {
    const result = listStaffAccountsQuerySchema.safeParse({ page: '3', pageSize: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.pageSize).toBe(50);
    }
  });

  it('caps pageSize at 100', () => {
    expect(listStaffAccountsQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });

  it('transforms the isActive query string into a boolean, leaving it undefined when absent', () => {
    const active = listStaffAccountsQuerySchema.safeParse({ isActive: 'true' });
    const inactive = listStaffAccountsQuerySchema.safeParse({ isActive: 'false' });
    const absent = listStaffAccountsQuerySchema.safeParse({});

    expect(active.success && active.data.isActive).toBe(true);
    expect(inactive.success && inactive.data.isActive).toBe(false);
    expect(absent.success && absent.data.isActive).toBeUndefined();
  });

  it('rejects an invalid isActive value', () => {
    expect(listStaffAccountsQuerySchema.safeParse({ isActive: 'yes' }).success).toBe(false);
  });

  it('rejects CLIENT as a role filter', () => {
    expect(listStaffAccountsQuerySchema.safeParse({ role: 'CLIENT' }).success).toBe(false);
  });
});
