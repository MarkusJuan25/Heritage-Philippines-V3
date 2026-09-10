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
  findClientProposalFacts: vi.fn(),
  findClientProposalPreview: vi.fn(),
  countCurrentClientVisibleProposalVersions: vi.fn(),
  findClientProposalReviewPage: vi.fn(),
  CLIENT_PROPOSAL_REVIEW_PAGE_SIZE: 10,
  findProposalVersionOwnershipContext: vi.fn(),
  createPortalProposalAcceptance: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

const authorizationMocks = vi.hoisted(() => ({ canAccessClient: vi.fn() }));
vi.mock('@/features/assignments/authorization', () => authorizationMocks);

const assignmentRepositoryMocks = vi.hoisted(() => ({ findActiveAssignmentForClient: vi.fn() }));
vi.mock('@/features/assignments/repository', () => assignmentRepositoryMocks);

// D-047 §8: the portal-response service consumes Contract A and the Stage 2
// `{ clientProfileId, clientId }` identity read directly. Mocked here; no
// existing proposal-service test invokes either.
const clientsServiceMocks = vi.hoisted(() => ({ getOwnClientForUser: vi.fn() }));
vi.mock('@/features/clients/service', () => clientsServiceMocks);

const clientsRepositoryMocks = vi.hoisted(() => ({ findClientProfileIdentityForUser: vi.fn() }));
vi.mock('@/features/clients/repository', () => clientsRepositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import type {
  ClientProposalReviewRow,
  ProposalAcceptanceRecord,
  ProposalActor,
  ProposalDetailRecord,
  ProposalListItem,
  ProposalRecord,
  ProposalVersionActorContext,
  ProposalVersionRecord,
} from './repository';
import { ProposalError } from './errors';
import {
  clientProposalResponseCodeFor,
  clientProposalResponseSchema,
  createProposal,
  createProposalRevision,
  getClientProposalFacts,
  getClientProposalPreview,
  getClientProposalReviewPage,
  getProposalById,
  listProposals,
  publishProposalVersion,
  recordProposalResponse,
  submitClientProposalResponse,
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

// --- Client-portal reads (D-040 §§2, 3, 4 — Contracts B and C) ---

const CLIENT_PORTAL_ACTOR: AuthenticatedUser = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client One',
  role: 'CLIENT',
};

const CLIENT_PROPOSAL_FACTS = {
  currentVisibleTotal: 3,
  awaitingResponse: 1,
  accepted: 1,
  acceptedWithoutClientVisibleBooking: 1,
  respondedNonAccept: 1,
};

describe('getClientProposalFacts / getClientProposalPreview (Contracts B and C)', () => {
  it('reject a non-CLIENT actor with ROLE_NOT_PERMITTED before canAccessClient or any repository read', async () => {
    for (const actor of [ADMIN_MANAGER, TRAVEL_CONSULTANT]) {
      await expect(getClientProposalFacts(actor, CLIENT_ID)).rejects.toMatchObject({
        name: 'ProposalError',
        code: 'ROLE_NOT_PERMITTED',
      });
      await expect(getClientProposalPreview(actor, CLIENT_ID)).rejects.toMatchObject({
        code: 'ROLE_NOT_PERMITTED',
      });
    }
    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
    expect(repositoryMocks.findClientProposalFacts).not.toHaveBeenCalled();
    expect(repositoryMocks.findClientProposalPreview).not.toHaveBeenCalled();
  });

  it('call canAccessClient(actor, clientId) BEFORE the repository read, and reject a denial with CLIENT_FORBIDDEN', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(getClientProposalFacts(CLIENT_PORTAL_ACTOR, CLIENT_ID)).rejects.toMatchObject({
      name: 'ProposalError',
      code: 'CLIENT_FORBIDDEN',
      status: 403,
    });
    expect(authorizationMocks.canAccessClient).toHaveBeenCalledWith(CLIENT_PORTAL_ACTOR, CLIENT_ID);
    expect(repositoryMocks.findClientProposalFacts).not.toHaveBeenCalled();
  });

  it('getClientProposalFacts delegates to the repository once access is granted', async () => {
    repositoryMocks.findClientProposalFacts.mockResolvedValue(CLIENT_PROPOSAL_FACTS);

    const result = await getClientProposalFacts(CLIENT_PORTAL_ACTOR, CLIENT_ID);

    expect(result).toEqual(CLIENT_PROPOSAL_FACTS);
    expect(repositoryMocks.findClientProposalFacts).toHaveBeenCalledWith(prisma, CLIENT_ID);
    const accessOrder = authorizationMocks.canAccessClient.mock.invocationCallOrder[0]!;
    const readOrder = repositoryMocks.findClientProposalFacts.mock.invocationCallOrder[0]!;
    expect(accessOrder).toBeLessThan(readOrder);
  });

  it('getClientProposalPreview maps every responseType (and its absence) to the D-040 §4 label', async () => {
    repositoryMocks.findClientProposalPreview.mockResolvedValue([
      { versionNumber: 4, responseType: null },
      { versionNumber: 3, responseType: 'ACCEPT' },
      { versionNumber: 2, responseType: 'DECLINE' },
      { versionNumber: 1, responseType: 'REQUEST_CHANGES' },
    ]);

    const result = await getClientProposalPreview(CLIENT_PORTAL_ACTOR, CLIENT_ID);

    expect(result).toEqual({
      items: [
        { versionNumber: 4, statusLabel: 'Awaiting your response' },
        { versionNumber: 3, statusLabel: 'Accepted' },
        { versionNumber: 2, statusLabel: 'Declined' },
        { versionNumber: 1, statusLabel: 'Changes requested' },
      ],
    });
    expect(repositoryMocks.findClientProposalPreview).toHaveBeenCalledWith(prisma, CLIENT_ID);
  });
});

