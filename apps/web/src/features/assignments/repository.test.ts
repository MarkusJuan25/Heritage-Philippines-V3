import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import { findClientProfileOwnership, listEligibleTravelConsultants } from './repository';

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

describe('listEligibleTravelConsultants', () => {
  it('scopes the query to active TRAVEL_CONSULTANT accounts only, ordered by name then id (D-023 §6)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { user: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listEligibleTravelConsultants(db, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith({
      where: { role: 'TRAVEL_CONSULTANT', isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: 0,
      take: 20,
    });
    expect(count).toHaveBeenCalledWith({ where: { role: 'TRAVEL_CONSULTANT', isActive: true } });
  });

  it('composes a case-insensitive name/email search into the where clause', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { user: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listEligibleTravelConsultants(db, { search: 'maria', skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: 'TRAVEL_CONSULTANT',
          isActive: true,
          OR: [
            { name: { contains: 'maria', mode: 'insensitive' } },
            { email: { contains: 'maria', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  it('applies pagination skip/take', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { user: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listEligibleTravelConsultants(db, { skip: 40, take: 20 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
  });

  it('returns the items and total unchanged from Prisma', async () => {
    const items = [{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }];
    const findMany = vi.fn().mockResolvedValue(items);
    const count = vi.fn().mockResolvedValue(1);
    const db = { user: { findMany, count } } as unknown as Prisma.TransactionClient;

    const result = await listEligibleTravelConsultants(db, { skip: 0, take: 20 });

    expect(result).toEqual({ items, total: 1 });
  });
});
