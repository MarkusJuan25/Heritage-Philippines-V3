import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientIdParamSchema, listClientsQuerySchema, updateClientSchema } from './schemas';
import type { UpdateClientInput } from './schemas';

const VALID_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
// Exactly three-digit millisecond precision, literal `Z` — matches
// `Date.prototype.toISOString()` exactly (D-025 §5/§7).
const VALID_EXPECTED_UPDATED_AT = '2026-07-30T12:34:56.789Z';

describe('clientIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(clientIdParamSchema.safeParse({ id: VALID_ID }).success).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(clientIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('listClientsQuerySchema', () => {
  it('applies page/pageSize defaults', () => {
    const result = listClientsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.pageSize).toBe(20);
      expect(result.data.search).toBeUndefined();
    }
  });

  it('coerces string page/pageSize query values', () => {
    const result = listClientsQuerySchema.safeParse({ page: '2', pageSize: '5' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(2);
      expect(result.data.pageSize).toBe(5);
    }
  });

  it('rejects a pageSize above 100', () => {
    expect(listClientsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });

  it('accepts a pageSize at exactly 100 (the boundary)', () => {
    expect(listClientsQuerySchema.safeParse({ pageSize: '100' }).success).toBe(true);
  });

  it('rejects a page below 1', () => {
    expect(listClientsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('trims a search value', () => {
    const result = listClientsQuerySchema.safeParse({ search: '  juan  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.search).toBe('juan');
    }
  });

  it('rejects a whitespace-only search value (D-025 §3 — invalid at the schema layer, not silently undefined)', () => {
    expect(listClientsQuerySchema.safeParse({ search: '   ' }).success).toBe(false);
  });

  it('rejects a search value over 200 characters', () => {
    expect(listClientsQuerySchema.safeParse({ search: 'a'.repeat(201) }).success).toBe(false);
  });

  it('accepts a search value at exactly 200 characters (the boundary)', () => {
    expect(listClientsQuerySchema.safeParse({ search: 'a'.repeat(200) }).success).toBe(true);
  });
});

describe('updateClientSchema — general shape', () => {
  it('accepts a minimal valid patch (one editable field plus expectedUpdatedAt)', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'Juan Dela Cruz',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a body containing only expectedUpdatedAt (no editable field)', () => {
    const result = updateClientSchema.safeParse({ expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT });
    expect(result.success).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(updateClientSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a patch whose only editable field clears to null (still counts as "editable field supplied")', () => {
    const result = updateClientSchema.safeParse({
      notes: '',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, 'notes')).toBe(true);
      expect(result.data.notes).toBeNull();
    }
  });

  it('rejects a missing expectedUpdatedAt', () => {
    const result = updateClientSchema.safeParse({ fullName: 'Juan' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown property', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'Juan',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
      nickname: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('leaves an omitted editable field absent from the parsed object (distinguishable from an explicit clear)', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'Juan',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, 'email')).toBe(false);
      expect(Object.hasOwn(result.data, 'fullName')).toBe(true);
    }
  });
});

describe('updateClientSchema — expectedUpdatedAt', () => {
  it('rejects a datetime without millisecond precision', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'Juan',
      expectedUpdatedAt: '2026-07-30T12:34:56Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a datetime with six-digit (microsecond) precision', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'Juan',
      expectedUpdatedAt: '2026-07-30T12:34:56.789123Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UTC offset instead of the literal Z suffix', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'Juan',
      expectedUpdatedAt: '2026-07-30T12:34:56.789+08:00',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bare date with no time component', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'Juan',
      expectedUpdatedAt: '2026-07-30',
    });
    expect(result.success).toBe(false);
  });
});