// --- Client proposal-review page (D-047 §5) ---

describe('getClientProposalReviewPage (D-047 §5)', () => {
  const PUBLISHED = new Date('2026-09-01T08:00:00.000Z');
  const RESPONDED = new Date('2026-09-04T10:15:00.000Z');

  const reviewRow = (
    versionNumber: number,
    extra: Partial<ClientProposalReviewRow> = {},
  ): ClientProposalReviewRow => ({
    proposalVersionId: `pv-${versionNumber}`,
    proposalId: `p-${versionNumber}`,
    versionNumber,
    content: `Itinerary ${versionNumber}`,
    clientVisibleAt: PUBLISHED,
    acceptance: null,
    ...extra,
  });

  const reviewRows = (count: number): ClientProposalReviewRow[] =>
    Array.from({ length: count }, (_, i) => reviewRow(count - i));

  beforeEach(() => {
    repositoryMocks.countCurrentClientVisibleProposalVersions.mockReset();
    repositoryMocks.findClientProposalReviewPage.mockReset();
  });

  it('rejects a non-CLIENT actor with ROLE_NOT_PERMITTED before canAccessClient or any repository read', async () => {
    for (const actor of [ADMIN_MANAGER, TRAVEL_CONSULTANT]) {
      await expect(getClientProposalReviewPage(actor, CLIENT_ID, 1)).rejects.toMatchObject({
        name: 'ProposalError',
        code: 'ROLE_NOT_PERMITTED',
      });
    }
    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
    expect(repositoryMocks.findClientProposalReviewPage).not.toHaveBeenCalled();
    expect(repositoryMocks.countCurrentClientVisibleProposalVersions).not.toHaveBeenCalled();
  });

  it('calls canAccessClient(actor, clientId) before any read and rejects a denial with CLIENT_FORBIDDEN', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(
      getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 2),
    ).rejects.toMatchObject({ name: 'ProposalError', code: 'CLIENT_FORBIDDEN', status: 403 });
    expect(authorizationMocks.canAccessClient).toHaveBeenCalledWith(CLIENT_PORTAL_ACTOR, CLIENT_ID);
    expect(repositoryMocks.findClientProposalReviewPage).not.toHaveBeenCalled();
    expect(repositoryMocks.countCurrentClientVisibleProposalVersions).not.toHaveBeenCalled();
  });

  it('page 1 uses the bounded card query directly (skip 0, take 11) and never counts', async () => {
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue(reviewRows(3));

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 1);

    expect(repositoryMocks.countCurrentClientVisibleProposalVersions).not.toHaveBeenCalled();
    expect(repositoryMocks.findClientProposalReviewPage).toHaveBeenCalledWith(prisma, CLIENT_ID, {
      skip: 0,
      take: 11,
    });
    if (result.kind !== 'page') throw new Error('expected a page result');
    expect(result.render.page).toBe(1);
    expect(result.render.hasPrevious).toBe(false);
    expect(result.render.hasNext).toBe(false);
    expect(result.render.isEmpty).toBe(false);
    expect(result.render.cards).toHaveLength(3);
  });

  it('page 1 with an 11th row sets hasNext and still emits exactly 10 cards', async () => {
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue(reviewRows(11));

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 1);
    if (result.kind !== 'page') throw new Error('expected a page result');

    expect(result.render.cards).toHaveLength(10);
    expect(result.render.hasNext).toBe(true);
    expect(result.serverModel.cards).toHaveLength(10);
  });

  it('page 1 with no rows is the global empty state, not a redirect', async () => {
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue([]);

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 1);

    if (result.kind !== 'page') throw new Error('expected a page result');
    expect(result.render.isEmpty).toBe(true);
    expect(result.render.cards).toEqual([]);
    expect(result.render.hasPrevious).toBe(false);
    expect(result.render.hasNext).toBe(false);
  });

  it('page > 1 counts first, then issues the offset query for a confirmed page', async () => {
    repositoryMocks.countCurrentClientVisibleProposalVersions.mockResolvedValue(25);
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue(reviewRows(10));

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 2);
    if (result.kind !== 'page') throw new Error('expected a page result');

    expect(repositoryMocks.countCurrentClientVisibleProposalVersions).toHaveBeenCalledWith(
      prisma,
      CLIENT_ID,
    );
    expect(repositoryMocks.findClientProposalReviewPage).toHaveBeenCalledWith(prisma, CLIENT_ID, {
      skip: 10,
      take: 11,
    });
    const countOrder =
      repositoryMocks.countCurrentClientVisibleProposalVersions.mock.invocationCallOrder[0]!;
    const readOrder = repositoryMocks.findClientProposalReviewPage.mock.invocationCallOrder[0]!;
    expect(countOrder).toBeLessThan(readOrder);
    expect(result.render.page).toBe(2);
    expect(result.render.hasPrevious).toBe(true);
  });

  it('page 3 of a 25-item set is allowed with skip 20', async () => {
    repositoryMocks.countCurrentClientVisibleProposalVersions.mockResolvedValue(25);
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue(reviewRows(5));

    await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 3);

    expect(repositoryMocks.findClientProposalReviewPage).toHaveBeenCalledWith(prisma, CLIENT_ID, {
      skip: 20,
      take: 11,
    });
  });

  it('redirects an out-of-range page > 1 BEFORE computing or issuing any offset query', async () => {
    repositoryMocks.countCurrentClientVisibleProposalVersions.mockResolvedValue(25); // lastPage 3

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 4);

    expect(result).toEqual({ kind: 'redirect' });
    expect(repositoryMocks.findClientProposalReviewPage).not.toHaveBeenCalled();
  });

  it('redirects page > 1 when the client has no current-visible proposals (count 0)', async () => {
    repositoryMocks.countCurrentClientVisibleProposalVersions.mockResolvedValue(0);

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 2);

    expect(result).toEqual({ kind: 'redirect' });
    expect(repositoryMocks.findClientProposalReviewPage).not.toHaveBeenCalled();
  });

  it('redirects an astronomically large page without an offset query (no offset from an unsafe integer)', async () => {
    repositoryMocks.countCurrentClientVisibleProposalVersions.mockResolvedValue(5);

    const result = await getClientProposalReviewPage(
      CLIENT_PORTAL_ACTOR,
      CLIENT_ID,
      Number.MAX_SAFE_INTEGER,
    );

    expect(result).toEqual({ kind: 'redirect' });
    expect(repositoryMocks.findClientProposalReviewPage).not.toHaveBeenCalled();
  });

  it('clamps a non-safe-integer or < 1 page to page 1 and never counts', async () => {
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue(reviewRows(2));

    for (const bad of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      repositoryMocks.findClientProposalReviewPage.mockClear();
      repositoryMocks.countCurrentClientVisibleProposalVersions.mockClear();

      const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, bad);
      if (result.kind !== 'page') throw new Error('expected a page result');

      expect(result.render.page).toBe(1);
      expect(repositoryMocks.countCurrentClientVisibleProposalVersions).not.toHaveBeenCalled();
      expect(repositoryMocks.findClientProposalReviewPage).toHaveBeenCalledWith(prisma, CLIENT_ID, {
        skip: 0,
        take: 11,
      });
    }
  });

  it('redirects a confirmed page > 1 that returns no rows (concurrent change)', async () => {
    repositoryMocks.countCurrentClientVisibleProposalVersions.mockResolvedValue(25);
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue([]);

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 2);

    expect(result).toEqual({ kind: 'redirect' });
  });

  it('keeps every database identifier out of the render DTO — ids live only in serverModel, index-aligned', async () => {
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue([
      reviewRow(2, {
        proposalVersionId: 'pv-secret-2',
        proposalId: 'p-secret-2',
        acceptance: { responseType: 'ACCEPT', respondedAt: RESPONDED },
      }),
      reviewRow(1, { proposalVersionId: 'pv-secret-1', proposalId: 'p-secret-1' }),
    ]);

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 1);
    if (result.kind !== 'page') throw new Error('expected a page result');

    const renderJson = JSON.stringify(result.render);
    for (const id of ['pv-secret-2', 'p-secret-2', 'pv-secret-1', 'p-secret-1']) {
      expect(renderJson).not.toContain(id);
    }
    for (const card of result.render.cards) {
      expect(Object.keys(card).sort()).toEqual([
        'content',
        'publishedAt',
        'response',
        'statusLabel',
        'versionNumber',
      ]);
    }
    expect(result.serverModel.cards).toEqual([
      { proposalVersionId: 'pv-secret-2', proposalId: 'p-secret-2' },
      { proposalVersionId: 'pv-secret-1', proposalId: 'p-secret-1' },
    ]);
  });

  it('maps content, ISO publishedAt, the response summary, and the reused status label', async () => {
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue([
      reviewRow(3, {
        content: 'Cebu itinerary v3',
        acceptance: { responseType: 'ACCEPT', respondedAt: RESPONDED },
      }),
      reviewRow(2, { content: null }),
      reviewRow(1, { content: 'Cebu itinerary v1' }),
    ]);

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 1);
    if (result.kind !== 'page') throw new Error('expected a page result');

    expect(result.render.cards[0]).toEqual({
      versionNumber: 3,
      publishedAt: PUBLISHED.toISOString(),
      content: { available: true, text: 'Cebu itinerary v3' },
      response: { responseType: 'ACCEPT', respondedAt: RESPONDED.toISOString() },
      statusLabel: 'Accepted',
    });
    expect(result.render.cards[1]).toEqual({
      versionNumber: 2,
      publishedAt: PUBLISHED.toISOString(),
      content: { available: false },
      response: null,
      statusLabel: 'Awaiting your response',
    });
    expect(result.render.cards[2]!.content).toEqual({ available: true, text: 'Cebu itinerary v1' });
    expect(result.render.cards[2]!.response).toBeNull();
  });

  it('maps each acceptance responseType to its D-040 §4 client label', async () => {
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue([
      reviewRow(4, { acceptance: null }),
      reviewRow(3, { acceptance: { responseType: 'ACCEPT', respondedAt: RESPONDED } }),
      reviewRow(2, { acceptance: { responseType: 'DECLINE', respondedAt: RESPONDED } }),
      reviewRow(1, { acceptance: { responseType: 'REQUEST_CHANGES', respondedAt: RESPONDED } }),
    ]);

    const result = await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 1);
    if (result.kind !== 'page') throw new Error('expected a page result');

    expect(result.render.cards.map((card) => card.statusLabel)).toEqual([
      'Awaiting your response',
      'Accepted',
      'Declined',
      'Changes requested',
    ]);
  });

  it('is read-only — never opens a transaction or writes an audit row', async () => {
    repositoryMocks.findClientProposalReviewPage.mockResolvedValue(reviewRows(2));

    await getClientProposalReviewPage(CLIENT_PORTAL_ACTOR, CLIENT_ID, 1);

    expect(transactionMock).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });
});

