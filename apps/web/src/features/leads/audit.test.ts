import { describe, expect, it } from 'vitest';

import {
  sanitizeClientCreatedSnapshot,
  sanitizeLeadConversionSnapshot,
  sanitizeLeadCreatedSnapshot,
  sanitizeLeadStatusSnapshot,
  sanitizeLeadUpdateSnapshot,
} from './audit';

describe('sanitizeLeadCreatedSnapshot', () => {
  it('includes only the allow-listed fields', () => {
    const snapshot = sanitizeLeadCreatedSnapshot({
      id: 'lead-1',
      status: 'NEW',
      source: 'Phone inquiry',
      email: 'lead@example.com',
      phone: null,
    });

    expect(snapshot).toEqual({
      id: 'lead-1',
      status: 'NEW',
      source: 'Phone inquiry',
      hasEmail: true,
      hasPhone: false,
    });
  });

  it('never leaks the raw email or phone value', () => {
    const snapshot = sanitizeLeadCreatedSnapshot({
      id: 'lead-1',
      status: 'NEW',
      source: 'Walk-in',
      email: 'secret@example.com',
      phone: '639171234567',
    });

    expect(JSON.stringify(snapshot)).not.toContain('secret@example.com');
    expect(JSON.stringify(snapshot)).not.toContain('639171234567');
    expect(Object.keys(snapshot)).not.toContain('fullName');
    expect(Object.keys(snapshot)).not.toContain('notes');
  });
});

describe('sanitizeLeadUpdateSnapshot', () => {
  it('records only field names and contact-presence flags', () => {
    const snapshot = sanitizeLeadUpdateSnapshot({
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

  it('does not include any field beyond the allow-list', () => {
    const snapshot = sanitizeLeadUpdateSnapshot({
      changedFields: ['notes'],
      hasEmail: true,
      hasPhone: true,
    });
    expect(Object.keys(snapshot).sort()).toEqual(['changedFields', 'hasEmail', 'hasPhone']);
  });
});

describe('sanitizeLeadStatusSnapshot', () => {
  it('includes only status when no reason is supplied', () => {
    expect(sanitizeLeadStatusSnapshot('QUALIFIED')).toEqual({ status: 'QUALIFIED' });
  });

  it('includes the reason when supplied, as authorized by D-022 §7', () => {
    expect(sanitizeLeadStatusSnapshot('SPAM', 'Confirmed spam submission')).toEqual({
      status: 'SPAM',
      reason: 'Confirmed spam submission',
    });
  });
});

describe('sanitizeLeadConversionSnapshot', () => {
  it('includes only the allow-listed fields, per D-024 §8', () => {
    const snapshot = sanitizeLeadConversionSnapshot({ clientId: 'client-1', clientCreated: true });

    expect(snapshot).toEqual({
      status: 'CONVERTED_TO_CLIENT',
      clientId: 'client-1',
      clientCreated: true,
    });
  });

  it('never includes a supplied extra or PII-like field', () => {
    // Deliberately smuggling fields the declared parameter type forbids, to
    // prove the explicit return-object construction (never a spread) drops
    // them regardless of what a caller passes.
    const maliciousInput = {
      clientId: 'client-1',
      clientCreated: false,
      fullName: 'Juan Dela Cruz',
      email: 'juan@example.com',
    } as unknown as Parameters<typeof sanitizeLeadConversionSnapshot>[0];

    const snapshot = sanitizeLeadConversionSnapshot(maliciousInput);

    expect(Object.keys(snapshot).sort()).toEqual(['clientCreated', 'clientId', 'status']);
    expect(JSON.stringify(snapshot)).not.toContain('Juan Dela Cruz');
    expect(JSON.stringify(snapshot)).not.toContain('juan@example.com');
  });
});

describe('sanitizeClientCreatedSnapshot', () => {
  it('includes only the allow-listed fields, per D-024 §8', () => {
    const snapshot = sanitizeClientCreatedSnapshot({
      sourceLeadId: 'lead-1',
      email: 'juan@example.com',
      phone: null,
    });

    expect(snapshot).toEqual({
      sourceLeadId: 'lead-1',
      hasEmail: true,
      hasPhone: false,
    });
  });

  it('never leaks the raw email or phone value, or a supplied extra/PII-like field', () => {
    const maliciousInput = {
      sourceLeadId: 'lead-1',
      email: 'secret@example.com',
      phone: '639171234567',
      fullName: 'Juan Dela Cruz',
      notes: 'VIP client',
    } as unknown as Parameters<typeof sanitizeClientCreatedSnapshot>[0];

    const snapshot = sanitizeClientCreatedSnapshot(maliciousInput);

    expect(Object.keys(snapshot).sort()).toEqual(['hasEmail', 'hasPhone', 'sourceLeadId']);
    expect(JSON.stringify(snapshot)).not.toContain('secret@example.com');
    expect(JSON.stringify(snapshot)).not.toContain('639171234567');
    expect(JSON.stringify(snapshot)).not.toContain('Juan Dela Cruz');
  });
});
