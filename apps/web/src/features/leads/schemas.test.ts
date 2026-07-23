import { describe, expect, it } from 'vitest';

import {
  createLeadSchema,
  listLeadsQuerySchema,
  updateLeadSchema,
  updateLeadStatusSchema,
} from './schemas';

describe('createLeadSchema', () => {
  const base = { fullName: 'Juan Dela Cruz', source: 'Phone inquiry', email: 'juan@example.com' };

  it('accepts a minimal valid payload', () => {
    const result = createLeadSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('rejects a missing fullName', () => {
    const result = createLeadSchema.safeParse({ source: base.source, email: base.email });
    expect(result.success).toBe(false);
  });

  it('rejects a missing source', () => {
    const result = createLeadSchema.safeParse({ fullName: base.fullName, email: base.email });
    expect(result.success).toBe(false);
  });

  it('rejects a blank fullName', () => {
    const result = createLeadSchema.safeParse({ ...base, fullName: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects when neither email nor phone is present', () => {
    const result = createLeadSchema.safeParse({ fullName: 'Juan', source: 'Walk-in' });
    expect(result.success).toBe(false);
  });

  it('rejects when email and phone are both blank strings', () => {
    const result = createLeadSchema.safeParse({
      fullName: 'Juan',
      source: 'Walk-in',
      email: '   ',
      phone: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts phone-only', () => {
    const result = createLeadSchema.safeParse({
      fullName: 'Juan',
      source: 'Walk-in',
      phone: '0917 123 4567',
    });
    expect(result.success).toBe(true);
  });

  it('trims fullName/source and normalizes a blank notes to undefined', () => {
    const result = createLeadSchema.safeParse({ ...base, fullName: '  Juan  ', notes: '   ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fullName).toBe('Juan');
      expect(result.data.notes).toBeUndefined();
    }
  });

  it('rejects an email over 320 characters', () => {
    const longEmail = `${'a'.repeat(316)}@a.co`; // 321 characters total
    const result = createLeadSchema.safeParse({ ...base, email: longEmail });
    expect(result.success).toBe(false);
  });

  it('accepts an email at exactly 320 characters (the boundary)', () => {
    const boundaryEmail = `${'a'.repeat(315)}@a.co`; // 320 characters total
    const result = createLeadSchema.safeParse({ ...base, email: boundaryEmail });
    expect(result.success).toBe(true);
  });

  it('rejects a phone over 50 characters', () => {
    const result = createLeadSchema.safeParse({ ...base, phone: '1'.repeat(51) });
    expect(result.success).toBe(false);
  });

  it('rejects notes over 2000 characters', () => {
    const result = createLeadSchema.safeParse({ ...base, notes: 'a'.repeat(2001) });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown property', () => {
    const result = createLeadSchema.safeParse({ ...base, unexpected: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects a caller-supplied status', () => {
    const result = createLeadSchema.safeParse({ ...base, status: 'QUALIFIED' });
    expect(result.success).toBe(false);
  });
});

describe('updateLeadSchema', () => {
  it('accepts an empty patch', () => {
    expect(updateLeadSchema.safeParse({}).success).toBe(true);
  });

  it('leaves an omitted field absent from the parsed object (distinguishable from an explicit clear)', () => {
    const result = updateLeadSchema.safeParse({ fullName: 'New Name' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, 'email')).toBe(false);
      expect(Object.hasOwn(result.data, 'fullName')).toBe(true);
    }
  });

  it('transforms a blank email to null, distinguishable from omission', () => {
    const result = updateLeadSchema.safeParse({ email: '   ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, 'email')).toBe(true);
      expect(result.data.email).toBeNull();
    }
  });

  it('transforms a blank phone to null', () => {
    const result = updateLeadSchema.safeParse({ phone: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBeNull();
    }
  });

  it('rejects a blank fullName (required-when-present)', () => {
    const result = updateLeadSchema.safeParse({ fullName: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown property', () => {
    const result = updateLeadSchema.safeParse({ nickname: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects a caller-supplied status', () => {
    const result = updateLeadSchema.safeParse({ status: 'ARCHIVED' });
    expect(result.success).toBe(false);
  });
});

describe('updateLeadStatusSchema', () => {
  it('accepts expectedStatus/newStatus without a reason', () => {
    const result = updateLeadStatusSchema.safeParse({
      expectedStatus: 'NEW',
      newStatus: 'UNDER_REVIEW',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an optional trimmed reason', () => {
    const result = updateLeadStatusSchema.safeParse({
      expectedStatus: 'SPAM',
      newStatus: 'UNDER_REVIEW',
      reason: '  Misclassified  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('Misclassified');
    }
  });

  it('rejects a blank reason when present', () => {
    const result = updateLeadStatusSchema.safeParse({
      expectedStatus: 'SPAM',
      newStatus: 'UNDER_REVIEW',
      reason: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a reason over 500 characters', () => {
    const result = updateLeadStatusSchema.safeParse({
      expectedStatus: 'NEW',
      newStatus: 'SPAM',
      reason: 'a'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid status value', () => {
    const result = updateLeadStatusSchema.safeParse({
      expectedStatus: 'NEW',
      newStatus: 'NOT_A_STATUS',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown property', () => {
    const result = updateLeadStatusSchema.safeParse({
      expectedStatus: 'NEW',
      newStatus: 'CONTACTED',
      note: 'nope',
    });
    expect(result.success).toBe(false);
  });
});

describe('listLeadsQuerySchema', () => {
  it('applies page/pageSize defaults', () => {
    const result = listLeadsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(20);
    }
  });

  it('coerces string query values', () => {
    const result = listLeadsQuerySchema.safeParse({ page: '2', pageSize: '5' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.pageSize).toBe(5);
    }
  });

  it('rejects a pageSize above 100', () => {
    const result = listLeadsQuerySchema.safeParse({ pageSize: '1000' });
    expect(result.success).toBe(false);
  });

  it('rejects a page below 1', () => {
    const result = listLeadsQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
  });

  it('accepts status/source/search filters', () => {
    const result = listLeadsQuerySchema.safeParse({
      status: 'QUALIFIED',
      source: 'Contact page',
      search: 'juan',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid status filter value', () => {
    const result = listLeadsQuerySchema.safeParse({ status: 'NOT_A_STATUS' });
    expect(result.success).toBe(false);
  });
});