// --- Client proposal-response mutation (D-047 §6-§10) ---

const CLIENT_PROFILE_ID = 'profile-1';
const RESPONSE_SESSION_ID = 'session-abc123';

const ownedClientIdentity = () => ({
  clientId: CLIENT_ID,
  fullName: 'Client One',
  email: 'client@example.test',
  phone: null,
});
const profileIdentity = () => ({ clientProfileId: CLIENT_PROFILE_ID, clientId: CLIENT_ID });
const ownershipContext = (overrides: Record<string, unknown> = {}) => ({
  proposalVersionId: VERSION_ID,
  proposalId: PROPOSAL_ID,
  clientId: CLIENT_ID,
  supersededAt: null,
  ...overrides,
});
const portalAcceptance = (responseType: 'ACCEPT' | 'DECLINE' | 'REQUEST_CHANGES' = 'ACCEPT') => ({
  id: ACCEPTANCE_ID,
  proposalVersionId: VERSION_ID,
  responseType,
  respondedAt: new Date('2026-09-06T09:30:00.000Z'),
  recordedByStaffUserId: null,
  responseMethod: null,
  evidenceReference: null,
  createdAt: new Date('2026-09-06T09:30:00.000Z'),
});
const submitInput = (overrides: Record<string, unknown> = {}) => ({
  actor: CLIENT_PORTAL_ACTOR,
  sessionId: RESPONSE_SESSION_ID,
  proposalVersionId: VERSION_ID,
  responseType: 'ACCEPT' as const,
  acknowledged: true,
  ...overrides,
});

