import { describe, expect, it } from 'vitest';

import { normalizeEmail, normalizePhone } from './normalize';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Sample.Lead@Example.COM  ')).toBe('sample.lead@example.com');
  });

  it('is a no-op for an already-normalized value', () => {
    expect(normalizeEmail('lead@example.com')).toBe('lead@example.com');
  });
});

describe('normalizePhone', () => {
  // D-022 §4's four named equivalent forms — all must converge.
  it.each([
    ['0917 123 4567', '639171234567'],
    ['+63 917 123 4567', '639171234567'],
    ['0063 917 123 4567', '639171234567'],
    ['9171234567', '639171234567'],
  ])('normalizes "%s" to "%s"', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('strips formatting characters (spaces, dashes, parens)', () => {
    expect(normalizePhone('(0917) 123-4567')).toBe('639171234567');
  });

  it('preserves an already-international 63-prefixed number with no formatting', () => {
    expect(normalizePhone('639171234567')).toBe('639171234567');
  });

  it('converts a 10-digit domestic number beginning with 0 (e.g. a landline)', () => {
    expect(normalizePhone('0281234567')).toBe('63281234567');
  });

  it('removes only one leading 00, not a 63 that happens to start with 0-prefixed digits elsewhere', () => {
    expect(normalizePhone('0063')).toBe('63');
  });

  it('falls back to the conservative digits-only remainder for an unrecognized shape', () => {
    expect(normalizePhone('12345')).toBe('12345');
  });

  it('falls back to digits-only for a non-PH international number', () => {
    expect(normalizePhone('+1 202 555 0100')).toBe('12025550100');
  });

  it('handles an empty string', () => {
    expect(normalizePhone('')).toBe('');
  });
});
