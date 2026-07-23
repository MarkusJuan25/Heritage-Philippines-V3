import { describe, expect, it } from 'vitest';

import {
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