describe('clientProposalResponseSchema (D-047 §9/§15)', () => {
  it('accepts exactly { responseType: <enum>, acknowledgement: "on" } for each response type', () => {
    for (const responseType of ['ACCEPT', 'DECLINE', 'REQUEST_CHANGES']) {
      expect(
        clientProposalResponseSchema.safeParse({ responseType, acknowledgement: 'on' }).success,
      ).toBe(true);
    }
  });

  it('rejects a missing or non-"on" acknowledgement', () => {
    expect(clientProposalResponseSchema.safeParse({ responseType: 'ACCEPT' }).success).toBe(false);
    for (const acknowledgement of ['off', 'true', 'ON', '', true, 1]) {
      expect(
        clientProposalResponseSchema.safeParse({ responseType: 'ACCEPT', acknowledgement }).success,
      ).toBe(false);
    }
  });

  it('rejects a missing or unknown responseType', () => {
    expect(clientProposalResponseSchema.safeParse({ acknowledgement: 'on' }).success).toBe(false);
    for (const responseType of ['MAYBE', 'accept', 'ACCEPTED', '']) {
      expect(
        clientProposalResponseSchema.safeParse({ responseType, acknowledgement: 'on' }).success,
      ).toBe(false);
    }
  });

  it('rejects any extra key (a forged identifier or timestamp) via .strict()', () => {
    for (const extra of [
      { respondedAt: '2026-01-01T00:00:00.000Z' },
      { clientId: 'client-x' },
      { clientProfileId: 'profile-x' },
      { sessionId: 'sess-x' },
      { proposalId: 'p-x' },
      { proposalVersionId: 'pv-x' },
    ]) {
      expect(
        clientProposalResponseSchema.safeParse({
          responseType: 'ACCEPT',
          acknowledgement: 'on',
          ...extra,
        }).success,
      ).toBe(false);
    }
  });
});

