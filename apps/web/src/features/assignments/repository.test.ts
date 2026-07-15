import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import { findClientProfileOwnership } from './repository';

// Focused on findClientProfileOwnership only — the new lookup added for
// client-portal ownership enforcement (blueprint Sections 4.6, 14.1). The
// rest of this repository's functions are exercised indirectly through
// authorization.test.ts / service.test.ts, consistent with this codebase's
// existing test layout (no other feature has a repository.test.ts).
describe('findClientProfileOwnership', () => {
  it('scopes the Prisma query by both userId and clientId in the query itself, not by fetching one and comparing after', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'profile-1' });
    const db = { clientProfile: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findClientProfileOwnership(db, 'user-1', 'client-1');

    expect(result).toEqual({ id: 'profile-1' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', clientId: 'client-1' },
      select: { id: true },
    });
  });

  it('returns null when no ClientProfile matches both the given userId and clientId', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { clientProfile: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findClientProfileOwnership(db, 'user-1', 'someone-elses-client');

    expect(result).toBeNull();
  });
});
