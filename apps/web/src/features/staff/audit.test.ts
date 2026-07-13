import { describe, expect, it } from 'vitest';

import { sanitizeAccountSnapshot } from './audit';

describe('sanitizeAccountSnapshot', () => {
  it('picks only id, name, email, role, and isActive', () => {
    const snapshot = sanitizeAccountSnapshot({
      id: 'user-1',
      name: 'Jordan Cruz',
      email: 'jordan.cruz@example.test',
      role: 'TRAVEL_CONSULTANT',
      isActive: true,
    });

    expect(snapshot).toEqual({
      id: 'user-1',
      name: 'Jordan Cruz',
      email: 'jordan.cruz@example.test',
      role: 'TRAVEL_CONSULTANT',
      isActive: true,
    });
    expect(Object.keys(snapshot).sort()).toEqual(['email', 'id', 'isActive', 'name', 'role']);
  });

  it('never leaks extra fields the source record may carry (e.g. a password/hash), since it names each field explicitly rather than spreading', () => {
    const recordWithExtraFields = {
      id: 'user-1',
      name: 'Jordan Cruz',
      email: 'jordan.cruz@example.test',
      role: 'TRAVEL_CONSULTANT' as const,
      isActive: true,
      // Simulates a widened repository select accidentally including
      // credential-shaped data — sanitizeAccountSnapshot must ignore it.
      password: 'super-secret-hash',
      accounts: [{ password: 'another-secret-hash' }],
    };

    const snapshot = sanitizeAccountSnapshot(recordWithExtraFields);

    expect(snapshot).not.toHaveProperty('password');
    expect(snapshot).not.toHaveProperty('accounts');
    expect(JSON.stringify(snapshot)).not.toContain('secret-hash');
  });
});
