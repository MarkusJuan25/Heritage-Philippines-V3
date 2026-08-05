import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db`, which eagerly validates env
// vars and opens a real database adapter at import time. Mock it before
// `./service` is imported — the same reason
// features/bookings/service.test.ts and features/clients/service.test.ts
// mock it. `runSerializableWithRetry` itself is intentionally left
// unmocked (real implementation), so these tests exercise the real
// retry/backoff logic composed with a mocked `$transaction`.
const TX_CLIENT = { marker: 'tx-client' };
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { $transaction: transactionMock, marker: 'prisma-singleton' },
}));

const repositoryMocks = vi.hoisted(() => ({
  listProposalsForActor: vi.fn(),
  findProposalByIdForActor: vi.fn(),
  findProposalContext: vi.fn(),
  findProposalVersionContext: vi.fn(),
  findProposalVersionForActor: vi.fn(),
  createProposalWithFirstVersion: vi.fn(),
  createProposalRevision: vi.fn(),
  findCurrentClientVisibleVersion: vi.fn(),
  markProposalVersionSuperseded: vi.fn(),
  markProposalVersionClientVisible: vi.fn(),
  findProposalAcceptanceForVersion: vi.fn(),
  createExternalProposalAcceptance: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

const authorizationMocks = vi.hoisted(() => ({ canAccessClient: vi.fn() }));
vi.mock('@/features/assignments/authorization', () => authorizationMocks);

const assignmentRepositoryMocks = vi.hoisted(() => ({ findActiveAssignmentForClient: vi.fn() }));
vi.mock('@/features/assignments/repository', () => assignmentRepositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import type {
  ProposalAcceptanceRecord,
  ProposalActor,
  ProposalDetailRecord,
  ProposalListItem,
  ProposalRecord,
  ProposalVersionActorContext,
  ProposalVersionRecord,
} from './repository';
import {
  createProposal,
  createProposalRevision,
  getProposalById,
  listProposals,
  publishProposalVersion,
  recordProposalResponse,
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

const ADMIN_MANAGER_ACTOR: ProposalActor = { id: ADMIN_MANAGER.id, role: 'ADMIN_MANAGER' };
const TRAVEL_CONSULTANT_ACTOR: ProposalActor = {
  id: TRAVEL_CONSULTANT.id,
  role: 'TRAVEL_CONSULTANT',
};

const PROPOSAL_ID = 'proposal-1';
const VERSION_ID = 'version-1';
const CLIENT_ID = 'client-1';
const ACCEPTANCE_ID = 'acceptance-1';

function proposalRecord(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: PROPOSAL_ID,
    clientId: CLIENT_ID,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function versionRecord(overrides: Partial<ProposalVersionRecord> = {}): ProposalVersionRecord {
  return {
    id: VERSION_ID,
    proposalId: PROPOSAL_ID,
    versionNumber: 1,
    content: 'Day 1: Arrival.',
    clientVisibleAt: null,
    supersededAt: null,
    createdByUserId: TRAVEL_CONSULTANT.id,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function versionActorContext(
  overrides: Partial<ProposalVersionActorContext> = {},
): ProposalVersionActorContext {
  return {
    id: VERSION_ID,
    proposalId: PROPOSAL_ID,
    clientId: CLIENT_ID,
    versionNumber: 1,
    clientVisibleAt: null,
    supersededAt: null,
    ...overrides,
  };
}

function acceptanceRecord(
  overrides: Partial<ProposalAcceptanceRecord> = {},
): ProposalAcceptanceRecord {
  return {
    id: ACCEPTANCE_ID,
    proposalVersionId: VERSION_ID,
    responseType: 'ACCEPT',
    respondedAt: new Date('2026-08-04T10:00:00.000Z'),
    recordedByStaffUserId: ADMIN_MANAGER.id,
    responseMethod: 'phone',
    evidenceReference: 'Call log #4821',
    createdAt: new Date('2026-08-04T10:00:00.000Z'),
    ...overrides,
  };
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
    assignedByUserId: ADMIN_MANAGER.id,
    leadId: null,
    clientId: CLIENT_ID,
    bookingId: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    endedAt: null,
    ...overrides,
  };
}

function conflictError(
  code: 'P2034' | 'P2002' | 'P2004',
  target?: string[],
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Simulated database conflict', {
    code,
    clientVersion: '7.8.0',
    meta: target ? { target } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
  authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
  assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(assignmentRecord());
});

// ---------------------------------------------------------------------------
// Role gating (defense-in-depth beyond the future route layer's withRole)
// ---------------------------------------------------------------------------

const REJECTED_VIEWER_ROLES = [
  'SYSTEM_ADMINISTRATOR',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
] as const;
const REJECTED_AUTHOR_ROLES = [
  'ADMIN_MANAGER',
  'SYSTEM_ADMINISTRATOR',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
] as const;

function actorWithRole(role: AuthenticatedUser['role']): AuthenticatedUser {
  return { id: 'someone-1', email: 'someone@example.test', name: 'Someone', role };
}

describe('role gating', () => {
  it.each(REJECTED_VIEWER_ROLES)(
    'listProposals rejects %s with ROLE_NOT_PERMITTED before any repository call',
    async (role) => {
      await expect(
        listProposals(actorWithRole(role), { page: 1, pageSize: 20 }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
      expect(repositoryMocks.listProposalsForActor).not.toHaveBeenCalled();
    },
  );

  it.each(REJECTED_VIEWER_ROLES)(
    'getProposalById rejects %s with ROLE_NOT_PERMITTED before any repository call',
    async (role) => {
      await expect(getProposalById(actorWithRole(role), PROPOSAL_ID)).rejects.toMatchObject({
        code: 'ROLE_NOT_PERMITTED',
        status: 403,
      });
      expect(repositoryMocks.findProposalContext).not.toHaveBeenCalled();
    },
  );

  it.each(REJECTED_VIEWER_ROLES)(
    'recordProposalResponse rejects %s with ROLE_NOT_PERMITTED before any repository call',
    async (role) => {
      await expect(
        recordProposalResponse(actorWithRole(role), VERSION_ID, {
          responseType: 'ACCEPT',
          respondedAt: '2026-08-04T10:00:00.000Z',
          responseMethod: 'phone',
          evidenceReference: 'Call log #4821',
        }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
      expect(repositoryMocks.findProposalVersionContext).not.toHaveBeenCalled();
    },
  );

  it('listProposals/getProposalById/recordProposalResponse accept ADMIN_MANAGER and TRAVEL_CONSULTANT', async () => {
    repositoryMocks.listProposalsForActor.mockResolvedValue({ items: [], total: 0 });
    repositoryMocks.findProposalContext.mockResolvedValue({ id: PROPOSAL_ID, clientId: CLIENT_ID });
    repositoryMocks.findProposalByIdForActor.mockResolvedValue(null);

    await expect(listProposals(ADMIN_MANAGER, { page: 1, pageSize: 20 })).resolves.toBeDefined();
    await expect(
      listProposals(TRAVEL_CONSULTANT, { page: 1, pageSize: 20 }),
    ).resolves.toBeDefined();
    await expect(getProposalById(ADMIN_MANAGER, PROPOSAL_ID)).rejects.toMatchObject({
      code: 'PROPOSAL_NOT_FOUND',
    });
    await expect(getProposalById(TRAVEL_CONSULTANT, PROPOSAL_ID)).rejects.toMatchObject({
      code: 'PROPOSAL_FORBIDDEN',
    });
  });

  it.each(REJECTED_AUTHOR_ROLES)(
    'createProposal rejects %s with ROLE_NOT_PERMITTED, never opening a transaction or calling assertProposalAuthorAccess',
    async (role) => {
      await expect(
        createProposal(actorWithRole(role), { clientId: CLIENT_ID, content: 'Day 1.' }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
      expect(assignmentRepositoryMocks.findActiveAssignmentForClient).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it.each(REJECTED_AUTHOR_ROLES)(
    'createProposalRevision rejects %s with ROLE_NOT_PERMITTED, never opening a transaction',
    async (role) => {
      await expect(
        createProposalRevision(actorWithRole(role), PROPOSAL_ID, { content: 'Revised.' }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
      expect(repositoryMocks.findProposalContext).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it.each(REJECTED_AUTHOR_ROLES)(
    'publishProposalVersion rejects %s with ROLE_NOT_PERMITTED, never opening a transaction',
    async (role) => {
      await expect(
        publishProposalVersion(actorWithRole(role), VERSION_ID, { expectedCurrentVersionId: null }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
      expect(repositoryMocks.findProposalVersionContext).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it('createProposal/createProposalRevision/publishProposalVersion accept TRAVEL_CONSULTANT', async () => {
    repositoryMocks.findProposalContext.mockResolvedValue({ id: PROPOSAL_ID, clientId: CLIENT_ID });
    repositoryMocks.findProposalVersionContext.mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      clientId: CLIENT_ID,
    });
    repositoryMocks.createProposalWithFirstVersion.mockResolvedValue({
      proposal: proposalRecord(),
      version: versionRecord(),
    });
    repositoryMocks.createProposalRevision.mockResolvedValue(versionRecord({ versionNumber: 2 }));
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(
      versionActorContext({ clientVisibleAt: new Date(), supersededAt: null }),
    );

    await expect(
      createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' }),
    ).resolves.toBeDefined();
    await expect(
      createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' }),
    ).resolves.toBeDefined();
    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// listProposals
// ---------------------------------------------------------------------------

describe('listProposals', () => {
  it('computes skip from page/pageSize and passes the narrowed actor to the repository', async () => {
    const items: ProposalListItem[] = [];
    repositoryMocks.listProposalsForActor.mockResolvedValue({ items, total: 0 });

    const result = await listProposals(ADMIN_MANAGER, { page: 3, pageSize: 10 });

    expect(repositoryMocks.listProposalsForActor).toHaveBeenCalledWith(
      prisma,
      ADMIN_MANAGER_ACTOR,
      { skip: 20, take: 10 },
    );
    expect(result).toEqual({ items, page: 3, pageSize: 10, total: 0 });
  });

  it('passes the narrowed TRAVEL_CONSULTANT actor through', async () => {
    repositoryMocks.listProposalsForActor.mockResolvedValue({ items: [], total: 0 });

    await listProposals(TRAVEL_CONSULTANT, { page: 1, pageSize: 20 });

    expect(repositoryMocks.listProposalsForActor).toHaveBeenCalledWith(
      prisma,
      TRAVEL_CONSULTANT_ACTOR,
      { skip: 0, take: 20 },
    );
  });

  it('never calls canAccessClient per row', async () => {
    repositoryMocks.listProposalsForActor.mockResolvedValue({
      items: [{ id: 'p-1' }, { id: 'p-2' }],
      total: 2,
    });

    await listProposals(ADMIN_MANAGER, { page: 1, pageSize: 20 });

    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
  });

  it('opens no transaction', async () => {
    repositoryMocks.listProposalsForActor.mockResolvedValue({ items: [], total: 0 });

    await listProposals(ADMIN_MANAGER, { page: 1, pageSize: 20 });

    expect(transactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getProposalById
// ---------------------------------------------------------------------------

describe('getProposalById', () => {
  function detailRecord(overrides: Partial<ProposalDetailRecord> = {}): ProposalDetailRecord {
    return {
      id: PROPOSAL_ID,
      client: { id: CLIENT_ID, fullName: 'Jordan Cruz' },
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      versions: [],
      ...overrides,
    };
  }

  it('throws PROPOSAL_NOT_FOUND (404) for ADMIN_MANAGER when the Proposal genuinely does not exist', async () => {
    repositoryMocks.findProposalContext.mockResolvedValue(null);

    await expect(getProposalById(ADMIN_MANAGER, 'missing')).rejects.toMatchObject({
      code: 'PROPOSAL_NOT_FOUND',
      status: 404,
    });
    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
  });

  it('throws PROPOSAL_FORBIDDEN (403), not 404, for TRAVEL_CONSULTANT when the Proposal does not exist — no resource-existence leak', async () => {
    repositoryMocks.findProposalContext.mockResolvedValue(null);

    await expect(getProposalById(TRAVEL_CONSULTANT, 'missing')).rejects.toMatchObject({
      code: 'PROPOSAL_FORBIDDEN',
      status: 403,
    });
  });

  it('uses canAccessClient, resolved from the context clientId, and throws PROPOSAL_FORBIDDEN on denial', async () => {
    repositoryMocks.findProposalContext.mockResolvedValue({ id: PROPOSAL_ID, clientId: CLIENT_ID });
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(getProposalById(TRAVEL_CONSULTANT, PROPOSAL_ID)).rejects.toMatchObject({
      code: 'PROPOSAL_FORBIDDEN',
    });
    expect(authorizationMocks.canAccessClient).toHaveBeenCalledWith(TRAVEL_CONSULTANT, CLIENT_ID);
    expect(repositoryMocks.findProposalByIdForActor).not.toHaveBeenCalled();
  });

  it('applies the same NOT_FOUND/FORBIDDEN split when the actor-scoped detail read itself returns null', async () => {
    repositoryMocks.findProposalContext.mockResolvedValue({ id: PROPOSAL_ID, clientId: CLIENT_ID });
    repositoryMocks.findProposalByIdForActor.mockResolvedValue(null);

    await expect(getProposalById(ADMIN_MANAGER, PROPOSAL_ID)).rejects.toMatchObject({
      code: 'PROPOSAL_NOT_FOUND',
    });
    await expect(getProposalById(TRAVEL_CONSULTANT, PROPOSAL_ID)).rejects.toMatchObject({
      code: 'PROPOSAL_FORBIDDEN',
    });
  });

  it('returns a legacy null content unchanged, along with the complete detail shape', async () => {
    const record = detailRecord({
      versions: [
        {
          id: VERSION_ID,
          proposalId: PROPOSAL_ID,
          versionNumber: 1,
          content: null,
          clientVisibleAt: new Date('2026-08-01T00:00:00.000Z'),
          supersededAt: null,
          createdByUserId: TRAVEL_CONSULTANT.id,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
          acceptance: null,
        },
      ],
    });
    repositoryMocks.findProposalContext.mockResolvedValue({ id: PROPOSAL_ID, clientId: CLIENT_ID });
    repositoryMocks.findProposalByIdForActor.mockResolvedValue(record);

    const result = await getProposalById(ADMIN_MANAGER, PROPOSAL_ID);

    expect(result).toBe(record);
    expect(result.versions[0]?.content).toBeNull();
  });

  it('opens no transaction', async () => {
    repositoryMocks.findProposalContext.mockResolvedValue({ id: PROPOSAL_ID, clientId: CLIENT_ID });
    repositoryMocks.findProposalByIdForActor.mockResolvedValue(detailRecord());

    await getProposalById(ADMIN_MANAGER, PROPOSAL_ID);

    expect(transactionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createProposal
// ---------------------------------------------------------------------------

describe('createProposal', () => {
  it('runs the pre-transaction author assignment check against prisma before opening a transaction', async () => {
    repositoryMocks.createProposalWithFirstVersion.mockResolvedValue({
      proposal: proposalRecord(),
      version: versionRecord(),
    });

    await createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' });

    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenNthCalledWith(
      1,
      prisma,
      CLIENT_ID,
    );
  });

  it('rejects CLIENT_FORBIDDEN and opens no transaction when the pre-transaction precheck fails (no active assignment)', async () => {
    assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

    await expect(
      createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' }),
    ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN', status: 403 });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(repositoryMocks.createProposalWithFirstVersion).not.toHaveBeenCalled();
  });

  it('rejects CLIENT_FORBIDDEN when the active assignment belongs to a different staff member', async () => {
    assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(
      assignmentRecord({ assignedStaffId: 'other-tc' }),
    );

    await expect(
      createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' }),
    ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('reruns the assignment check transaction-locally (against TX_CLIENT) before the write, in addition to the prisma precheck', async () => {
    repositoryMocks.createProposalWithFirstVersion.mockResolvedValue({
      proposal: proposalRecord(),
      version: versionRecord(),
    });

    await createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' });

    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenCalledTimes(2);
    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenNthCalledWith(
      1,
      prisma,
      CLIENT_ID,
    );
    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenNthCalledWith(
      2,
      TX_CLIENT,
      CLIENT_ID,
    );
    const rechecckOrder =
      assignmentRepositoryMocks.findActiveAssignmentForClient.mock.invocationCallOrder[1]!;
    const writeOrder = repositoryMocks.createProposalWithFirstVersion.mock.invocationCallOrder[0]!;
    expect(rechecckOrder).toBeLessThan(writeOrder);
  });

  it('rejects CLIENT_FORBIDDEN when the assignment ends between the precheck and the transaction-local recheck, and never writes', async () => {
    assignmentRepositoryMocks.findActiveAssignmentForClient
      .mockResolvedValueOnce(assignmentRecord()) // pre-transaction precheck: active
      .mockResolvedValueOnce(null); // transaction-local recheck: ended in between

    await expect(
      createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' }),
    ).rejects.toMatchObject({ code: 'CLIENT_FORBIDDEN' });
    expect(repositoryMocks.createProposalWithFirstVersion).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('generates a fresh Proposal id and calls the repository with exactly the expected input', async () => {
    repositoryMocks.createProposalWithFirstVersion.mockResolvedValue({
      proposal: proposalRecord(),
      version: versionRecord(),
    });

    await createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1: Arrival.' });

    expect(repositoryMocks.createProposalWithFirstVersion).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      clientId: CLIENT_ID,
      content: 'Day 1: Arrival.',
      createdByUserId: TRAVEL_CONSULTANT.id,
    });
  });

  it('writes exactly one PII/content-free PROPOSAL_CREATED audit entry, inside the same transaction as the write', async () => {
    const created = { proposal: proposalRecord(), version: versionRecord({ versionNumber: 1 }) };
    repositoryMocks.createProposalWithFirstVersion.mockResolvedValue(created);

    await createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1: Arrival.' });

    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: TRAVEL_CONSULTANT.id,
      action: 'PROPOSAL_CREATED',
      entityType: 'Proposal',
      entityId: created.proposal.id,
      afterState: {
        clientId: created.proposal.clientId,
        firstVersionId: created.version.id,
        firstVersionNumber: created.version.versionNumber,
      },
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(repositoryMocks.insertAuditLog.mock.calls[0]);
    expect(serialized).not.toContain('Day 1: Arrival.');
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('never writes a PROPOSAL_VERSION_CREATED entry for the first version', async () => {
    repositoryMocks.createProposalWithFirstVersion.mockResolvedValue({
      proposal: proposalRecord(),
      version: versionRecord(),
    });

    await createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' });

    const actions = repositoryMocks.insertAuditLog.mock.calls.map((call) => call[1].action);
    expect(actions).toEqual(['PROPOSAL_CREATED']);
  });

  it('is not idempotent: a second call creates a second Proposal, never replaying or returning the first', async () => {
    const first = { proposal: proposalRecord({ id: 'proposal-1' }), version: versionRecord() };
    const second = {
      proposal: proposalRecord({ id: 'proposal-2' }),
      version: versionRecord({ id: 'version-2' }),
    };
    repositoryMocks.createProposalWithFirstVersion
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const result1 = await createProposal(TRAVEL_CONSULTANT, {
      clientId: CLIENT_ID,
      content: 'Day 1.',
    });
    const result2 = await createProposal(TRAVEL_CONSULTANT, {
      clientId: CLIENT_ID,
      content: 'Day 1.',
    });

    expect(result1.proposal.id).toBe('proposal-1');
    expect(result2.proposal.id).toBe('proposal-2');
    expect(repositoryMocks.createProposalWithFirstVersion).toHaveBeenCalledTimes(2);
  });

  it('maps a residual P2004 conflict to PROPOSAL_CONFLICT, never a raw Prisma error', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2004');
    });

    await expect(
      createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT', status: 409 });
  });

  it('maps an exhausted P2034 to PROPOSAL_CONFLICT', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2034');
    });

    await expect(
      createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT', status: 409 });
  });

  it('rethrows an unrelated, unexpected error unchanged', async () => {
    const unexpected = new Error('unexpected internal failure');
    transactionMock.mockImplementation(async () => {
      throw unexpected;
    });

    await expect(
      createProposal(TRAVEL_CONSULTANT, { clientId: CLIENT_ID, content: 'Day 1.' }),
    ).rejects.toBe(unexpected);
  });
});

// ---------------------------------------------------------------------------
// createProposalRevision
// ---------------------------------------------------------------------------

describe('createProposalRevision', () => {
  beforeEach(() => {
    repositoryMocks.findProposalContext.mockResolvedValue({ id: PROPOSAL_ID, clientId: CLIENT_ID });
  });

  it('runs the pre-transaction context resolution and author-access check against prisma', async () => {
    repositoryMocks.createProposalRevision.mockResolvedValue(versionRecord({ versionNumber: 2 }));

    await createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' });

    expect(repositoryMocks.findProposalContext).toHaveBeenNthCalledWith(1, prisma, PROPOSAL_ID);
    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenNthCalledWith(
      1,
      prisma,
      CLIENT_ID,
    );
  });

  it('rejects PROPOSAL_FORBIDDEN pre-transaction when the Proposal does not exist, opening no transaction', async () => {
    repositoryMocks.findProposalContext.mockResolvedValue(null);

    await expect(
      createProposalRevision(TRAVEL_CONSULTANT, 'missing', { content: 'Revised.' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_FORBIDDEN', status: 403 });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects PROPOSAL_FORBIDDEN pre-transaction when the author-access precheck fails', async () => {
    assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

    await expect(
      createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_FORBIDDEN' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('reruns findProposalContext and the assignment check transaction-locally, against TX_CLIENT, before the write', async () => {
    repositoryMocks.createProposalRevision.mockResolvedValue(versionRecord({ versionNumber: 2 }));

    await createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' });

    expect(repositoryMocks.findProposalContext).toHaveBeenNthCalledWith(2, TX_CLIENT, PROPOSAL_ID);
    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenNthCalledWith(
      2,
      TX_CLIENT,
      CLIENT_ID,
    );
  });

  it('rejects PROPOSAL_FORBIDDEN when the Proposal disappears between the precheck and the transaction-local re-read, without writing', async () => {
    repositoryMocks.findProposalContext
      .mockResolvedValueOnce({ id: PROPOSAL_ID, clientId: CLIENT_ID })
      .mockResolvedValueOnce(null);

    await expect(
      createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_FORBIDDEN' });
    expect(repositoryMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it('calls repository.createProposalRevision and insertAuditLog against the identical tx client', async () => {
    const created = versionRecord({ id: 'version-2', versionNumber: 2 });
    repositoryMocks.createProposalRevision.mockResolvedValue(created);

    await createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised itinerary.' });

    expect(repositoryMocks.createProposalRevision).toHaveBeenCalledWith(TX_CLIENT, {
      proposalId: PROPOSAL_ID,
      content: 'Revised itinerary.',
      createdByUserId: TRAVEL_CONSULTANT.id,
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: TRAVEL_CONSULTANT.id,
      action: 'PROPOSAL_VERSION_CREATED',
      entityType: 'ProposalVersion',
      entityId: created.id,
      afterState: { proposalId: created.proposalId, versionNumber: created.versionNumber },
    });
  });

  it('writes an audit snapshot excluding content entirely', async () => {
    repositoryMocks.createProposalRevision.mockResolvedValue(
      versionRecord({ content: 'Revised itinerary. Secret client detail.' }),
    );

    await createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, {
      content: 'Revised itinerary. Secret client detail.',
    });

    const afterState = repositoryMocks.insertAuditLog.mock.calls[0]?.[1].afterState;
    expect(afterState).not.toHaveProperty('content');
    expect(JSON.stringify(afterState)).not.toContain('Secret client detail');
  });

  it('retries in a fresh transaction when the composite proposalId/versionNumber P2002 fires once, without duplicating the audit entry', async () => {
    const created = versionRecord({ versionNumber: 3 });
    repositoryMocks.createProposalRevision
      .mockRejectedValueOnce(conflictError('P2002', ['proposalId', 'versionNumber']))
      .mockResolvedValueOnce(created);

    const result = await createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, {
      content: 'Revised.',
    });

    expect(result).toEqual(created);
    expect(repositoryMocks.createProposalRevision).toHaveBeenCalledTimes(2);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledTimes(2);
  });

  it('re-runs the context and assignment checks on every retry attempt', async () => {
    repositoryMocks.createProposalRevision
      .mockRejectedValueOnce(conflictError('P2002', ['proposalId', 'versionNumber']))
      .mockResolvedValueOnce(versionRecord({ versionNumber: 3 }));

    await createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' });

    // 1 pre-transaction call + 2 transaction-local calls (one per attempt).
    expect(repositoryMocks.findProposalContext).toHaveBeenCalledTimes(3);
    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenCalledTimes(3);
  });

  it('gives up after exactly three composite-conflict attempts, mapping the residual conflict to PROPOSAL_CONFLICT', async () => {
    repositoryMocks.createProposalRevision.mockRejectedValue(
      conflictError('P2002', ['proposalId', 'versionNumber']),
    );

    await expect(
      createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT', status: 409 });
    expect(repositoryMocks.createProposalRevision).toHaveBeenCalledTimes(3);
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('maps an exhausted P2034 to PROPOSAL_CONFLICT without exhausting the composite-conflict retry budget', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2034');
    });

    await expect(
      createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT', status: 409 });
    expect(repositoryMocks.createProposalRevision).not.toHaveBeenCalled();
  });

  it('does not retry an unrelated P2002 as if it were a revision-number race', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2002', ['someOtherColumn']);
    });

    await expect(
      createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT' });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows an unrelated, unexpected error unchanged, without retrying', async () => {
    const unexpected = new Error('unexpected internal failure');
    transactionMock.mockImplementation(async () => {
      throw unexpected;
    });

    await expect(
      createProposalRevision(TRAVEL_CONSULTANT, PROPOSAL_ID, { content: 'Revised.' }),
    ).rejects.toBe(unexpected);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// publishProposalVersion
// ---------------------------------------------------------------------------

describe('publishProposalVersion', () => {
  beforeEach(() => {
    repositoryMocks.findProposalVersionContext.mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      clientId: CLIENT_ID,
    });
  });

  it('rejects PROPOSAL_VERSION_FORBIDDEN pre-transaction for a nonexistent/inaccessible target, opening no transaction', async () => {
    repositoryMocks.findProposalVersionContext.mockResolvedValue(null);

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, 'missing', { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN', status: 403 });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects PROPOSAL_VERSION_FORBIDDEN pre-transaction when the author-access precheck fails', async () => {
    assignmentRepositoryMocks.findActiveAssignmentForClient.mockResolvedValue(null);

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('never calls findProposalVersionContext for ADMIN_MANAGER — rejected by the role gate first', async () => {
    await expect(
      publishProposalVersion(ADMIN_MANAGER, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
    expect(repositoryMocks.findProposalVersionContext).not.toHaveBeenCalled();
  });

  it('performs the actor-scoped transaction target lookup before the transaction-local assignment recheck', async () => {
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(
      versionActorContext({ clientVisibleAt: new Date(), supersededAt: null }),
    );

    await publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null });

    const lookupOrder = repositoryMocks.findProposalVersionForActor.mock.invocationCallOrder[0]!;
    const recheckOrder =
      assignmentRepositoryMocks.findActiveAssignmentForClient.mock.invocationCallOrder[1]!;
    expect(lookupOrder).toBeLessThan(recheckOrder);
  });

  it('rejects PROPOSAL_VERSION_FORBIDDEN when the target lookup itself returns null transaction-locally', async () => {
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(null);

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN' });
    expect(repositoryMocks.findCurrentClientVisibleVersion).not.toHaveBeenCalled();
  });

  it('rejects PROPOSAL_VERSION_FORBIDDEN when the assignment changes between the precheck and the transaction', async () => {
    assignmentRepositoryMocks.findActiveAssignmentForClient
      .mockResolvedValueOnce(assignmentRecord())
      .mockResolvedValueOnce(assignmentRecord({ assignedStaffId: 'other-tc' }));
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(versionActorContext());

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN' });
    expect(repositoryMocks.findCurrentClientVisibleVersion).not.toHaveBeenCalled();
  });

  it('returns an already-current target unchanged, reading no current version, comparing no expectedCurrentVersionId, writing nothing, and auditing nothing', async () => {
    const alreadyCurrent = versionActorContext({
      clientVisibleAt: new Date('2026-08-01T00:00:00.000Z'),
      supersededAt: null,
    });
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(alreadyCurrent);

    const result = await publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, {
      expectedCurrentVersionId: 'some-other-version-id',
    });

    expect(result).toEqual(alreadyCurrent);
    expect(repositoryMocks.findCurrentClientVisibleVersion).not.toHaveBeenCalled();
    expect(repositoryMocks.markProposalVersionSuperseded).not.toHaveBeenCalled();
    expect(repositoryMocks.markProposalVersionClientVisible).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('succeeds on the already-current path even with a null expectedCurrentVersionId', async () => {
    const alreadyCurrent = versionActorContext({
      clientVisibleAt: new Date('2026-08-01T00:00:00.000Z'),
      supersededAt: null,
    });
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(alreadyCurrent);

    const result = await publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, {
      expectedCurrentVersionId: null,
    });

    expect(result).toEqual(alreadyCurrent);
  });

  it('rejects PROPOSAL_VERSION_SUPERSEDED for a superseded target, before reading the current version, with no write/audit', async () => {
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(
      versionActorContext({
        clientVisibleAt: new Date('2026-08-01T00:00:00.000Z'),
        supersededAt: new Date('2026-08-02T00:00:00.000Z'),
      }),
    );

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_SUPERSEDED', status: 409 });
    expect(repositoryMocks.findCurrentClientVisibleVersion).not.toHaveBeenCalled();
    expect(repositoryMocks.markProposalVersionClientVisible).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects PROPOSAL_CONFLICT with D-027's exact refresh message on an expectedCurrentVersionId mismatch, with no write/audit", async () => {
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(versionActorContext());
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue(
      versionRecord({ id: 'a-different-current-version' }),
    );

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, {
        expectedCurrentVersionId: 'stale-version-id',
      }),
    ).rejects.toMatchObject({
      code: 'PROPOSAL_CONFLICT',
      status: 409,
      message:
        'The current version has changed since you last loaded this proposal. Refresh and try again.',
    });
    expect(repositoryMocks.markProposalVersionClientVisible).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('matches a null expectedCurrentVersionId against no current version and publishes successfully, recording previousCurrentVersionId: null', async () => {
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(versionActorContext());
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue(null);
    repositoryMocks.markProposalVersionClientVisible.mockResolvedValue(
      versionRecord({ clientVisibleAt: new Date('2026-08-04T00:00:00.000Z'), supersededAt: null }),
    );

    const result = await publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, {
      expectedCurrentVersionId: null,
    });

    expect(repositoryMocks.markProposalVersionSuperseded).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({
        afterState: expect.objectContaining({ previousCurrentVersionId: null }),
      }),
    );
    expect(result.supersededAt).toBeNull();
  });

  it('supersedes the matching prior-current version before publishing the target, using the identical Date instance for both writes', async () => {
    const priorCurrent = versionRecord({ id: 'prior-current-version', versionNumber: 1 });
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(
      versionActorContext({ id: VERSION_ID, versionNumber: 2 }),
    );
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue(priorCurrent);
    repositoryMocks.markProposalVersionSuperseded.mockResolvedValue(
      versionRecord({ id: priorCurrent.id, supersededAt: new Date() }),
    );
    repositoryMocks.markProposalVersionClientVisible.mockResolvedValue(
      versionRecord({ id: VERSION_ID, clientVisibleAt: new Date(), supersededAt: null }),
    );

    const result = await publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, {
      expectedCurrentVersionId: priorCurrent.id,
    });

    expect(repositoryMocks.markProposalVersionSuperseded).toHaveBeenCalledWith(
      TX_CLIENT,
      priorCurrent.id,
      expect.any(Date),
    );
    expect(repositoryMocks.markProposalVersionClientVisible).toHaveBeenCalledWith(
      TX_CLIENT,
      VERSION_ID,
      expect.any(Date),
    );
    const supersedeDate = repositoryMocks.markProposalVersionSuperseded.mock.calls[0]?.[2];
    const publishDate = repositoryMocks.markProposalVersionClientVisible.mock.calls[0]?.[2];
    expect(supersedeDate).toBe(publishDate);

    const supersedeOrder =
      repositoryMocks.markProposalVersionSuperseded.mock.invocationCallOrder[0]!;
    const publishOrder =
      repositoryMocks.markProposalVersionClientVisible.mock.invocationCallOrder[0]!;
    expect(supersedeOrder).toBeLessThan(publishOrder);

    const auditOrder = repositoryMocks.insertAuditLog.mock.invocationCallOrder[0]!;
    expect(publishOrder).toBeLessThan(auditOrder);

    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: TRAVEL_CONSULTANT.id,
      action: 'PROPOSAL_VERSION_PUBLISHED',
      entityType: 'ProposalVersion',
      entityId: VERSION_ID,
      afterState: {
        proposalId: PROPOSAL_ID,
        versionNumber: 2,
        previousCurrentVersionId: priorCurrent.id,
      },
    });
    expect(JSON.stringify(repositoryMocks.insertAuditLog.mock.calls[0])).not.toContain('content');
    expect(result.clientVisibleAt).not.toBeNull();
    expect(result.supersededAt).toBeNull();
  });

  it('maps a residual P2002 (including the partial current-version unique index) to PROPOSAL_CONFLICT', async () => {
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(versionActorContext());
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue(null);
    repositoryMocks.markProposalVersionClientVisible.mockRejectedValue(
      conflictError('P2002', ['proposal_version_current_client_visible_key']),
    );

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT', status: 409 });
  });

  it('maps a residual P2004 to PROPOSAL_CONFLICT', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2004');
    });

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT' });
  });

  it('maps an exhausted P2034 to PROPOSAL_CONFLICT', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2034');
    });

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT' });
  });

  it('rethrows an unrelated, unexpected error unchanged', async () => {
    const unexpected = new Error('unexpected internal failure');
    transactionMock.mockImplementation(async () => {
      throw unexpected;
    });

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toBe(unexpected);
  });
});

// ---------------------------------------------------------------------------
// recordProposalResponse
// ---------------------------------------------------------------------------

describe('recordProposalResponse', () => {
  const VALID_INPUT = {
    responseType: 'ACCEPT' as const,
    respondedAt: '2026-08-04T10:00:00.000Z',
    responseMethod: 'phone',
    evidenceReference: 'Call log #4821',
  };

  beforeEach(() => {
    repositoryMocks.findProposalVersionContext.mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      clientId: CLIENT_ID,
    });
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(versionActorContext());
    repositoryMocks.findProposalAcceptanceForVersion.mockResolvedValue(null);
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue(
      versionRecord({ id: VERSION_ID }),
    );
    repositoryMocks.createExternalProposalAcceptance.mockResolvedValue(acceptanceRecord());
  });

  it('accepts ADMIN_MANAGER and TRAVEL_CONSULTANT', async () => {
    await expect(
      recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT),
    ).resolves.toBeDefined();
    await expect(
      recordProposalResponse(TRAVEL_CONSULTANT, VERSION_ID, VALID_INPUT),
    ).resolves.toBeDefined();
  });

  it('throws PROPOSAL_VERSION_NOT_FOUND (404) for ADMIN_MANAGER when the version genuinely does not exist', async () => {
    repositoryMocks.findProposalVersionContext.mockResolvedValue(null);

    await expect(
      recordProposalResponse(ADMIN_MANAGER, 'missing', VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_NOT_FOUND', status: 404 });
  });

  it('throws PROPOSAL_VERSION_FORBIDDEN (403), not 404, for TRAVEL_CONSULTANT when the version is missing/inaccessible', async () => {
    repositoryMocks.findProposalVersionContext.mockResolvedValue(null);

    await expect(
      recordProposalResponse(TRAVEL_CONSULTANT, 'missing', VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN', status: 403 });
  });

  it('uses canAccessClient as the pre-transaction precheck, rejecting PROPOSAL_VERSION_FORBIDDEN on denial, opening no transaction', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(
      recordProposalResponse(TRAVEL_CONSULTANT, VERSION_ID, VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('reruns the assignment check transaction-locally for TRAVEL_CONSULTANT only', async () => {
    await recordProposalResponse(TRAVEL_CONSULTANT, VERSION_ID, VALID_INPUT);
    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).toHaveBeenCalledWith(
      TX_CLIENT,
      CLIENT_ID,
    );

    vi.clearAllMocks();
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    repositoryMocks.findProposalVersionContext.mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      clientId: CLIENT_ID,
    });
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(versionActorContext());
    repositoryMocks.findProposalAcceptanceForVersion.mockResolvedValue(null);
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue(
      versionRecord({ id: VERSION_ID }),
    );
    repositoryMocks.createExternalProposalAcceptance.mockResolvedValue(acceptanceRecord());

    await recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT);
    expect(assignmentRepositoryMocks.findActiveAssignmentForClient).not.toHaveBeenCalled();
  });

  it('checks for an existing acceptance before reading the current version, and skips current/create/audit when one exists', async () => {
    repositoryMocks.findProposalAcceptanceForVersion.mockResolvedValue(acceptanceRecord());

    await expect(
      recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED', status: 409 });
    expect(repositoryMocks.findCurrentClientVisibleVersion).not.toHaveBeenCalled();
    expect(repositoryMocks.createExternalProposalAcceptance).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('returns PROPOSAL_RESPONSE_ALREADY_RECORDED for a version that already has a response even though it has since been superseded', async () => {
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(
      versionActorContext({ supersededAt: new Date('2026-08-05T00:00:00.000Z') }),
    );
    repositoryMocks.findProposalAcceptanceForVersion.mockResolvedValue(acceptanceRecord());

    await expect(
      recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED' });
  });

  it('rejects PROPOSAL_VERSION_NOT_CURRENT when no acceptance exists but the target is not the current version, with no write/audit', async () => {
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue(
      versionRecord({ id: 'a-different-current-version' }),
    );

    await expect(
      recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_NOT_CURRENT', status: 409 });
    expect(repositoryMocks.createExternalProposalAcceptance).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('creates exactly one external acceptance for a valid current target, with recordedByStaffUserId set to the acting staff member and no portal field supplied', async () => {
    await recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT);

    expect(repositoryMocks.createExternalProposalAcceptance).toHaveBeenCalledTimes(1);
    const call = repositoryMocks.createExternalProposalAcceptance.mock.calls[0]?.[1];
    expect(call).toEqual({
      proposalVersionId: VERSION_ID,
      responseType: 'ACCEPT',
      respondedAt: expect.any(Date),
      recordedByStaffUserId: ADMIN_MANAGER.id,
      responseMethod: 'phone',
      evidenceReference: 'Call log #4821',
    });
    expect(call).not.toHaveProperty('respondingClientProfileId');
    expect(call).not.toHaveProperty('respondingSessionIdAtResponse');
  });

  it('converts a +08:00-offset respondedAt into the correct UTC Date instant', async () => {
    await recordProposalResponse(ADMIN_MANAGER, VERSION_ID, {
      ...VALID_INPUT,
      respondedAt: '2026-08-04T18:00:00+08:00',
    });

    const call = repositoryMocks.createExternalProposalAcceptance.mock.calls[0]?.[1];
    expect((call.respondedAt as Date).toISOString()).toBe('2026-08-04T10:00:00.000Z');
  });

  it('uses the same tx for the create and the audit write, atomically', async () => {
    await recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT);

    expect(repositoryMocks.createExternalProposalAcceptance).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.any(Object),
    );
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, expect.any(Object));
  });

  it('writes a PROPOSAL_RESPONSE_RECORDED audit entry with only acceptanceId, responseType, and respondedAt — never responseMethod, evidenceReference, content, or PII', async () => {
    const created = acceptanceRecord({
      id: 'acceptance-new',
      responseType: 'ACCEPT',
      respondedAt: new Date('2026-08-04T10:00:00.000Z'),
      responseMethod: 'phone, contact +63 917 555 0100',
      evidenceReference: 'Call log #4821, client SSN 123-45-6789',
    });
    repositoryMocks.createExternalProposalAcceptance.mockResolvedValue(created);

    await recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT);

    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ADMIN_MANAGER.id,
      action: 'PROPOSAL_RESPONSE_RECORDED',
      entityType: 'ProposalVersion',
      entityId: VERSION_ID,
      afterState: {
        acceptanceId: 'acceptance-new',
        responseType: 'ACCEPT',
        respondedAt: '2026-08-04T10:00:00.000Z',
      },
    });
    const serialized = JSON.stringify(repositoryMocks.insertAuditLog.mock.calls[0]);
    expect(serialized).not.toContain('responseMethod');
    expect(serialized).not.toContain('evidenceReference');
    expect(serialized).not.toContain('+63 917 555 0100');
    expect(serialized).not.toContain('123-45-6789');
  });

  it('returns the created ProposalAcceptance', async () => {
    const created = acceptanceRecord({ id: 'acceptance-new' });
    repositoryMocks.createExternalProposalAcceptance.mockResolvedValue(created);

    const result = await recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT);

    expect(result).toEqual(created);
  });

  it('translates a concurrent proposalVersionId unique-conflict race into PROPOSAL_RESPONSE_ALREADY_RECORDED, never exposing the raw Prisma error or treating it as success', async () => {
    repositoryMocks.createExternalProposalAcceptance.mockRejectedValue(
      conflictError('P2002', ['proposalVersionId']),
    );

    await expect(
      recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED', status: 409 });
  });

  it('maps a residual P2004 to PROPOSAL_CONFLICT', async () => {
    repositoryMocks.createExternalProposalAcceptance.mockRejectedValue(conflictError('P2004'));

    await expect(
      recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT', status: 409 });
  });

  it('maps an exhausted P2034 to PROPOSAL_CONFLICT', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2034');
    });

    await expect(
      recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT),
    ).rejects.toMatchObject({ code: 'PROPOSAL_CONFLICT' });
  });

  it('rethrows an unrelated, unexpected error unchanged', async () => {
    const unexpected = new Error('unexpected internal failure');
    transactionMock.mockImplementation(async () => {
      throw unexpected;
    });

    await expect(recordProposalResponse(ADMIN_MANAGER, VERSION_ID, VALID_INPUT)).rejects.toBe(
      unexpected,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: transaction-local checks use TX_CLIENT, prechecks use
// prisma, and ProposalError business outcomes are never retried by
// runSerializableWithRetry (only a genuine P2034 is).
// ---------------------------------------------------------------------------

describe('cross-cutting transaction and retry discipline', () => {
  it('runSerializableWithRetry retries a genuine P2034 internally rather than surfacing it immediately, for publishProposalVersion', async () => {
    repositoryMocks.findProposalVersionContext.mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      clientId: CLIENT_ID,
    });
    let attempts = 0;
    transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      attempts += 1;
      if (attempts < 2) throw conflictError('P2034');
      return fn(TX_CLIENT);
    });
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(
      versionActorContext({ clientVisibleAt: new Date(), supersededAt: null }),
    );

    const result = await publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, {
      expectedCurrentVersionId: null,
    });

    expect(result).toBeDefined();
    expect(attempts).toBe(2);
  });

  it('does not retry a ProposalError business outcome thrown from inside the transaction callback', async () => {
    repositoryMocks.findProposalVersionContext.mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      clientId: CLIENT_ID,
    });
    repositoryMocks.findProposalVersionForActor.mockResolvedValue(
      versionActorContext({ supersededAt: new Date('2026-08-05T00:00:00.000Z') }),
    );

    await expect(
      publishProposalVersion(TRAVEL_CONSULTANT, VERSION_ID, { expectedCurrentVersionId: null }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_SUPERSEDED' });
    // Exactly one attempt — a business-rule rejection is never retried.
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
