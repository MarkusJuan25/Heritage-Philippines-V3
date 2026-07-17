import { beforeEach, describe, expect, it, vi } from 'vitest';

// authorization.ts imports `prisma` from `@/lib/db`, which eagerly
// validates env vars and opens a real database adapter at import time.
vi.mock('@/lib/db', () => ({ prisma: {} }));

const repositoryMocks = vi.hoisted(() => ({
  findActiveAssignmentForLead: vi.fn(),
  findActiveAssignmentForClient: vi.fn(),
  findClientProfileOwnership: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

import type { AuthenticatedUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import type { AssignmentRecord } from './repository';
import { canAccessClient, canAccessLead } from './authorization';

const LEAD_ID = 'lead-1';
const CLIENT_ID = 'client-1';

function actor(role: AppRole, id = 'user-1'): AuthenticatedUser {
  return { id, email: `${id}@example.test`, name: 'Test User', role };
}

function activeAssignment(assignedStaffId: string): AssignmentRecord {
  return {
    id: 'assignment-1',
    assignedStaffId,
    assignedByUserId: 'admin-1',
    leadId: LEAD_ID,
    clientId: null,
    bookingId: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    endedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('canAccessLead', () => {
  it('always allows ADMIN_MANAGER, without even querying the active assignment', async () => {
    const result = await canAccessLead(actor('ADMIN_MANAGER'), LEAD_ID);
    expect(result).toEqual({ allowed: true });
    expect(repositoryMocks.findActiveAssignmentForLead).not.toHaveBeenCalled();
  });

  it('allows a TRAVEL_CONSULTANT who holds the active assignment for this lead', async () => {
    const tc = actor('TRAVEL_CONSULTANT', 'tc-1');
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(activeAssignment('tc-1'));

    const result = await canAccessLead(tc, LEAD_ID);

    expect(result).toEqual({ allowed: true });
    expect(repositoryMocks.findActiveAssignmentForLead).toHaveBeenCalledWith(
      expect.anything(),
      LEAD_ID,
    );
  });

  it('rejects a TRAVEL_CONSULTANT who is not the currently assigned consultant', async () => {
    const otherTc = actor('TRAVEL_CONSULTANT', 'tc-2');
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(activeAssignment('tc-1'));

    const result = await canAccessLead(otherTc, LEAD_ID);

    expect(result).toEqual({ allowed: false, status: 403 });
  });

  it('rejects a TRAVEL_CONSULTANT when no assignment is active at all', async () => {
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);

    const result = await canAccessLead(actor('TRAVEL_CONSULTANT', 'tc-1'), LEAD_ID);

    expect(result).toEqual({ allowed: false, status: 403 });
  });

  it('rejects a TRAVEL_CONSULTANT whose assignment has since ended, even if they held it previously', async () => {
    // The repository's active-assignment query filters on endedAt: null,
    // so an ended assignment never comes back from
    // findActiveAssignmentForLead in the first place — simulated here by
    // resolving null, exactly as the real query would after the
    // assignment ends.
    repositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);

    const result = await canAccessLead(actor('TRAVEL_CONSULTANT', 'tc-1'), LEAD_ID);

    expect(result).toEqual({ allowed: false, status: 403 });
  });

  it.each(['SYSTEM_ADMINISTRATOR', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'CLIENT'])(
    'rejects role %s without querying the active assignment',
    async (role) => {
      const result = await canAccessLead(actor(role as AppRole), LEAD_ID);
      expect(result).toEqual({ allowed: false, status: 403 });
      expect(repositoryMocks.findActiveAssignmentForLead).not.toHaveBeenCalled();
    },
  );
});

describe('canAccessClient', () => {
  it('always allows ADMIN_MANAGER, without querying assignment or ownership', async () => {
    const result = await canAccessClient(actor('ADMIN_MANAGER'), CLIENT_ID);
    expect(result).toEqual({ allowed: true });
    expect(repositoryMocks.findActiveAssignmentForClient).not.toHaveBeenCalled();
    expect(repositoryMocks.findClientProfileOwnership).not.toHaveBeenCalled();
  });

  it('allows a TRAVEL_CONSULTANT who holds the active assignment for this client', async () => {
    const tc = actor('TRAVEL_CONSULTANT', 'tc-1');
    repositoryMocks.findActiveAssignmentForClient.mockResolvedValue({
      ...activeAssignment('tc-1'),
      leadId: null,
      clientId: CLIENT_ID,
    });

    const result = await canAccessClient(tc, CLIENT_ID);

    expect(result).toEqual({ allowed: true });
    expect(repositoryMocks.findClientProfileOwnership).not.toHaveBeenCalled();
  });

  it('rejects an unassigned TRAVEL_CONSULTANT', async () => {
    repositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

    const result = await canAccessClient(actor('TRAVEL_CONSULTANT', 'tc-1'), CLIENT_ID);

    expect(result).toEqual({ allowed: false, status: 403 });
  });

  it('rejects a TRAVEL_CONSULTANT who is not the currently assigned consultant', async () => {
    const otherTc = actor('TRAVEL_CONSULTANT', 'tc-2');
    repositoryMocks.findActiveAssignmentForClient.mockResolvedValue({
      ...activeAssignment('tc-1'),
      leadId: null,
      clientId: CLIENT_ID,
    });

    const result = await canAccessClient(otherTc, CLIENT_ID);

    expect(result).toEqual({ allowed: false, status: 403 });
  });

  it.each(['SYSTEM_ADMINISTRATOR', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION'])(
    'rejects role %s without querying assignment or ownership',
    async (role) => {
      const result = await canAccessClient(actor(role as AppRole), CLIENT_ID);
      expect(result).toEqual({ allowed: false, status: 403 });
      expect(repositoryMocks.findActiveAssignmentForClient).not.toHaveBeenCalled();
      expect(repositoryMocks.findClientProfileOwnership).not.toHaveBeenCalled();
    },
  );

  it('allows a CLIENT whose ClientProfile links their own User id to the requested Client id', async () => {
    const client = actor('CLIENT', 'user-1');
    repositoryMocks.findClientProfileOwnership.mockResolvedValue({ id: 'profile-1' });

    const result = await canAccessClient(client, CLIENT_ID);

    expect(result).toEqual({ allowed: true });
    expect(repositoryMocks.findClientProfileOwnership).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      CLIENT_ID,
    );
    expect(repositoryMocks.findActiveAssignmentForClient).not.toHaveBeenCalled();
  });

  it('rejects a CLIENT with no ClientProfile at all', async () => {
    repositoryMocks.findClientProfileOwnership.mockResolvedValue(null);

    const result = await canAccessClient(actor('CLIENT', 'user-1'), CLIENT_ID);

    expect(result).toEqual({ allowed: false, status: 403 });
  });

  it("rejects a CLIENT requesting a different client's record than their own ClientProfile links to", async () => {
    // The repository's ownership query scopes by both userId and clientId
    // in the query itself, so a ClientProfile that links this actor to a
    // *different* Client never comes back from findClientProfileOwnership
    // for this clientId — simulated here by resolving null, exactly as the
    // real scoped query would.
    repositoryMocks.findClientProfileOwnership.mockResolvedValue(null);

    const result = await canAccessClient(actor('CLIENT', 'user-1'), CLIENT_ID);

    expect(result).toEqual({ allowed: false, status: 403 });
    expect(repositoryMocks.findActiveAssignmentForClient).not.toHaveBeenCalled();
  });
});
