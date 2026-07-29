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
  findLeadByIdForRead: vi.fn(),
  listLeadsForActor: vi.fn(),
  createLeadWithInitialHistory: vi.fn(),
  updateLeadFields: vi.fn(),
  updateLeadStatusWithHistory: vi.fn(),
  findDuplicateLeadMatches: vi.fn(),
  findDuplicateClientMatches: vi.fn(),
  insertAuditLog: vi.fn(),
  listLeadStatusHistory: vi.fn(),
  createClientFromLead: vi.fn(),
  findClientSummaryById: vi.fn(),
  convertLeadWithHistory: vi.fn(),
  findLeadConversionAudit: vi.fn(),
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
  findActiveAssignmentForLead: vi.fn(),
  findActiveAssignmentForClient: vi.fn(),
}));
vi.mock('@/features/assignments/repository', () => assignmentRepositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { LeadError } from './errors';
import type { LeadRecord, LeadRecordWithAssignment } from './repository';
import {
  convertLead,
  createLead,
  getConversionOptions,
  getLeadById,
  getLeadStatusHistory,
  listLeads,
  updateLead,
  updateLeadStatus,
} from './service';

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

// GET-only fixture (D-023 §5) — deliberately a distinct helper from
// leadRecord() (Stage 2 correction), matching the structural separation
// between LeadRecord (mutation responses) and LeadRecordWithAssignment
// (GET /api/leads, GET /api/leads/[id] only) in repository.ts.
function leadRecordWithAssignment(
  overrides: Partial<LeadRecordWithAssignment> = {},
): LeadRecordWithAssignment {
  return { ...leadRecord(), assignment: null, ...overrides };
}

type AssignmentRecordFixture = {
  id: string;
  assignedStaffId: string;
  assignedByUserId: string;
  leadId: string | null;
  clientId: string | null;
  bookingId: string | null;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
};

function assignmentRecord(
  overrides: Partial<AssignmentRecordFixture> = {},
): AssignmentRecordFixture {
  return {
    id: 'assignment-1',
    assignedStaffId: TRAVEL_CONSULTANT.id,
    assignedByUserId: TRAVEL_CONSULTANT.id,
    leadId: 'lead-1',
    clientId: null,
    bookingId: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    endedAt: null,
    ...overrides,
  };
}

function conflictError(code: 'P2034' | 'P2002' | 'P2004'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Simulated database conflict', {
    code,
    clientVersion: '7.8.0',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
  authorizationMocks.canAccessLead.mockResolvedValue({ allowed: true });
  authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
  repositoryMocks.findDuplicateLeadMatches.mockResolvedValue([]);
  repositoryMocks.findDuplicateClientMatches.mockResolvedValue([]);
  assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);
  assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);
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

  it.each(REJECTED_ROLES)('getLeadStatusHistory rejects role %s', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(getLeadStatusHistory(actor, 'lead-1', { page: 1, pageSize: 20 })).rejects.toThrow(
      LeadError,
    );
    expect(authorizationMocks.canAccessLead).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)('convertLead rejects role %s with ROLE_NOT_PERMITTED', async (role) => {
    const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
    await expect(
      convertLead(actor, 'lead-1', { expectedStatus: 'QUALIFIED' }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    expect(authorizationMocks.canAccessLead).not.toHaveBeenCalled();
  });

  it.each(REJECTED_ROLES)(
    'getConversionOptions rejects role %s with ROLE_NOT_PERMITTED',
    async (role) => {
      const actor = { ...ADMIN_MANAGER, role: role as AuthenticatedUser['role'] };
      await expect(getConversionOptions(actor, 'lead-1')).rejects.toMatchObject({
        code: 'ROLE_NOT_PERMITTED',
      });
      expect(authorizationMocks.canAccessLead).not.toHaveBeenCalled();
    },
  );
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

  it('POST /api/leads response has no assignment key (Stage 2 correction)', async () => {
    const created = leadRecord();
    repositoryMocks.createLeadWithInitialHistory.mockResolvedValue(created);

    const result = await createLead(ADMIN_MANAGER, {
      fullName: 'Juan Dela Cruz',
      source: 'Walk-in',
      email: 'juan@example.com',
    });

    expect(result.lead).not.toHaveProperty('assignment');
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

  it('returns the Lead (with assignment) when authorized and found, via findLeadByIdForRead', async () => {
    const record = leadRecordWithAssignment({
      assignment: { staffId: 'tc-1', staffName: 'TC One' },
    });
    repositoryMocks.findLeadByIdForRead.mockResolvedValue(record);

    const result = await getLeadById(ADMIN_MANAGER, 'lead-1');
    expect(result).toBe(record);
    expect(repositoryMocks.findLeadById).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for ADMIN_MANAGER when the Lead does not exist despite unconditional access', async () => {
    repositoryMocks.findLeadByIdForRead.mockResolvedValue(null);

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

  it('returns each item with its populated or null assignment unchanged (D-023 §5)', async () => {
    const items = [
      leadRecordWithAssignment({ id: 'lead-1', assignment: null }),
      leadRecordWithAssignment({
        id: 'lead-2',
        assignment: { staffId: 'tc-1', staffName: 'TC One' },
      }),
    ];
    repositoryMocks.listLeadsForActor.mockResolvedValue({ items, total: 2 });

    const result = await listLeads(ADMIN_MANAGER, { page: 1, pageSize: 20 });

    expect(result.items).toEqual(items);
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

  it('PATCH /api/leads/[id] response has no assignment key (Stage 2 correction)', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord());
    repositoryMocks.updateLeadFields.mockResolvedValue(leadRecord({ fullName: 'New Name' }));

    const result = await updateLead(ADMIN_MANAGER, 'lead-1', { fullName: 'New Name' });

    expect(result.lead).not.toHaveProperty('assignment');
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

  it('PUT /api/leads/[id]/status response has no assignment key (Stage 2 correction)', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'SPAM' }));
    repositoryMocks.updateLeadStatusWithHistory.mockResolvedValue(
      leadRecord({ status: 'UNDER_REVIEW' }),
    );

    const result = await updateLeadStatus(ADMIN_MANAGER, 'lead-1', {
      expectedStatus: 'SPAM',
      newStatus: 'UNDER_REVIEW',
      reason: 'Misclassified as spam',
    });

    expect(result).not.toHaveProperty('assignment');
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

describe('getLeadStatusHistory', () => {
  it('returns NOT_FOUND for ADMIN_MANAGER when canAccessLead rejects', async () => {
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

    await expect(
      getLeadStatusHistory(ADMIN_MANAGER, 'lead-1', { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'LEAD_NOT_FOUND' });
  });

  it('returns FORBIDDEN for TRAVEL_CONSULTANT when canAccessLead rejects', async () => {
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

    await expect(
      getLeadStatusHistory(TRAVEL_CONSULTANT, 'lead-1', { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'LEAD_FORBIDDEN' });
  });

  it('returns NOT_FOUND for ADMIN_MANAGER when the Lead does not exist despite unconditional access', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(null);

    await expect(
      getLeadStatusHistory(ADMIN_MANAGER, 'lead-missing', { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'LEAD_NOT_FOUND' });
    expect(repositoryMocks.listLeadStatusHistory).not.toHaveBeenCalled();
  });

  it('delegates to the repository with computed skip/take and forwards page/pageSize', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord());
    repositoryMocks.listLeadStatusHistory.mockResolvedValue({ items: [], total: 0 });

    const result = await getLeadStatusHistory(ADMIN_MANAGER, 'lead-1', { page: 3, pageSize: 10 });

    expect(repositoryMocks.listLeadStatusHistory).toHaveBeenCalledWith(prisma, {
      leadId: 'lead-1',
      skip: 20,
      take: 10,
    });
    expect(result).toEqual({ items: [], page: 3, pageSize: 10, total: 0 });
  });

  it('returns the items unchanged, never fabricating a reason field', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord());
    const historyItems = [
      {
        id: 'history-1',
        previousStatus: null,
        newStatus: 'NEW',
        changedByUserId: 'actor-1',
        changedByName: 'Admin Manager',
        createdAt: new Date('2026-07-23T00:00:00Z'),
      },
    ];
    repositoryMocks.listLeadStatusHistory.mockResolvedValue({ items: historyItems, total: 1 });

    const result = await getLeadStatusHistory(ADMIN_MANAGER, 'lead-1', { page: 1, pageSize: 20 });

    expect(result.items).toEqual(historyItems);
    expect(JSON.stringify(result.items)).not.toContain('reason');
  });
});

describe('convertLead', () => {
  const CONVERT_INPUT = { expectedStatus: 'QUALIFIED' as const };

  describe('ADMIN_MANAGER create-new', () => {
    it("creates a new Client from the Lead's own fields, converts the Lead, and writes both audit entries", async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED', clientId: null });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.createClientFromLead.mockResolvedValue({
        id: 'client-1',
        fullName: found.fullName,
      });
      repositoryMocks.convertLeadWithHistory.mockResolvedValue(
        leadRecord({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' }),
      );

      const result = await convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT);

      expect(result.client).toEqual({ id: 'client-1', fullName: found.fullName });
      expect(result.clientCreated).toBe(true);
      expect(repositoryMocks.createClientFromLead).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({
          fullName: found.fullName,
          email: found.email,
          phone: found.phone,
          normalizedEmail: found.normalizedEmail,
          normalizedPhone: found.normalizedPhone,
        }),
      );
      expect(repositoryMocks.convertLeadWithHistory).toHaveBeenCalledWith(TX_CLIENT, {
        id: 'lead-1',
        clientId: 'client-1',
        changedByUserId: ADMIN_MANAGER.id,
      });
      expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({
          action: 'CLIENT_CREATED',
          entityType: 'Client',
          entityId: 'client-1',
        }),
      );
      expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({
          action: 'LEAD_CONVERTED_TO_CLIENT',
          entityType: 'Lead',
          entityId: 'lead-1',
          afterState: { status: 'CONVERTED_TO_CLIENT', clientId: 'client-1', clientCreated: true },
        }),
      );
    });

    it('never leaks raw email/phone/notes into either audit snapshot', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'QUALIFIED',
        email: 'juan@example.com',
        phone: '639171234567',
        notes: 'Prefers weekend calls',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.createClientFromLead.mockResolvedValue({
        id: 'client-1',
        fullName: found.fullName,
      });
      repositoryMocks.convertLeadWithHistory.mockResolvedValue(
        leadRecord({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' }),
      );

      await convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT);

      const auditPayload = JSON.stringify(repositoryMocks.insertAuditLog.mock.calls);
      expect(auditPayload).not.toContain('juan@example.com');
      expect(auditPayload).not.toContain('639171234567');
      expect(auditPayload).not.toContain('Prefers weekend calls');
    });
  });

  describe('TRAVEL_CONSULTANT authorization', () => {
    it("allows conversion when the TC holds the Lead's current active assignment", async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: TRAVEL_CONSULTANT.id }),
      );
      repositoryMocks.createClientFromLead.mockResolvedValue({
        id: 'client-1',
        fullName: found.fullName,
      });
      assignmentRepositoryMocks.createAssignment.mockResolvedValue(
        assignmentRecord({ id: 'assignment-2', clientId: 'client-1', leadId: null }),
      );
      repositoryMocks.convertLeadWithHistory.mockResolvedValue(
        leadRecord({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' }),
      );

      const result = await convertLead(TRAVEL_CONSULTANT, 'lead-1', CONVERT_INPUT);

      expect(result.clientCreated).toBe(true);
      expect(repositoryMocks.convertLeadWithHistory).toHaveBeenCalled();
    });

    it('rejects at the pre-transaction gate when canAccessLead denies (no assignment)', async () => {
      authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

      await expect(convertLead(TRAVEL_CONSULTANT, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_FORBIDDEN',
      });
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejects via the transaction-scoped recheck when the active assignment ended since the initial check', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);

      await expect(convertLead(TRAVEL_CONSULTANT, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_FORBIDDEN',
      });
      expect(repositoryMocks.convertLeadWithHistory).not.toHaveBeenCalled();
    });

    it('rejects via the transaction-scoped recheck when the active assignment belongs to a different staff member', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: 'other-tc' }),
      );

      await expect(convertLead(TRAVEL_CONSULTANT, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_FORBIDDEN',
      });
      expect(repositoryMocks.convertLeadWithHistory).not.toHaveBeenCalled();
    });
  });

  describe('Client matching and linking', () => {
    it('requires explicit linking (CLIENT_MATCH_REQUIRES_LINK) when a Client match exists and no clientId is supplied', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
        { id: 'client-existing', fullName: 'Maria', matchedOn: ['EMAIL'] },
      ]);

      await expect(convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'CLIENT_MATCH_REQUIRES_LINK',
      });
      expect(repositoryMocks.createClientFromLead).not.toHaveBeenCalled();
    });

    it('blocks new-Client creation for a TRAVEL_CONSULTANT even when every match is restricted (same code)', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: TRAVEL_CONSULTANT.id }),
      );
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
        { id: 'client-hidden', fullName: 'Hidden Client', matchedOn: ['PHONE'] },
      ]);

      await expect(convertLead(TRAVEL_CONSULTANT, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'CLIENT_MATCH_REQUIRES_LINK',
      });
      expect(repositoryMocks.createClientFromLead).not.toHaveBeenCalled();
    });

    it('links to an existing Client on a contact match, without creating a new Client', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
        { id: 'client-existing', fullName: 'Maria', matchedOn: ['EMAIL'] },
      ]);
      repositoryMocks.convertLeadWithHistory.mockResolvedValue(
        leadRecord({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT', clientId: 'client-existing' }),
      );

      const result = await convertLead(ADMIN_MANAGER, 'lead-1', {
        expectedStatus: 'QUALIFIED',
        clientId: 'client-existing',
      });

      expect(result.client).toEqual({ id: 'client-existing', fullName: 'Maria' });
      expect(result.clientCreated).toBe(false);
      expect(repositoryMocks.createClientFromLead).not.toHaveBeenCalled();
      expect(assignmentRepositoryMocks.createAssignment).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({ action: 'CLIENT_CREATED' }),
      );
      expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({
          action: 'LEAD_CONVERTED_TO_CLIENT',
          afterState: {
            status: 'CONVERTED_TO_CLIENT',
            clientId: 'client-existing',
            clientCreated: false,
          },
        }),
      );
    });

    it('rejects a supplied clientId with no matching contact channel (CLIENT_LINK_NOT_AVAILABLE)', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([]);

      await expect(
        convertLead(ADMIN_MANAGER, 'lead-1', {
          expectedStatus: 'QUALIFIED',
          clientId: 'client-unrelated',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });
      expect(repositoryMocks.convertLeadWithHistory).not.toHaveBeenCalled();
    });

    it('rejects at the pre-transaction gate when canAccessClient denies the supplied clientId', async () => {
      authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

      await expect(
        convertLead(TRAVEL_CONSULTANT, 'lead-1', {
          expectedStatus: 'QUALIFIED',
          clientId: 'client-1',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('rejects a TRAVEL_CONSULTANT link via the transaction-scoped Client recheck when unassigned to that Client', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: TRAVEL_CONSULTANT.id }),
      );
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
        { id: 'client-existing', fullName: 'Maria', matchedOn: ['EMAIL'] },
      ]);
      assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

      await expect(
        convertLead(TRAVEL_CONSULTANT, 'lead-1', {
          expectedStatus: 'QUALIFIED',
          clientId: 'client-existing',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });
      expect(repositoryMocks.convertLeadWithHistory).not.toHaveBeenCalled();
    });
  });

  describe('assignment inheritance', () => {
    it("inherits the Lead's active assignee onto a newly created Client, actor as assignedByUserId", async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: 'tc-original' }),
      );
      repositoryMocks.createClientFromLead.mockResolvedValue({
        id: 'client-1',
        fullName: found.fullName,
      });
      assignmentRepositoryMocks.createAssignment.mockResolvedValue(
        assignmentRecord({
          id: 'assignment-2',
          assignedStaffId: 'tc-original',
          clientId: 'client-1',
          leadId: null,
        }),
      );
      repositoryMocks.convertLeadWithHistory.mockResolvedValue(
        leadRecord({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' }),
      );

      // ADMIN_MANAGER converts a Lead assigned to a different TC — the
      // inherited Client assignment keeps the TC as assignee but records
      // the converting ADMIN_MANAGER as assignedByUserId (D-024 §5).
      await convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT);

      expect(assignmentRepositoryMocks.createAssignment).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({
          assignedStaffId: 'tc-original',
          assignedByUserId: ADMIN_MANAGER.id,
          clientId: 'client-1',
        }),
      );
      expect(assignmentRepositoryMocks.insertAuditLog).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({
          action: 'CLIENT_ASSIGNMENT_CREATED',
          entityType: 'Client',
          entityId: 'client-1',
        }),
      );
    });

    it('creates no assignment when the Lead has no active assignee', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(null);
      repositoryMocks.createClientFromLead.mockResolvedValue({
        id: 'client-1',
        fullName: found.fullName,
      });
      repositoryMocks.convertLeadWithHistory.mockResolvedValue(
        leadRecord({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' }),
      );

      await convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT);

      expect(assignmentRepositoryMocks.createAssignment).not.toHaveBeenCalled();
      expect(assignmentRepositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('never creates, ends, or changes an assignment when linking to an existing Client', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'QUALIFIED' });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: ADMIN_MANAGER.id }),
      );
      repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
        { id: 'client-existing', fullName: 'Maria', matchedOn: ['EMAIL'] },
      ]);
      repositoryMocks.convertLeadWithHistory.mockResolvedValue(
        leadRecord({ id: 'lead-1', status: 'CONVERTED_TO_CLIENT', clientId: 'client-existing' }),
      );

      await convertLead(ADMIN_MANAGER, 'lead-1', {
        expectedStatus: 'QUALIFIED',
        clientId: 'client-existing',
      });

      expect(assignmentRepositoryMocks.createAssignment).not.toHaveBeenCalled();
      expect(assignmentRepositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });
  });

  describe('idempotent replay', () => {
    it('replays a create-new conversion, returning the audited clientCreated: true, with no new writes', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-1',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findLeadConversionAudit.mockResolvedValue({
        afterState: { status: 'CONVERTED_TO_CLIENT', clientId: 'client-1', clientCreated: true },
      });
      repositoryMocks.findClientSummaryById.mockResolvedValue({
        id: 'client-1',
        fullName: 'Juan Dela Cruz',
      });

      const result = await convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT);

      expect(result).toEqual({
        lead: found,
        client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
        clientCreated: true,
      });
      expect(repositoryMocks.createClientFromLead).not.toHaveBeenCalled();
      expect(repositoryMocks.convertLeadWithHistory).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
      expect(assignmentRepositoryMocks.createAssignment).not.toHaveBeenCalled();
    });

    it('replays a link-existing conversion, returning the audited clientCreated: false, with no new writes', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-existing',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findLeadConversionAudit.mockResolvedValue({
        afterState: {
          status: 'CONVERTED_TO_CLIENT',
          clientId: 'client-existing',
          clientCreated: false,
        },
      });
      repositoryMocks.findClientSummaryById.mockResolvedValue({
        id: 'client-existing',
        fullName: 'Maria',
      });

      const result = await convertLead(ADMIN_MANAGER, 'lead-1', {
        expectedStatus: 'QUALIFIED',
        clientId: 'client-existing',
      });

      expect(result.clientCreated).toBe(false);
      expect(result.client).toEqual({ id: 'client-existing', fullName: 'Maria' });
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('replays with an omitted clientId identically to a matching supplied clientId', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-1',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findLeadConversionAudit.mockResolvedValue({
        afterState: { status: 'CONVERTED_TO_CLIENT', clientId: 'client-1', clientCreated: true },
      });
      repositoryMocks.findClientSummaryById.mockResolvedValue({
        id: 'client-1',
        fullName: 'Juan Dela Cruz',
      });

      const result = await convertLead(ADMIN_MANAGER, 'lead-1', {
        expectedStatus: 'QUALIFIED',
        clientId: 'client-1',
      });

      expect(result.clientCreated).toBe(true);
    });

    it('returns LEAD_CONFLICT when the LEAD_CONVERTED_TO_CLIENT audit entry is missing', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-1',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findLeadConversionAudit.mockResolvedValue(null);

      await expect(convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_CONFLICT',
      });
    });

    it('returns LEAD_CONFLICT when the audit afterState.clientId disagrees with Lead.clientId', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-1',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findLeadConversionAudit.mockResolvedValue({
        afterState: {
          status: 'CONVERTED_TO_CLIENT',
          clientId: 'client-other',
          clientCreated: true,
        },
      });

      await expect(convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_CONFLICT',
      });
      expect(repositoryMocks.findClientSummaryById).not.toHaveBeenCalled();
    });

    it('returns LEAD_CONFLICT for a malformed audit afterState shape', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-1',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findLeadConversionAudit.mockResolvedValue({
        afterState: { status: 'CONVERTED_TO_CLIENT' },
      });

      await expect(convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_CONFLICT',
      });
    });

    it('returns LEAD_CONFLICT when the audit afterState carries the three valid fields plus an unexpected extra key', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-1',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      repositoryMocks.findLeadConversionAudit.mockResolvedValue({
        afterState: {
          status: 'CONVERTED_TO_CLIENT',
          clientId: 'client-1',
          clientCreated: true,
          unexpected: 'value',
        },
      });

      await expect(convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_CONFLICT',
      });
      expect(repositoryMocks.findClientSummaryById).not.toHaveBeenCalled();
    });

    it('returns LEAD_CONFLICT for a differing supplied clientId on an already-converted Lead, without reading the audit', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-1',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);

      await expect(
        convertLead(ADMIN_MANAGER, 'lead-1', {
          expectedStatus: 'QUALIFIED',
          clientId: 'client-different',
        }),
      ).rejects.toMatchObject({ code: 'LEAD_CONFLICT' });
      expect(repositoryMocks.findLeadConversionAudit).not.toHaveBeenCalled();
    });
  });

  describe('TRAVEL_CONSULTANT Client-assignment reauthorization on replay', () => {
    it('allows a replay with the same supplied clientId when both the Lead and Client assignments belong to that consultant', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-existing',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: TRAVEL_CONSULTANT.id }),
      );
      assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(
        assignmentRecord({
          id: 'assignment-client',
          assignedStaffId: TRAVEL_CONSULTANT.id,
          leadId: null,
          clientId: 'client-existing',
        }),
      );
      repositoryMocks.findLeadConversionAudit.mockResolvedValue({
        afterState: {
          status: 'CONVERTED_TO_CLIENT',
          clientId: 'client-existing',
          clientCreated: false,
        },
      });
      repositoryMocks.findClientSummaryById.mockResolvedValue({
        id: 'client-existing',
        fullName: 'Maria',
      });

      const result = await convertLead(TRAVEL_CONSULTANT, 'lead-1', {
        expectedStatus: 'QUALIFIED',
        clientId: 'client-existing',
      });

      expect(result).toEqual({
        lead: found,
        client: { id: 'client-existing', fullName: 'Maria' },
        clientCreated: false,
      });
    });

    it('rejects the replay with CLIENT_LINK_NOT_AVAILABLE when the Client assignment ended after the pre-transaction check', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-existing',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: TRAVEL_CONSULTANT.id }),
      );
      assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

      await expect(
        convertLead(TRAVEL_CONSULTANT, 'lead-1', {
          expectedStatus: 'QUALIFIED',
          clientId: 'client-existing',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });
    });

    it('rejects the replay with CLIENT_LINK_NOT_AVAILABLE when the Client assignment belongs to another consultant', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-existing',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: TRAVEL_CONSULTANT.id }),
      );
      assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(
        assignmentRecord({
          id: 'assignment-client',
          assignedStaffId: 'other-tc',
          leadId: null,
          clientId: 'client-existing',
        }),
      );

      await expect(
        convertLead(TRAVEL_CONSULTANT, 'lead-1', {
          expectedStatus: 'QUALIFIED',
          clientId: 'client-existing',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });
    });

    it('a denied replay reads neither the conversion audit nor the Client summary, and performs no writes', async () => {
      const found = leadRecord({
        id: 'lead-1',
        status: 'CONVERTED_TO_CLIENT',
        clientId: 'client-existing',
      });
      repositoryMocks.findLeadById.mockResolvedValue(found);
      assignmentRepositoryMocks.findActiveAssignmentForLead.mockResolvedValue(
        assignmentRecord({ assignedStaffId: TRAVEL_CONSULTANT.id }),
      );
      assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

      await expect(
        convertLead(TRAVEL_CONSULTANT, 'lead-1', {
          expectedStatus: 'QUALIFIED',
          clientId: 'client-existing',
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_LINK_NOT_AVAILABLE' });

      expect(repositoryMocks.findLeadConversionAudit).not.toHaveBeenCalled();
      expect(repositoryMocks.findClientSummaryById).not.toHaveBeenCalled();
      expect(repositoryMocks.convertLeadWithHistory).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });
  });

  describe('stale / non-idempotent conflict', () => {
    it('returns LEAD_CONFLICT for a Lead that was never QUALIFIED', async () => {
      const found = leadRecord({ id: 'lead-1', status: 'NEW' });
      repositoryMocks.findLeadById.mockResolvedValue(found);

      await expect(convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_CONFLICT',
      });
      expect(repositoryMocks.convertLeadWithHistory).not.toHaveBeenCalled();
    });
  });

  describe('transaction failure propagation', () => {
    it('propagates a non-conflict transaction failure unchanged, with no partial writes', async () => {
      repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'QUALIFIED' }));
      repositoryMocks.createClientFromLead.mockRejectedValue(new Error('db exploded'));

      await expect(convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT)).rejects.toThrow(
        'db exploded',
      );
      expect(repositoryMocks.convertLeadWithHistory).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it('maps a serialization conflict that survives every retry to LEAD_CONFLICT, never a raw Prisma error', async () => {
      transactionMock.mockImplementation(async () => {
        throw conflictError('P2034');
      });

      await expect(convertLead(ADMIN_MANAGER, 'lead-1', CONVERT_INPUT)).rejects.toMatchObject({
        code: 'LEAD_CONFLICT',
      });
    });
  });
});

