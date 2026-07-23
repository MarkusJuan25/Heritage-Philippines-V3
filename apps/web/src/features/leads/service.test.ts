import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db` (transitively, via
// @/lib/serializable-transaction, and directly for non-transactional
// reads/writes), which eagerly validates env vars and opens a real database
// adapter at import time. Mock it before `./service` is imported — the same
// reason features/bookings/service.test.ts mocks it.
const TX_CLIENT = { marker: 'tx-client' };
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { $transaction: transactionMock, marker: 'prisma-singleton' },
}));

const repositoryMocks = vi.hoisted(() => ({
  findLeadById: vi.fn(),
  listLeadsForActor: vi.fn(),
  createLeadWithInitialHistory: vi.fn(),
  updateLeadFields: vi.fn(),
  updateLeadStatusWithHistory: vi.fn(),
  findDuplicateLeadMatches: vi.fn(),
  findDuplicateClientMatches: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

const authorizationMocks = vi.hoisted(() => ({
  canAccessLead: vi.fn(),
  canAccessClient: vi.fn(),
}));
vi.mock('@/features/assignments/authorization', () => authorizationMocks);

const assignmentRepositoryMocks = vi.hoisted(() => ({
  createAssignment: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('@/features/assignments/repository', () => assignmentRepositoryMocks);

import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { LeadError } from './errors';
import type { LeadRecord } from './repository';
import { createLead, getLeadById, listLeads, updateLead, updateLeadStatus } from './service';

const ADMIN_MANAGER: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};
const TRAVEL_CONSULTANT: AuthenticatedUser = {
  id: 'tc-1',
  email: 'tc@example.test',
  name: 'TC',
  role: 'TRAVEL_CONSULTANT',
};

function leadRecord(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    id: 'lead-1',
    status: 'NEW',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: null,
    normalizedEmail: 'juan@example.com',
    normalizedPhone: null,
    source: 'Walk-in',
    notes: null,
    clientId: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
  authorizationMocks.canAccessLead.mockResolvedValue({ allowed: true });
  authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
  repositoryMocks.findDuplicateLeadMatches.mockResolvedValue([]);
  repositoryMocks.findDuplicateClientMatches.mockResolvedValue([]);
});

describe('role gating', () => {
  const REJECTED_ROLES = [
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'SYSTEM_ADMINISTRATOR',
    'CLIENT',
  ];

  it.each(REJECTED_ROLES)('createLead rejects role %s', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(
      createLead(actor, { fullName: 'Juan', source: 'Walk-in', email: 'juan@example.com' }),
    ).rejects.toThrow(LeadError);
    expect(repositoryMocks.createLeadWithInitialHistory).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)('getLeadById rejects role %s', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(getLeadById(actor, 'lead-1')).rejects.toThrow(LeadError);
    expect(authorizationMocks.canAccessLead).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)('listLeads rejects role %s', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(listLeads(actor, { page: 1, pageSize: 20 })).rejects.toThrow(LeadError);
    expect(repositoryMocks.listLeadsForActor).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)('updateLead rejects role %s', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(updateLead(actor, 'lead-1', {})).rejects.toThrow(LeadError);
    expect(authorizationMocks.canAccessLead).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)('updateLeadStatus rejects role %s', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(
      updateLeadStatus(actor, 'lead-1', { expectedStatus: 'NEW', newStatus: 'UNDER_REVIEW' }),
    ).rejects.toThrow(LeadError);
    expect(authorizationMocks.canAccessLead).not.toHaveBeenCalled();
  });
});

describe('createLead', () => {
  it('creates a Lead for ADMIN_MANAGER without an auto-assignment', async () => {
    const created = leadRecord();
    repositoryMocks.createLeadWithInitialHistory.mockResolvedValue(created);

    const result = await createLead(ADMIN_MANAGER, {
      fullName: 'Juan Dela Cruz',
      source: 'Walk-in',
      email: 'juan@example.com',
    });

    expect(result.lead).toBe(created);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ action: 'LEAD_CREATED', entityType: 'Lead' }),
    );
    expect(assignmentRepositoryMocks.createAssignment).not.toHaveBeenCalled();
    expect(assignmentRepositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('atomically self-assigns a TRAVEL_CONSULTANT-created Lead and writes LEAD_ASSIGNED', async () => {
    const created = leadRecord();
    repositoryMocks.createLeadWithInitialHistory.mockResolvedValue(created);
    assignmentRepositoryMocks.createAssignment.mockResolvedValue({
      id: 'assignment-1',
      assignedStaffId: TRAVEL_CONSULTANT.id,
      assignedByUserId: TRAVEL_CONSULTANT.id,
      leadId: created.id,
      clientId: null,
      bookingId: null,
      endedAt: null,
    });

    await createLead(TRAVEL_CONSULTANT, {
      fullName: 'Juan',
      source: 'Phone inquiry',
      phone: '0917 123 4567',
    });

    expect(assignmentRepositoryMocks.createAssignment).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        assignedStaffId: TRAVEL_CONSULTANT.id,
        assignedByUserId: TRAVEL_CONSULTANT.id,
        leadId: created.id,
      }),
    );
    expect(assignmentRepositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ action: 'LEAD_ASSIGNMENT_CREATED', entityType: 'Lead' }),
    );
  });

  it('rejects when neither email nor phone normalizes to a usable value is not reachable via the schema, but service still normalizes what it is given', async () => {
    repositoryMocks.createLeadWithInitialHistory.mockResolvedValue(leadRecord());

    await createLead(ADMIN_MANAGER, {
      fullName: 'Juan',
      source: 'Walk-in',
      email: 'Juan@Example.COM',
    });

    expect(repositoryMocks.createLeadWithInitialHistory).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ normalizedEmail: 'juan@example.com' }),
    );
  });

  it('runs duplicate detection before creating the Lead, using submitted values, and shapes visibility', async () => {
    repositoryMocks.createLeadWithInitialHistory.mockResolvedValue(leadRecord());
    repositoryMocks.findDuplicateLeadMatches.mockResolvedValue([
      { id: 'lead-existing', fullName: 'Maria', status: 'QUALIFIED', matchedOn: ['EMAIL'] },
    ]);
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: true });

    const result = await createLead(ADMIN_MANAGER, {
      fullName: 'Juan',
      source: 'Walk-in',
      email: 'juan@example.com',
    });

    expect(repositoryMocks.findDuplicateLeadMatches).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ normalizedEmail: 'juan@example.com' }),
    );
    // No exclusion at creation time — the new Lead cannot exist yet in the query results.
    expect(repositoryMocks.findDuplicateLeadMatches.mock.calls[0]?.[1]?.excludeId).toBeUndefined();
    expect(result.duplicateMatches).toEqual([
      {
        type: 'LEAD',
        id: 'lead-existing',
        fullName: 'Maria',
        status: 'QUALIFIED',
        matchedOn: ['EMAIL'],
      },
    ]);
    expect(result.restrictedMatchDetected).toBe(false);
  });

  it('collapses an unauthorized match into restrictedMatchDetected without leaking its identity', async () => {
    repositoryMocks.createLeadWithInitialHistory.mockResolvedValue(leadRecord());
    repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
      { id: 'client-hidden', fullName: 'Hidden Client', matchedOn: ['PHONE'] },
    ]);
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    const result = await createLead(TRAVEL_CONSULTANT, {
      fullName: 'Juan',
      source: 'Walk-in',
      phone: '0917 123 4567',
    });

    expect(authorizationMocks.canAccessClient).toHaveBeenCalledWith(
      TRAVEL_CONSULTANT,
      'client-hidden',
    );
    expect(authorizationMocks.canAccessLead).not.toHaveBeenCalledWith(
      TRAVEL_CONSULTANT,
      'client-hidden',
    );
    expect(result.duplicateMatches).toEqual([]);
    expect(result.restrictedMatchDetected).toBe(true);
    expect(JSON.stringify(result)).not.toContain('client-hidden');
    expect(JSON.stringify(result)).not.toContain('Hidden Client');
  });
});

describe('getLeadById', () => {
  it('returns NOT_FOUND for ADMIN_MANAGER when canAccessLead rejects', async () => {
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

    await expect(getLeadById(ADMIN_MANAGER, 'lead-1')).rejects.toMatchObject({
      code: 'LEAD_NOT_FOUND',
    });
  });

  it('returns FORBIDDEN for TRAVEL_CONSULTANT when canAccessLead rejects', async () => {
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

    await expect(getLeadById(TRAVEL_CONSULTANT, 'lead-1')).rejects.toMatchObject({
      code: 'LEAD_FORBIDDEN',
    });
  });

  it('returns the Lead when authorized and found', async () => {
    const record = leadRecord();
    repositoryMocks.findLeadById.mockResolvedValue(record);

    const result = await getLeadById(ADMIN_MANAGER, 'lead-1');
    expect(result).toBe(record);
  });

  it('returns NOT_FOUND for ADMIN_MANAGER when the Lead does not exist despite unconditional access', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(null);

    await expect(getLeadById(ADMIN_MANAGER, 'lead-missing')).rejects.toMatchObject({
      code: 'LEAD_NOT_FOUND',
    });
  });
});

describe('listLeads', () => {
  it('delegates to the actor-scoped repository query', async () => {
    repositoryMocks.listLeadsForActor.mockResolvedValue({ items: [], total: 0 });

    const result = await listLeads(TRAVEL_CONSULTANT, { page: 2, pageSize: 10 });

    expect(repositoryMocks.listLeadsForActor).toHaveBeenCalledWith(
      prisma,
      { id: TRAVEL_CONSULTANT.id, role: 'TRAVEL_CONSULTANT' },
      { skip: 10, take: 10, status: undefined, source: undefined, search: undefined },
    );
    expect(result).toEqual({ items: [], page: 2, pageSize: 10, total: 0 });
  });
});

describe('updateLead', () => {
  it('rejects with LEAD_LOCKED once the Lead is CONVERTED_TO_CLIENT', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'CONVERTED_TO_CLIENT' }));

    await expect(
      updateLead(ADMIN_MANAGER, 'lead-1', { fullName: 'New Name' }),
    ).rejects.toMatchObject({ code: 'LEAD_LOCKED' });
    expect(repositoryMocks.updateLeadFields).not.toHaveBeenCalled();
  });

  it('rejects a patch that would leave both final email and phone absent', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(
      leadRecord({ email: 'juan@example.com', phone: null }),
    );

    // `null` here mirrors what the schema layer's blank->null transform
    // already produces before the service ever sees the patch (see
    // schemas.ts's `patchEmailSchema`) — never a raw blank string.
    await expect(updateLead(ADMIN_MANAGER, 'lead-1', { email: null })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(repositoryMocks.updateLeadFields).not.toHaveBeenCalled();
  });

  it('allows clearing email when phone remains present in the final state', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(
      leadRecord({ email: 'juan@example.com', phone: '639171234567' }),
    );
    repositoryMocks.updateLeadFields.mockResolvedValue(leadRecord({ email: null }));

    const result = await updateLead(ADMIN_MANAGER, 'lead-1', { email: null });

    expect(repositoryMocks.updateLeadFields).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ id: 'lead-1', email: null, normalizedEmail: null }),
    );
    expect(result.lead.email).toBeNull();
  });

  it('does not validate contact presence from the partial request alone (existing phone covers an email-only patch)', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(
      leadRecord({ email: 'old@example.com', phone: '639171234567' }),
    );
    repositoryMocks.updateLeadFields.mockResolvedValue(leadRecord({ email: 'new@example.com' }));

    await updateLead(ADMIN_MANAGER, 'lead-1', { email: 'new@example.com' });

    expect(repositoryMocks.updateLeadFields).toHaveBeenCalled();
  });

  it('reruns duplicate detection using the final combined normalized value, excluding the current Lead', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(
      leadRecord({ id: 'lead-1', email: 'old@example.com', phone: null }),
    );
    repositoryMocks.updateLeadFields.mockResolvedValue(leadRecord({ email: 'new@example.com' }));

    await updateLead(ADMIN_MANAGER, 'lead-1', { email: 'new@example.com' });

    expect(repositoryMocks.findDuplicateLeadMatches).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ normalizedEmail: 'new@example.com', excludeId: 'lead-1' }),
    );
  });

  it('does not rerun duplicate detection when neither email nor phone is in the patch', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord());
    repositoryMocks.updateLeadFields.mockResolvedValue(leadRecord({ notes: 'a note' }));

    await updateLead(ADMIN_MANAGER, 'lead-1', { notes: 'a note' });

    expect(repositoryMocks.findDuplicateLeadMatches).not.toHaveBeenCalled();
  });

  it('records only changed field names in the audit snapshot, never raw values', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ fullName: 'Old Name' }));
    repositoryMocks.updateLeadFields.mockResolvedValue(leadRecord({ fullName: 'New Name' }));

    await updateLead(ADMIN_MANAGER, 'lead-1', { fullName: 'New Name' });

    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        action: 'LEAD_UPDATED',
        afterState: expect.objectContaining({ changedFields: ['fullName'] }),
      }),
    );
    const call = repositoryMocks.insertAuditLog.mock.calls[0]?.[1];
    expect(JSON.stringify(call)).not.toContain('New Name');
  });

  it('is a no-op (no write, no audit) when the patch changes nothing', async () => {
    const record = leadRecord({ fullName: 'Same Name' });
    repositoryMocks.findLeadById.mockResolvedValue(record);

    const result = await updateLead(ADMIN_MANAGER, 'lead-1', { fullName: 'Same Name' });

    expect(result.lead).toBe(record);
    expect(repositoryMocks.updateLeadFields).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND/FORBIDDEN when canAccessLead rejects, without reading the record', async () => {
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

    await expect(updateLead(TRAVEL_CONSULTANT, 'lead-1', { fullName: 'X' })).rejects.toMatchObject({
      code: 'LEAD_FORBIDDEN',
    });
    expect(repositoryMocks.findLeadById).not.toHaveBeenCalled();
  });
});

describe('updateLeadStatus', () => {
  it('is an idempotent no-op when newStatus equals the current status, even with a stale expectedStatus', async () => {
    const record = leadRecord({ status: 'QUALIFIED' });
    repositoryMocks.findLeadById.mockResolvedValue(record);

    const result = await updateLeadStatus(ADMIN_MANAGER, 'lead-1', {
      expectedStatus: 'NEW', // stale — does not match current QUALIFIED
      newStatus: 'QUALIFIED',
    });

    expect(result).toBe(record);
    expect(repositoryMocks.updateLeadStatusWithHistory).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('returns LEAD_CONFLICT when expectedStatus does not match the actual current status', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'QUALIFIED' }));

    await expect(
      updateLeadStatus(ADMIN_MANAGER, 'lead-1', {
        expectedStatus: 'NEW',
        newStatus: 'UNDER_REVIEW',
      }),
    ).rejects.toMatchObject({ code: 'LEAD_CONFLICT' });
  });

  it('returns CONVERSION_ENDPOINT_REQUIRED for QUALIFIED -> CONVERTED_TO_CLIENT', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'QUALIFIED' }));

    await expect(
      updateLeadStatus(ADMIN_MANAGER, 'lead-1', {
        expectedStatus: 'QUALIFIED',
        newStatus: 'CONVERTED_TO_CLIENT',
      }),
    ).rejects.toMatchObject({ code: 'CONVERSION_ENDPOINT_REQUIRED' });
  });

  it('returns INVALID_STATUS_TRANSITION for a rejected transition', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'NEW' }));

    await expect(
      updateLeadStatus(ADMIN_MANAGER, 'lead-1', {
        expectedStatus: 'NEW',
        newStatus: 'CONVERTED_TO_CLIENT',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('returns REASON_REQUIRED for a corrective transition with no reason', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'SPAM' }));

    await expect(
      updateLeadStatus(ADMIN_MANAGER, 'lead-1', {
        expectedStatus: 'SPAM',
        newStatus: 'UNDER_REVIEW',
      }),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    expect(repositoryMocks.updateLeadStatusWithHistory).not.toHaveBeenCalled();
  });

  it('performs the real transition atomically and persists the reason when supplied', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'SPAM' }));
    repositoryMocks.updateLeadStatusWithHistory.mockResolvedValue(
      leadRecord({ status: 'UNDER_REVIEW' }),
    );

    const result = await updateLeadStatus(ADMIN_MANAGER, 'lead-1', {
      expectedStatus: 'SPAM',
      newStatus: 'UNDER_REVIEW',
      reason: 'Misclassified as spam',
    });

    expect(result.status).toBe('UNDER_REVIEW');
    expect(repositoryMocks.updateLeadStatusWithHistory).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ id: 'lead-1', previousStatus: 'SPAM', newStatus: 'UNDER_REVIEW' }),
    );
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        action: 'LEAD_STATUS_CHANGED',
        afterState: { status: 'UNDER_REVIEW', reason: 'Misclassified as spam' },
      }),
    );
  });

  it('does not require a reason for an ordinary forward transition', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'NEW' }));
    repositoryMocks.updateLeadStatusWithHistory.mockResolvedValue(
      leadRecord({ status: 'QUALIFIED' }),
    );

    const result = await updateLeadStatus(ADMIN_MANAGER, 'lead-1', {
      expectedStatus: 'NEW',
      newStatus: 'QUALIFIED',
    });

    expect(result.status).toBe('QUALIFIED');
  });

  it('returns NOT_FOUND/FORBIDDEN when canAccessLead rejects before opening a transaction', async () => {
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

    await expect(
      updateLeadStatus(TRAVEL_CONSULTANT, 'lead-1', {
        expectedStatus: 'NEW',
        newStatus: 'CONTACTED',
      }),
    ).rejects.toMatchObject({ code: 'LEAD_FORBIDDEN' });
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
