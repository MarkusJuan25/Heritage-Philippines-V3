import { describe, expect, it } from 'vitest';

import {
  CLIENT_AUDIT_ACTIONS,
  CLIENT_AUDIT_ENTITY_TYPE,
  sanitizeClientUpdateSnapshot,
} from './audit';

describe('CLIENT_AUDIT_ACTIONS / CLIENT_AUDIT_ENTITY_TYPE', () => {
  it('defines the exact D-025 §8 action and entity type', () => {
    expect(CLIENT_AUDIT_ACTIONS.CLIENT_UPDATED).toBe('CLIENT_UPDATED');
    expect(CLIENT_AUDIT_ENTITY_TYPE).toBe('Client');
  });
});

describe('sanitizeClientUpdateSnapshot', () => {
  it('records only field names and contact-presence flags', () => {
    const snapshot = sanitizeClientUpdateSnapshot({
      changedFields: ['fullName', 'email'],
      hasEmail: true,
      hasPhone: false,
    });

    expect(snapshot).toEqual({
      changedFields: ['fullName', 'email'],
      hasEmail: true,
      hasPhone: false,
    });
  });

  it("clones changedFields rather than retaining the caller's array reference", () => {
    const changedFields = ['notes'];
    const snapshot = sanitizeClientUpdateSnapshot({
      changedFields,
      hasEmail: true,
      hasPhone: true,
    });

    expect(snapshot.changedFields).toEqual(['notes']);
    expect(snapshot.changedFields).not.toBe(changedFields);

    // Mutating the caller's original array afterward must never affect the
    // already-built snapshot.
    changedFields.push('address');
    expect(snapshot.changedFields).toEqual(['notes']);
  });

  it('does not include any field beyond the exact closed key set', () => {
    const snapshot = sanitizeClientUpdateSnapshot({
      changedFields: ['address'],
      hasEmail: false,
      hasPhone: true,
    });
    expect(Object.keys(snapshot).sort()).toEqual(['changedFields', 'hasEmail', 'hasPhone']);
  });

  it('never includes expectedUpdatedAt or any raw PII value, even if maliciously smuggled in', () => {
    // Deliberately smuggling fields the declared parameter type forbids, to
    // prove the explicit return-object construction (never a spread) drops
    // them regardless of what a caller passes — mirrors
    // features/leads/audit.test.ts's identical malicious-input discipline.
    const maliciousInput = {
      changedFields: ['fullName'],
      hasEmail: true,
      hasPhone: true,
      expectedUpdatedAt: '2026-07-30T12:34:56.789Z',
      fullName: 'Juan Dela Cruz',
      email: 'juan@example.com',
      phone: '639171234567',
      address: '123 Rizal St., Makati',
      nationality: 'Filipino',
      dateOfBirth: '1990-05-15',
      emergencyContact: 'Maria Dela Cruz, 0917 000 0000',
      notes: 'VIP client',
    } as unknown as Parameters<typeof sanitizeClientUpdateSnapshot>[0];

    const snapshot = sanitizeClientUpdateSnapshot(maliciousInput);

    expect(Object.keys(snapshot).sort()).toEqual(['changedFields', 'hasEmail', 'hasPhone']);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('2026-07-30T12:34:56.789Z');
    expect(serialized).not.toContain('Juan Dela Cruz');
    expect(serialized).not.toContain('juan@example.com');
    expect(serialized).not.toContain('639171234567');
    expect(serialized).not.toContain('123 Rizal St., Makati');
    expect(serialized).not.toContain('Filipino');
    expect(serialized).not.toContain('1990-05-15');
    expect(serialized).not.toContain('Maria Dela Cruz, 0917 000 0000');
    expect(serialized).not.toContain('VIP client');
  });
});