describe('updateClientSchema — fullName', () => {
  it('accepts and trims a valid fullName', () => {
    const result = updateClientSchema.safeParse({
      fullName: '  Juan Dela Cruz  ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fullName).toBe('Juan Dela Cruz');
    }
  });

  it('rejects a blank fullName (cannot be cleared)', () => {
    const result = updateClientSchema.safeParse({
      fullName: '   ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });

  it('accepts fullName at exactly 200 characters (the boundary)', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'a'.repeat(200),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('rejects fullName over 200 characters', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'a'.repeat(201),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateClientSchema — email', () => {
  it('trims and accepts a valid email', () => {
    const result = updateClientSchema.safeParse({
      email: '  juan@example.com  ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('juan@example.com');
    }
  });

  it('transforms a blank email to null', () => {
    const result = updateClientSchema.safeParse({
      email: '   ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBeNull();
    }
  });

  it('accepts an email at exactly 320 characters (the boundary)', () => {
    const boundaryEmail = `${'a'.repeat(315)}@a.co`; // 320 characters total
    const result = updateClientSchema.safeParse({
      email: boundaryEmail,
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an email over 320 characters', () => {
    const longEmail = `${'a'.repeat(316)}@a.co`; // 321 characters total
    const result = updateClientSchema.safeParse({
      email: longEmail,
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateClientSchema — phone', () => {
  it('accepts a valid phone', () => {
    const result = updateClientSchema.safeParse({
      phone: '0917 123 4567',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('transforms a blank phone to null', () => {
    const result = updateClientSchema.safeParse({
      phone: '',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBeNull();
    }
  });

  it('removes leading and trailing whitespace from phone, preserving internal spacing', () => {
    const result = updateClientSchema.safeParse({
      phone: '  0917 123 4567  ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe('0917 123 4567');
    }
  });

  it('transforms a whitespace-only phone to null', () => {
    const result = updateClientSchema.safeParse({
      phone: '   ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBeNull();
    }
  });

  it('accepts phone at exactly 50 characters (the boundary)', () => {
    const result = updateClientSchema.safeParse({
      phone: '1'.repeat(50),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('rejects phone over 50 characters', () => {
    const result = updateClientSchema.safeParse({
      phone: '1'.repeat(51),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateClientSchema — address', () => {
  it('trims and accepts a valid address', () => {
    const result = updateClientSchema.safeParse({
      address: '  123 Rizal St., Makati  ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.address).toBe('123 Rizal St., Makati');
    }
  });

  it('transforms a blank address to null', () => {
    const result = updateClientSchema.safeParse({
      address: '   ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.address).toBeNull();
    }
  });

  it('accepts address at exactly 500 characters (the boundary)', () => {
    const result = updateClientSchema.safeParse({
      address: 'a'.repeat(500),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('rejects address over 500 characters', () => {
    const result = updateClientSchema.safeParse({
      address: 'a'.repeat(501),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateClientSchema — nationality', () => {
  it('trims and accepts a valid nationality', () => {
    const result = updateClientSchema.safeParse({
      nationality: '  Filipino  ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nationality).toBe('Filipino');
    }
  });

  it('transforms a blank nationality to null', () => {
    const result = updateClientSchema.safeParse({
      nationality: '',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nationality).toBeNull();
    }
  });

  it('accepts nationality at exactly 100 characters (the boundary)', () => {
    const result = updateClientSchema.safeParse({
      nationality: 'a'.repeat(100),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('rejects nationality over 100 characters', () => {
    const result = updateClientSchema.safeParse({
      nationality: 'a'.repeat(101),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateClientSchema — emergencyContact', () => {
  it('trims and accepts a valid emergencyContact', () => {
    const result = updateClientSchema.safeParse({
      emergencyContact: '  Maria Dela Cruz, 0917 000 0000  ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.emergencyContact).toBe('Maria Dela Cruz, 0917 000 0000');
    }
  });

  it('transforms a blank emergencyContact to null', () => {
    const result = updateClientSchema.safeParse({
      emergencyContact: '   ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.emergencyContact).toBeNull();
    }
  });

  it('accepts emergencyContact at exactly 200 characters (the boundary)', () => {
    const result = updateClientSchema.safeParse({
      emergencyContact: 'a'.repeat(200),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('rejects emergencyContact over 200 characters', () => {
    const result = updateClientSchema.safeParse({
      emergencyContact: 'a'.repeat(201),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateClientSchema — notes', () => {
  it('trims and accepts valid notes', () => {
    const result = updateClientSchema.safeParse({
      notes: '  VIP client  ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notes).toBe('VIP client');
    }
  });

  it('transforms blank notes to null', () => {
    const result = updateClientSchema.safeParse({
      notes: '   ',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notes).toBeNull();
    }
  });

  it('accepts notes at exactly 2000 characters (the boundary)', () => {
    const result = updateClientSchema.safeParse({
      notes: 'a'.repeat(2000),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
  });

  it('rejects notes over 2000 characters', () => {
    const result = updateClientSchema.safeParse({
      notes: 'a'.repeat(2001),
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });
});

describe('updateClientSchema — dateOfBirth', () => {
  it('accepts a valid past date and persists it as UTC midnight', () => {
    const result = updateClientSchema.safeParse({
      dateOfBirth: '1990-05-15',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateOfBirth).toBeInstanceOf(Date);
      expect((result.data.dateOfBirth as Date).toISOString()).toBe('1990-05-15T00:00:00.000Z');
    }
  });

  it('accepts a genuine leap day (2024-02-29)', () => {
    const result = updateClientSchema.safeParse({
      dateOfBirth: '2024-02-29',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.dateOfBirth as Date).toISOString()).toBe('2024-02-29T00:00:00.000Z');
    }
  });

  it('rejects February 29 in a non-leap year (2025-02-29), without rollover', () => {
    const result = updateClientSchema.safeParse({
      dateOfBirth: '2025-02-29',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an impossible day-of-month (2026-04-31), without rollover', () => {
    const result = updateClientSchema.safeParse({
      dateOfBirth: '2026-04-31',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a date far in the future', () => {
    const result = updateClientSchema.safeParse({
      dateOfBirth: '2099-12-31',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed (non-YYYY-MM-DD) string', () => {
    const result = updateClientSchema.safeParse({
      dateOfBirth: '05/15/1990',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an explicit null to clear dateOfBirth', () => {
    const result = updateClientSchema.safeParse({
      dateOfBirth: null,
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, 'dateOfBirth')).toBe(true);
      expect(result.data.dateOfBirth).toBeNull();
    }
  });

  it('accepts a blank string to clear dateOfBirth', () => {
    const result = updateClientSchema.safeParse({
      dateOfBirth: '',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dateOfBirth).toBeNull();
    }
  });

  it('leaves an omitted dateOfBirth absent from the parsed object (preserves existing value)', () => {
    const result = updateClientSchema.safeParse({
      fullName: 'Juan',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.hasOwn(result.data, 'dateOfBirth')).toBe(false);
    }
  });

  it('UpdateClientInput.dateOfBirth is a genuinely optional key (compile-time proof): a literal with expectedUpdatedAt plus another editable field, and no dateOfBirth key, must type-check', () => {
    // If `dateOfBirth` were still inferred as a required key (Stage C's
    // pre-correction behavior), this object literal would fail to satisfy
    // `UpdateClientInput` and `pnpm typecheck` would reject this file —
    // the assignment compiling at all is the proof, the runtime assertion
    // below merely confirms it.
    const input: UpdateClientInput = {
      fullName: 'Juan',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    };
    expect(Object.hasOwn(input, 'dateOfBirth')).toBe(false);
  });
});

// D-025 §5's "current Philippine business date" is Asia/Manila (a fixed
// UTC+8 offset) — at a UTC instant already past midnight Manila time, the
// Manila calendar date is one day ahead of the UTC calendar date. These
// tests freeze the clock at exactly such an instant to prove the future-date
// check compares against the *Manila* date, not the UTC date, at the exact
// boundary — never a same-day-everywhere approximation.
describe('updateClientSchema — dateOfBirth Philippine business-date boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a dateOfBirth equal to the current Philippine business date, even though it is still the prior calendar day in UTC', () => {
    // 2026-07-30T16:30:00.000Z + 8h (Asia/Manila) = 2026-07-31T00:30:00 —
    // the Philippine business date is already 2026-07-31 at this instant.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T16:30:00.000Z'));

    const result = updateClientSchema.safeParse({
      dateOfBirth: '2026-07-31',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a dateOfBirth exactly one day past the current Philippine business date, at the identical frozen instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T16:30:00.000Z'));

    const result = updateClientSchema.safeParse({
      dateOfBirth: '2026-08-01',
      expectedUpdatedAt: VALID_EXPECTED_UPDATED_AT,
    });

    expect(result.success).toBe(false);
  });
});