describe('getConversionOptions', () => {
  it('returns NOT_FOUND for ADMIN_MANAGER when canAccessLead rejects', async () => {
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

    await expect(getConversionOptions(ADMIN_MANAGER, 'lead-1')).rejects.toMatchObject({
      code: 'LEAD_NOT_FOUND',
    });
  });

  it('returns FORBIDDEN for TRAVEL_CONSULTANT when canAccessLead rejects', async () => {
    authorizationMocks.canAccessLead.mockResolvedValue({ allowed: false, status: 403 });

    await expect(getConversionOptions(TRAVEL_CONSULTANT, 'lead-1')).rejects.toMatchObject({
      code: 'LEAD_FORBIDDEN',
    });
  });

  it('returns NOT_FOUND for ADMIN_MANAGER when the Lead does not exist despite unconditional access', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(null);

    await expect(getConversionOptions(ADMIN_MANAGER, 'lead-missing')).rejects.toMatchObject({
      code: 'LEAD_NOT_FOUND',
    });
  });

  it('throws CONVERSION_NOT_ELIGIBLE when the Lead is not QUALIFIED', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'NEW' }));

    await expect(getConversionOptions(ADMIN_MANAGER, 'lead-1')).rejects.toMatchObject({
      code: 'CONVERSION_NOT_ELIGIBLE',
    });
    expect(repositoryMocks.findDuplicateClientMatches).not.toHaveBeenCalled();
  });

  it('throws CONVERSION_NOT_ELIGIBLE for an already-converted Lead (no idempotent-read exception)', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(
      leadRecord({ status: 'CONVERTED_TO_CLIENT', clientId: 'client-1' }),
    );

    await expect(getConversionOptions(ADMIN_MANAGER, 'lead-1')).rejects.toMatchObject({
      code: 'CONVERSION_NOT_ELIGIBLE',
    });
  });

  it('returns no matches and restrictedMatchDetected: false when no Client matches the Lead', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'QUALIFIED' }));
    repositoryMocks.findDuplicateClientMatches.mockResolvedValue([]);

    const result = await getConversionOptions(ADMIN_MANAGER, 'lead-1');

    expect(result).toEqual({ accessibleMatches: [], restrictedMatchDetected: false });
  });

  it("re-runs Client-only duplicate detection against the Lead's own current contact fields", async () => {
    const found = leadRecord({
      status: 'QUALIFIED',
      normalizedEmail: 'juan@example.com',
      normalizedPhone: '639171234567',
    });
    repositoryMocks.findLeadById.mockResolvedValue(found);
    repositoryMocks.findDuplicateClientMatches.mockResolvedValue([]);

    await getConversionOptions(ADMIN_MANAGER, 'lead-1');

    expect(repositoryMocks.findDuplicateClientMatches).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        normalizedEmail: 'juan@example.com',
        normalizedPhone: '639171234567',
      }),
    );
    // Never Lead-type duplicate detection — D-024 §3 re-runs Client
    // matching only, unlike createLead/updateLead's findDuplicateMatches.
    expect(repositoryMocks.findDuplicateLeadMatches).not.toHaveBeenCalled();
  });

  it('returns each accessible Client match with only id/fullName/matchedOn', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'QUALIFIED' }));
    repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
      { id: 'client-1', fullName: 'Maria', matchedOn: ['EMAIL'] },
    ]);
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });

    const result = await getConversionOptions(ADMIN_MANAGER, 'lead-1');

    expect(result).toEqual({
      accessibleMatches: [{ id: 'client-1', fullName: 'Maria', matchedOn: ['EMAIL'] }],
      restrictedMatchDetected: false,
    });
  });

  it('collapses an inaccessible match into restrictedMatchDetected without leaking its identity', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'QUALIFIED' }));
    repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
      { id: 'client-hidden', fullName: 'Hidden Client', matchedOn: ['PHONE'] },
    ]);
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    const result = await getConversionOptions(TRAVEL_CONSULTANT, 'lead-1');

    expect(result.accessibleMatches).toEqual([]);
    expect(result.restrictedMatchDetected).toBe(true);
    expect(JSON.stringify(result)).not.toContain('client-hidden');
    expect(JSON.stringify(result)).not.toContain('Hidden Client');
  });

  it('returns both accessible and restricted results together when matches are mixed', async () => {
    repositoryMocks.findLeadById.mockResolvedValue(leadRecord({ status: 'QUALIFIED' }));
    repositoryMocks.findDuplicateClientMatches.mockResolvedValue([
      { id: 'client-visible', fullName: 'Visible Client', matchedOn: ['EMAIL'] },
      { id: 'client-hidden', fullName: 'Hidden Client', matchedOn: ['PHONE'] },
    ]);
    authorizationMocks.canAccessClient.mockImplementation(async (_actor: unknown, id: string) =>
      id === 'client-visible' ? { allowed: true } : { allowed: false, status: 403 },
    );

    const result = await getConversionOptions(TRAVEL_CONSULTANT, 'lead-1');

    expect(result.accessibleMatches).toEqual([
      { id: 'client-visible', fullName: 'Visible Client', matchedOn: ['EMAIL'] },
    ]);
    expect(result.restrictedMatchDetected).toBe(true);
  });
});