describe('clientProposalResponseCodeFor (D-047 §6)', () => {
  it('passes through the five explicit controlled codes', () => {
    for (const code of [
      'VALIDATION_ERROR',
      'PROPOSAL_RESPONSE_ALREADY_RECORDED',
      'PROPOSAL_VERSION_NOT_CURRENT',
      'PROPOSAL_VERSION_SUPERSEDED',
      'PROPOSAL_CONFLICT',
    ] as const) {
      expect(clientProposalResponseCodeFor(new ProposalError(code, 'm'))).toBe(code);
    }
  });

  it('collapses every forbidden / not-found / role code to one generic FORBIDDEN', () => {
    for (const code of [
      'ROLE_NOT_PERMITTED',
      'CLIENT_NOT_FOUND',
      'CLIENT_FORBIDDEN',
      'PROPOSAL_NOT_FOUND',
      'PROPOSAL_FORBIDDEN',
      'PROPOSAL_VERSION_NOT_FOUND',
      'PROPOSAL_VERSION_FORBIDDEN',
    ] as const) {
      expect(clientProposalResponseCodeFor(new ProposalError(code, 'm'))).toBe('FORBIDDEN');
    }
  });
});

describe('submitClientProposalResponse (D-047 §7)', () => {
  beforeEach(() => {
    clientsServiceMocks.getOwnClientForUser.mockResolvedValue(ownedClientIdentity());
    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValue(profileIdentity());
    repositoryMocks.findProposalVersionOwnershipContext.mockResolvedValue(ownershipContext());
    repositoryMocks.findProposalAcceptanceForVersion.mockResolvedValue(null);
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue({ id: VERSION_ID });
    repositoryMocks.createPortalProposalAcceptance.mockResolvedValue(portalAcceptance('ACCEPT'));
    repositoryMocks.insertAuditLog.mockResolvedValue(undefined);
  });

  it('rejects a non-CLIENT actor with ROLE_NOT_PERMITTED before Contract A or any transaction', async () => {
    for (const actor of [ADMIN_MANAGER, TRAVEL_CONSULTANT]) {
      await expect(submitClientProposalResponse(submitInput({ actor }))).rejects.toMatchObject({
        name: 'ProposalError',
        code: 'ROLE_NOT_PERMITTED',
      });
    }
    expect(clientsServiceMocks.getOwnClientForUser).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('fails closed with CLIENT_FORBIDDEN for a missing/empty sessionId, before Contract A', async () => {
    for (const sessionId of ['', undefined, null]) {
      await expect(
        submitClientProposalResponse(submitInput({ sessionId: sessionId as unknown as string })),
      ).rejects.toMatchObject({ name: 'ProposalError', code: 'CLIENT_FORBIDDEN' });
    }
    expect(clientsServiceMocks.getOwnClientForUser).not.toHaveBeenCalled();
  });

  it('re-validates the acknowledgement server-side: acknowledged !== true is VALIDATION_ERROR with no write', async () => {
    await expect(
      submitClientProposalResponse(submitInput({ acknowledged: false })),
    ).rejects.toMatchObject({ name: 'ProposalError', code: 'VALIDATION_ERROR' });

    expect(clientsServiceMocks.getOwnClientForUser).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(repositoryMocks.createPortalProposalAcceptance).not.toHaveBeenCalled();
  });

  it('re-validates the responseType server-side: an out-of-enum value is VALIDATION_ERROR', async () => {
    await expect(
      submitClientProposalResponse(submitInput({ responseType: 'MAYBE' as unknown as 'ACCEPT' })),
    ).rejects.toMatchObject({ name: 'ProposalError', code: 'VALIDATION_ERROR' });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('fails closed (CLIENT_FORBIDDEN) when Contract A resolves no owned client', async () => {
    clientsServiceMocks.getOwnClientForUser.mockResolvedValue(null);

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
    expect(clientsRepositoryMocks.findClientProfileIdentityForUser).not.toHaveBeenCalled();
  });

  it('fails closed when the pre-transaction identity read is null or its clientId disagrees with Contract A', async () => {
    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValueOnce(null);
    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });

    clientsRepositoryMocks.findClientProfileIdentityForUser.mockResolvedValueOnce({
      clientProfileId: CLIENT_PROFILE_ID,
      clientId: 'a-different-client',
    });
    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });

    expect(authorizationMocks.canAccessClient).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('performs the pre-transaction canAccessClient defense-in-depth check and fails closed on denial', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
    expect(authorizationMocks.canAccessClient).toHaveBeenCalledWith(CLIENT_PORTAL_ACTOR, CLIENT_ID);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('happy path (ACCEPT): runs §7 steps 1-2 pre-transaction, then steps 3-8 in one transaction, and returns { responseType }', async () => {
    const result = await submitClientProposalResponse(submitInput());

    expect(result).toEqual({ responseType: 'ACCEPT' });

    // Pre-transaction order: Contract A -> identity read (prisma) -> canAccessClient -> transaction.
    const contractAOrder = clientsServiceMocks.getOwnClientForUser.mock.invocationCallOrder[0]!;
    const preIdentityOrder =
      clientsRepositoryMocks.findClientProfileIdentityForUser.mock.invocationCallOrder[0]!;
    const accessOrder = authorizationMocks.canAccessClient.mock.invocationCallOrder[0]!;
    const txOrder = transactionMock.mock.invocationCallOrder[0]!;
    expect(contractAOrder).toBeLessThan(preIdentityOrder);
    expect(preIdentityOrder).toBeLessThan(accessOrder);
    expect(accessOrder).toBeLessThan(txOrder);

    expect(clientsRepositoryMocks.findClientProfileIdentityForUser).toHaveBeenNthCalledWith(
      1,
      prisma,
      CLIENT_PORTAL_ACTOR.id,
    );
    // canAccessClient is called exactly once — never re-issued inside the transaction.
    expect(authorizationMocks.canAccessClient).toHaveBeenCalledTimes(1);

    // Transaction-local reads all use the tx client.
    expect(clientsRepositoryMocks.findClientProfileIdentityForUser).toHaveBeenNthCalledWith(
      2,
      TX_CLIENT,
      CLIENT_PORTAL_ACTOR.id,
    );
    expect(repositoryMocks.findProposalVersionOwnershipContext).toHaveBeenCalledWith(
      TX_CLIENT,
      VERSION_ID,
    );
    expect(repositoryMocks.findProposalAcceptanceForVersion).toHaveBeenCalledWith(
      TX_CLIENT,
      VERSION_ID,
    );
    expect(repositoryMocks.findCurrentClientVisibleVersion).toHaveBeenCalledWith(
      TX_CLIENT,
      PROPOSAL_ID,
    );

    // §7 step 7 — portal attribution write, server-generated time, external fields absent.
    const writeArg = repositoryMocks.createPortalProposalAcceptance.mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(writeArg.proposalVersionId).toBe(VERSION_ID);
    expect(writeArg.responseType).toBe('ACCEPT');
    expect(writeArg.respondingClientProfileId).toBe(CLIENT_PROFILE_ID);
    expect(writeArg.respondingSessionIdAtResponse).toBe(RESPONSE_SESSION_ID);
    expect(writeArg.respondedAt).toBeInstanceOf(Date);
    for (const external of ['recordedByStaffUserId', 'responseMethod', 'evidenceReference']) {
      expect(writeArg).not.toHaveProperty(external);
    }

    // §7 step 8 — atomic audit; snapshot free of content / staff / session / acknowledgement.
    const auditArg = repositoryMocks.insertAuditLog.mock.calls[0]![1] as {
      actorId: string;
      action: string;
      entityType: string;
      entityId: string;
      afterState: Record<string, unknown>;
    };
    expect(auditArg.actorId).toBe(CLIENT_PORTAL_ACTOR.id);
    expect(auditArg.action).toBe('PROPOSAL_RESPONSE_RECORDED');
    expect(auditArg.entityType).toBe('ProposalVersion');
    expect(auditArg.entityId).toBe(VERSION_ID);
    expect(Object.keys(auditArg.afterState).sort()).toEqual([
      'acceptanceId',
      'respondedAt',
      'responseType',
    ]);
    expect(auditArg.afterState.acceptanceId).toBe(ACCEPTANCE_ID);
    expect(typeof auditArg.afterState.respondedAt).toBe('string');
    const auditJson = JSON.stringify(auditArg);
    expect(auditJson).not.toContain(CLIENT_PROFILE_ID);
    expect(auditJson).not.toContain(RESPONSE_SESSION_ID);
    expect(auditJson).not.toContain('acknowledg');
  });

  it('records DECLINE and REQUEST_CHANGES the same way, returning the submitted responseType', async () => {
    for (const responseType of ['DECLINE', 'REQUEST_CHANGES'] as const) {
      repositoryMocks.createPortalProposalAcceptance.mockReset();
      repositoryMocks.createPortalProposalAcceptance.mockResolvedValue(
        portalAcceptance(responseType),
      );
      repositoryMocks.insertAuditLog.mockClear();

      const result = await submitClientProposalResponse(submitInput({ responseType }));

      expect(result).toEqual({ responseType });
      const auditEntry = repositoryMocks.insertAuditLog.mock.calls[0]![1] as {
        afterState: { responseType: string };
      };
      expect(auditEntry.afterState.responseType).toBe(responseType);
    }
  });

  it('transaction-local: a null tx identity or a clientId mismatch yields one generic CLIENT_FORBIDDEN with no write', async () => {
    clientsRepositoryMocks.findClientProfileIdentityForUser
      .mockResolvedValueOnce(profileIdentity()) // pre-transaction
      .mockResolvedValueOnce(null); // transaction-local

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
    expect(repositoryMocks.createPortalProposalAcceptance).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('transaction-local: an absent target version yields the identical CLIENT_FORBIDDEN (never confirms existence)', async () => {
    repositoryMocks.findProposalVersionOwnershipContext.mockResolvedValue(null);

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
    expect(repositoryMocks.createPortalProposalAcceptance).not.toHaveBeenCalled();
  });

  it('transaction-local: a target owned by another client yields CLIENT_FORBIDDEN with no write', async () => {
    repositoryMocks.findProposalVersionOwnershipContext.mockResolvedValue(
      ownershipContext({ clientId: 'another-clients-id' }),
    );

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'CLIENT_FORBIDDEN',
    });
    expect(repositoryMocks.createPortalProposalAcceptance).not.toHaveBeenCalled();
    expect(authorizationMocks.canAccessClient).toHaveBeenCalledTimes(1);
  });

  it('existing-response check runs first: any acceptance -> PROPOSAL_RESPONSE_ALREADY_RECORDED before the current-version read', async () => {
    repositoryMocks.findProposalAcceptanceForVersion.mockResolvedValue({ id: 'prior-acceptance' });

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED',
    });
    expect(repositoryMocks.findCurrentClientVisibleVersion).not.toHaveBeenCalled();
    expect(repositoryMocks.createPortalProposalAcceptance).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('a superseded target that already carries a response still reports ALREADY_RECORDED, not SUPERSEDED', async () => {
    repositoryMocks.findProposalVersionOwnershipContext.mockResolvedValue(
      ownershipContext({ supersededAt: new Date('2026-09-05T00:00:00.000Z') }),
    );
    repositoryMocks.findProposalAcceptanceForVersion.mockResolvedValue({ id: 'prior' });

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED',
    });
  });

  it('not the current client-visible version and not superseded -> PROPOSAL_VERSION_NOT_CURRENT, no write', async () => {
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue({ id: 'a-newer-version' });

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'PROPOSAL_VERSION_NOT_CURRENT',
    });
    expect(repositoryMocks.createPortalProposalAcceptance).not.toHaveBeenCalled();
  });

  it('superseded target that is not current -> PROPOSAL_VERSION_SUPERSEDED, no write', async () => {
    repositoryMocks.findProposalVersionOwnershipContext.mockResolvedValue(
      ownershipContext({ supersededAt: new Date('2026-09-05T00:00:00.000Z') }),
    );
    repositoryMocks.findCurrentClientVisibleVersion.mockResolvedValue(null);

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      code: 'PROPOSAL_VERSION_SUPERSEDED',
    });
    expect(repositoryMocks.createPortalProposalAcceptance).not.toHaveBeenCalled();
  });

  it('a P2002 unique-race on proposalVersionId maps to PROPOSAL_RESPONSE_ALREADY_RECORDED (never an idempotent success)', async () => {
    repositoryMocks.createPortalProposalAcceptance.mockReset();
    repositoryMocks.createPortalProposalAcceptance.mockRejectedValue(
      conflictError('P2002', ['proposalVersionId']),
    );

    await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
      name: 'ProposalError',
      code: 'PROPOSAL_RESPONSE_ALREADY_RECORDED',
    });
  });

  it('every other residual P2002 / P2004 / exhausted P2034 maps to PROPOSAL_CONFLICT', async () => {
    for (const error of [
      conflictError('P2002', ['proposal_acceptance_pkey']),
      conflictError('P2004'),
      conflictError('P2034'),
    ]) {
      repositoryMocks.createPortalProposalAcceptance.mockReset();
      repositoryMocks.createPortalProposalAcceptance.mockRejectedValue(error);

      await expect(submitClientProposalResponse(submitInput())).rejects.toMatchObject({
        name: 'ProposalError',
        code: 'PROPOSAL_CONFLICT',
      });
    }
  });

  it('a truly unexpected error propagates unchanged (no Prisma detail suppression here)', async () => {
    repositoryMocks.createPortalProposalAcceptance.mockReset();
    repositoryMocks.createPortalProposalAcceptance.mockRejectedValue(new Error('db exploded'));

    await expect(submitClientProposalResponse(submitInput())).rejects.toThrow('db exploded');
  });
});
