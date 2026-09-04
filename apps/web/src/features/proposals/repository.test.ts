import { describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';

import {
  createExternalProposalAcceptance,
  createProposalRevision,
  createProposalWithFirstVersion,
  findClientProposalFacts,
  findClientProposalPreview,
  findCurrentClientVisibleVersion,
  findProposalAcceptanceForVersion,
  findProposalByIdForActor,
  findProposalContext,
  findProposalVersionContext,
  findProposalVersionForActor,
  insertAuditLog,
  listProposalsForActor,
  markProposalVersionClientVisible,
  markProposalVersionSuperseded,
} from './repository';

// Database-free unit tests only — every Prisma delegate is a mocked
// `vi.fn()`, matching features/bookings/repository.test.ts's and
// features/clients/repository.test.ts's identical discipline. No
// PostgreSQL access of any kind.

const ADMIN_MANAGER = { id: 'admin-1', role: 'ADMIN_MANAGER' as const };
const TRAVEL_CONSULTANT = { id: 'tc-1', role: 'TRAVEL_CONSULTANT' as const };

const TC_ASSIGNMENT_FILTER = {
  assignments: { some: { assignedStaffId: TRAVEL_CONSULTANT.id, endedAt: null } },
};

const PROPOSAL_ID = 'proposal-1';
const VERSION_ID = 'version-1';
const CLIENT_ID = 'client-1';
const ACCEPTANCE_ID = 'acceptance-1';

describe('listProposalsForActor', () => {
  it('runs one findMany and one count with no Client filter for ADMIN_MANAGER, applying pagination', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: PROPOSAL_ID,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        client: { id: CLIENT_ID, fullName: 'Jordan Cruz' },
      },
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const db = { proposal: { findMany, count } } as unknown as Prisma.TransactionClient;

    const result = await listProposalsForActor(db, ADMIN_MANAGER, { skip: 20, take: 10 });

    expect(result.total).toBe(1);
    expect(result.items).toEqual([
      {
        id: PROPOSAL_ID,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        client: { id: CLIENT_ID, fullName: 'Jordan Cruz' },
      },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { client: undefined },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 20,
      take: 10,
    });
    expect(count).toHaveBeenCalledWith({ where: { client: undefined } });
  });

  it('scopes both findMany and count by the exact active-Client-assignment predicate for TRAVEL_CONSULTANT', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { proposal: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listProposalsForActor(db, TRAVEL_CONSULTANT, { skip: 0, take: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { client: TC_ASSIGNMENT_FILTER } }),
    );
    expect(count).toHaveBeenCalledWith({ where: { client: TC_ASSIGNMENT_FILTER } });
  });

  it('issues findMany and count against the identical where object, never a per-row query', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { proposal: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listProposalsForActor(db, TRAVEL_CONSULTANT, { skip: 0, take: 20 });

    const findManyWhere = findMany.mock.calls[0]?.[0].where;
    const countWhere = count.mock.calls[0]?.[0].where;
    expect(findManyWhere).toEqual(countWhere);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('orders by createdAt desc then id desc — deterministic, newest-first pagination', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { proposal: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listProposalsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    expect(findMany.mock.calls[0]?.[0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('passes skip/take straight through as the pagination window', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { proposal: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listProposalsForActor(db, ADMIN_MANAGER, { skip: 40, take: 5 });

    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ skip: 40, take: 5 });
  });

  it('selects no ProposalVersion field at all — no content, no versions relation, in the list select', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const db = { proposal: { findMany, count } } as unknown as Prisma.TransactionClient;

    await listProposalsForActor(db, ADMIN_MANAGER, { skip: 0, take: 20 });

    const select = findMany.mock.calls[0]?.[0].select as Record<string, unknown>;
    expect(select).not.toHaveProperty('content');
    expect(select).not.toHaveProperty('versions');
    expect(select).toEqual({
      id: true,
      createdAt: true,
      updatedAt: true,
      client: { select: { id: true, fullName: true } },
    });
  });
});

describe('findProposalByIdForActor', () => {
  it('scopes the query with no Client filter for ADMIN_MANAGER (unconditional access)', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposal: { findFirst } } as unknown as Prisma.TransactionClient;

    await findProposalByIdForActor(db, ADMIN_MANAGER, PROPOSAL_ID);

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: PROPOSAL_ID, client: undefined },
      select: expect.any(Object),
    });
  });

  it('scopes the query with the active-assignment predicate directly in where for TRAVEL_CONSULTANT', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposal: { findFirst } } as unknown as Prisma.TransactionClient;

    await findProposalByIdForActor(db, TRAVEL_CONSULTANT, PROPOSAL_ID);

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: PROPOSAL_ID, client: TC_ASSIGNMENT_FILTER },
      select: expect.any(Object),
    });
  });

  it('returns null for no actor-scoped match — never distinguishing nonexistent from inaccessible', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposal: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findProposalByIdForActor(db, TRAVEL_CONSULTANT, PROPOSAL_ID);

    expect(result).toBeNull();
  });

  it('selects the complete version-history field set, ordered versionNumber desc, plus the nested acceptance select', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposal: { findFirst } } as unknown as Prisma.TransactionClient;

    await findProposalByIdForActor(db, ADMIN_MANAGER, PROPOSAL_ID);

    const select = findFirst.mock.calls[0]?.[0].select as {
      versions: { select: Record<string, unknown>; orderBy: unknown };
    };
    expect(select.versions.orderBy).toEqual({ versionNumber: 'desc' });
    expect(select.versions.select).toEqual({
      id: true,
      proposalId: true,
      versionNumber: true,
      content: true,
      clientVisibleAt: true,
      supersededAt: true,
      createdByUserId: true,
      createdAt: true,
      updatedAt: true,
      acceptance: {
        select: {
          id: true,
          proposalVersionId: true,
          responseType: true,
          respondedAt: true,
          recordedByStaffUserId: true,
          responseMethod: true,
          evidenceReference: true,
          createdAt: true,
        },
      },
    });
  });

  it('returns a legacy null content unchanged, and maps a present acceptance through exactly', async () => {
    const respondedAt = new Date('2026-08-03T09:00:00.000Z');
    const versionCreatedAt = new Date('2026-08-01T00:00:00.000Z');
    const proposalCreatedAt = new Date('2026-07-30T00:00:00.000Z');
    const resolved = {
      id: PROPOSAL_ID,
      createdAt: proposalCreatedAt,
      updatedAt: proposalCreatedAt,
      client: { id: CLIENT_ID, fullName: 'Jordan Cruz' },
      versions: [
        {
          id: VERSION_ID,
          proposalId: PROPOSAL_ID,
          versionNumber: 1,
          content: null,
          clientVisibleAt: versionCreatedAt,
          supersededAt: null,
          createdByUserId: 'tc-1',
          createdAt: versionCreatedAt,
          updatedAt: versionCreatedAt,
          acceptance: {
            id: ACCEPTANCE_ID,
            proposalVersionId: VERSION_ID,
            responseType: 'ACCEPT',
            respondedAt,
            recordedByStaffUserId: 'admin-1',
            responseMethod: 'phone',
            evidenceReference: 'Call log #4821',
            createdAt: respondedAt,
          },
        },
      ],
    };
    const findFirst = vi.fn().mockResolvedValue(resolved);
    const db = { proposal: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findProposalByIdForActor(db, ADMIN_MANAGER, PROPOSAL_ID);

    expect(result?.versions[0]?.content).toBeNull();
    expect(result?.versions[0]?.acceptance).toEqual(resolved.versions[0]?.acceptance);
    expect(result).toEqual(resolved);
  });
});

describe('findProposalContext', () => {
  it('selects only id and clientId — no unrestricted full detail', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: PROPOSAL_ID, clientId: CLIENT_ID });
    const db = { proposal: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findProposalContext(db, PROPOSAL_ID);

    expect(result).toEqual({ id: PROPOSAL_ID, clientId: CLIENT_ID });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: PROPOSAL_ID },
      select: { id: true, clientId: true },
    });
  });

  it('returns null when the Proposal does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { proposal: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await findProposalContext(db, PROPOSAL_ID)).toBeNull();
  });
});

describe('findProposalVersionContext', () => {
  it("selects only id, proposalId, and the Proposal's clientId — no unrestricted full detail", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      proposal: { clientId: CLIENT_ID },
    });
    const db = { proposalVersion: { findUnique } } as unknown as Prisma.TransactionClient;

    const result = await findProposalVersionContext(db, VERSION_ID);

    expect(result).toEqual({ id: VERSION_ID, proposalId: PROPOSAL_ID, clientId: CLIENT_ID });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: VERSION_ID },
      select: { id: true, proposalId: true, proposal: { select: { clientId: true } } },
    });
  });

  it('returns null when the ProposalVersion does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { proposalVersion: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await findProposalVersionContext(db, VERSION_ID)).toBeNull();
  });
});

describe('findProposalVersionForActor', () => {
  it('applies no assignment filter for ADMIN_MANAGER', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      versionNumber: 2,
      clientVisibleAt: null,
      supersededAt: null,
      proposal: { clientId: CLIENT_ID },
    });
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findProposalVersionForActor(db, ADMIN_MANAGER, VERSION_ID);

    expect(result).toEqual({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      clientId: CLIENT_ID,
      versionNumber: 2,
      clientVisibleAt: null,
      supersededAt: null,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: VERSION_ID, proposal: { client: undefined } },
      select: expect.any(Object),
    });
  });

  it('embeds the active-assignment predicate directly inside where, via proposal.client, for TRAVEL_CONSULTANT', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    const result = await findProposalVersionForActor(db, TRAVEL_CONSULTANT, VERSION_ID);

    expect(result).toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: VERSION_ID, proposal: { client: TC_ASSIGNMENT_FILTER } },
      select: expect.any(Object),
    });
  });

  it('never selects content — this lookup serves publish/response workflows only', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    await findProposalVersionForActor(db, ADMIN_MANAGER, VERSION_ID);

    const select = findFirst.mock.calls[0]?.[0].select as Record<string, unknown>;
    expect(select).not.toHaveProperty('content');
  });
});

describe('createProposalWithFirstVersion', () => {
  it('creates the Proposal with a nested first ProposalVersion (versionNumber 1) in one write, and returns both records unpublished', async () => {
    const versionCreatedAt = new Date('2026-08-04T00:00:00.000Z');
    const create = vi.fn().mockResolvedValue({
      id: PROPOSAL_ID,
      clientId: CLIENT_ID,
      createdAt: versionCreatedAt,
      updatedAt: versionCreatedAt,
      versions: [
        {
          id: VERSION_ID,
          proposalId: PROPOSAL_ID,
          versionNumber: 1,
          content: 'Day 1: Arrival.',
          clientVisibleAt: null,
          supersededAt: null,
          createdByUserId: 'tc-1',
          createdAt: versionCreatedAt,
          updatedAt: versionCreatedAt,
        },
      ],
    });
    const db = { proposal: { create } } as unknown as Prisma.TransactionClient;

    const result = await createProposalWithFirstVersion(db, {
      id: PROPOSAL_ID,
      clientId: CLIENT_ID,
      content: 'Day 1: Arrival.',
      createdByUserId: 'tc-1',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        id: PROPOSAL_ID,
        clientId: CLIENT_ID,
        versions: {
          create: {
            id: expect.any(String),
            versionNumber: 1,
            content: 'Day 1: Arrival.',
            createdByUserId: 'tc-1',
          },
        },
      },
      select: expect.any(Object),
    });
    expect(result.proposal).toEqual({
      id: PROPOSAL_ID,
      clientId: CLIENT_ID,
      createdAt: versionCreatedAt,
      updatedAt: versionCreatedAt,
    });
    expect(result.version.id).toBe(VERSION_ID);
    expect(result.version.versionNumber).toBe(1);
    expect(result.version.content).toBe('Day 1: Arrival.');
    expect(result.version.createdByUserId).toBe('tc-1');
    expect(result.version.clientVisibleAt).toBeNull();
    expect(result.version.supersededAt).toBeNull();
  });

  it('generates a fresh id for the nested first version on every call — never caller-supplied', async () => {
    const create = vi.fn().mockResolvedValue({
      id: PROPOSAL_ID,
      clientId: CLIENT_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      versions: [
        {
          id: 'whatever-the-mock-returns',
          proposalId: PROPOSAL_ID,
          versionNumber: 1,
          content: 'x',
          clientVisibleAt: null,
          supersededAt: null,
          createdByUserId: 'tc-1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const db = { proposal: { create } } as unknown as Prisma.TransactionClient;

    await createProposalWithFirstVersion(db, {
      id: PROPOSAL_ID,
      clientId: CLIENT_ID,
      content: 'x',
      createdByUserId: 'tc-1',
    });

    const firstVersionId = create.mock.calls[0]?.[0].data.versions.create.id as string;
    expect(typeof firstVersionId).toBe('string');
    expect(firstVersionId.length).toBeGreaterThan(0);
  });
});

describe('createProposalRevision', () => {
  it('allocates versionNumber 1 when no prior version exists (MAX is null)', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _max: { versionNumber: null } });
    const create = vi.fn().mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      versionNumber: 1,
      content: 'Revised.',
      clientVisibleAt: null,
      supersededAt: null,
      createdByUserId: 'tc-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = { proposalVersion: { aggregate, create } } as unknown as Prisma.TransactionClient;

    const result = await createProposalRevision(db, {
      proposalId: PROPOSAL_ID,
      content: 'Revised.',
      createdByUserId: 'tc-1',
    });

    expect(result.versionNumber).toBe(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        proposalId: PROPOSAL_ID,
        versionNumber: 1,
        content: 'Revised.',
        createdByUserId: 'tc-1',
      },
      select: expect.any(Object),
    });
  });

  it('allocates MAX + 1 when a prior version exists', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _max: { versionNumber: 4 } });
    const create = vi.fn().mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      versionNumber: 5,
      content: 'Revised again.',
      clientVisibleAt: null,
      supersededAt: null,
      createdByUserId: 'tc-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = { proposalVersion: { aggregate, create } } as unknown as Prisma.TransactionClient;

    const result = await createProposalRevision(db, {
      proposalId: PROPOSAL_ID,
      content: 'Revised again.',
      createdByUserId: 'tc-1',
    });

    expect(result.versionNumber).toBe(5);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ versionNumber: 5 }) }),
    );
  });

  it('runs the aggregate and the create against the exact same proposalId, on the same caller-provided transaction client', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _max: { versionNumber: 2 } });
    const create = vi.fn().mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      versionNumber: 3,
      content: 'x',
      clientVisibleAt: null,
      supersededAt: null,
      createdByUserId: 'tc-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = { proposalVersion: { aggregate, create } } as unknown as Prisma.TransactionClient;

    await createProposalRevision(db, {
      proposalId: PROPOSAL_ID,
      content: 'x',
      createdByUserId: 'tc-1',
    });

    expect(aggregate).toHaveBeenCalledWith({
      where: { proposalId: PROPOSAL_ID },
      _max: { versionNumber: true },
    });
    expect(create.mock.calls[0]?.[0].data.proposalId).toBe(PROPOSAL_ID);
  });

  it('never opens its own transaction or retries — the mocked db exposes only aggregate/create, no $transaction', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _max: { versionNumber: null } });
    const create = vi.fn().mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      versionNumber: 1,
      content: 'x',
      clientVisibleAt: null,
      supersededAt: null,
      createdByUserId: 'tc-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Deliberately no `$transaction` on this mock — if createProposalRevision
    // ever tried to open one, this call would throw (`db.$transaction is not
    // a function`), failing this test.
    const db = { proposalVersion: { aggregate, create } } as unknown as Prisma.TransactionClient;

    await expect(
      createProposalRevision(db, {
        proposalId: PROPOSAL_ID,
        content: 'x',
        createdByUserId: 'tc-1',
      }),
    ).resolves.toBeDefined();
  });
});

describe('findCurrentClientVisibleVersion', () => {
  it('queries clientVisibleAt not null and supersededAt null for the given Proposal', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    await findCurrentClientVisibleVersion(db, PROPOSAL_ID);

    expect(findFirst).toHaveBeenCalledWith({
      where: { proposalId: PROPOSAL_ID, clientVisibleAt: { not: null }, supersededAt: null },
      select: expect.any(Object),
    });
  });

  it('returns null when no version is currently client-visible', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { proposalVersion: { findFirst } } as unknown as Prisma.TransactionClient;

    expect(await findCurrentClientVisibleVersion(db, PROPOSAL_ID)).toBeNull();
  });
});

describe('markProposalVersionSuperseded', () => {
  it('updates supersededAt to exactly the supplied Date, deciding nothing else', async () => {
    const supersededAt = new Date('2026-08-04T12:00:00.000Z');
    const update = vi.fn().mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      versionNumber: 1,
      content: 'x',
      clientVisibleAt: new Date('2026-08-01T00:00:00.000Z'),
      supersededAt,
      createdByUserId: 'tc-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = { proposalVersion: { update } } as unknown as Prisma.TransactionClient;

    const result = await markProposalVersionSuperseded(db, VERSION_ID, supersededAt);

    expect(update).toHaveBeenCalledWith({
      where: { id: VERSION_ID },
      data: { supersededAt },
      select: expect.any(Object),
    });
    expect(result.supersededAt).toEqual(supersededAt);
  });
});

describe('markProposalVersionClientVisible', () => {
  it('updates clientVisibleAt to exactly the supplied Date, deciding nothing else', async () => {
    const clientVisibleAt = new Date('2026-08-04T12:00:00.000Z');
    const update = vi.fn().mockResolvedValue({
      id: VERSION_ID,
      proposalId: PROPOSAL_ID,
      versionNumber: 2,
      content: 'x',
      clientVisibleAt,
      supersededAt: null,
      createdByUserId: 'tc-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const db = { proposalVersion: { update } } as unknown as Prisma.TransactionClient;

    const result = await markProposalVersionClientVisible(db, VERSION_ID, clientVisibleAt);

    expect(update).toHaveBeenCalledWith({
      where: { id: VERSION_ID },
      data: { clientVisibleAt },
      select: expect.any(Object),
    });
    expect(result.clientVisibleAt).toEqual(clientVisibleAt);
  });
});

describe('findProposalAcceptanceForVersion', () => {
  it('looks up the acceptance by proposalVersionId using findUnique', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { proposalAcceptance: { findUnique } } as unknown as Prisma.TransactionClient;

    await findProposalAcceptanceForVersion(db, VERSION_ID);

    expect(findUnique).toHaveBeenCalledWith({
      where: { proposalVersionId: VERSION_ID },
      select: expect.any(Object),
    });
  });

  it('returns null when no response has been recorded yet', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { proposalAcceptance: { findUnique } } as unknown as Prisma.TransactionClient;

    expect(await findProposalAcceptanceForVersion(db, VERSION_ID)).toBeNull();
  });
});

describe('createExternalProposalAcceptance', () => {
  it('creates exactly one ProposalAcceptance with the exact external-attribution fields, populating no portal field', async () => {
    const respondedAt = new Date('2026-08-04T10:00:00.000Z');
    const create = vi.fn().mockResolvedValue({
      id: ACCEPTANCE_ID,
      proposalVersionId: VERSION_ID,
      responseType: 'ACCEPT',
      respondedAt,
      recordedByStaffUserId: 'admin-1',
      responseMethod: 'phone',
      evidenceReference: 'Call log #4821',
      createdAt: respondedAt,
    });
    const db = { proposalAcceptance: { create } } as unknown as Prisma.TransactionClient;

    const result = await createExternalProposalAcceptance(db, {
      proposalVersionId: VERSION_ID,
      responseType: 'ACCEPT',
      respondedAt,
      recordedByStaffUserId: 'admin-1',
      responseMethod: 'phone',
      evidenceReference: 'Call log #4821',
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        proposalVersionId: VERSION_ID,
        responseType: 'ACCEPT',
        respondedAt,
        recordedByStaffUserId: 'admin-1',
        responseMethod: 'phone',
        evidenceReference: 'Call log #4821',
      },
      select: expect.any(Object),
    });

    const writtenData = create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(writtenData).not.toHaveProperty('respondingClientProfileId');
    expect(writtenData).not.toHaveProperty('respondingSessionIdAtResponse');

    expect(result).toEqual({
      id: ACCEPTANCE_ID,
      proposalVersionId: VERSION_ID,
      responseType: 'ACCEPT',
      respondedAt,
      recordedByStaffUserId: 'admin-1',
      responseMethod: 'phone',
      evidenceReference: 'Call log #4821',
      createdAt: respondedAt,
    });
  });

  it('persists responseMethod/evidenceReference exactly as supplied, inventing no further transformation', async () => {
    const respondedAt = new Date('2026-08-04T10:00:00.000Z');
    const create = vi.fn().mockResolvedValue({
      id: ACCEPTANCE_ID,
      proposalVersionId: VERSION_ID,
      responseType: 'DECLINE',
      respondedAt,
      recordedByStaffUserId: 'admin-1',
      responseMethod: 'in person',
      evidenceReference: 'Signed form ref #77',
      createdAt: respondedAt,
    });
    const db = { proposalAcceptance: { create } } as unknown as Prisma.TransactionClient;

    await createExternalProposalAcceptance(db, {
      proposalVersionId: VERSION_ID,
      responseType: 'DECLINE',
      respondedAt,
      recordedByStaffUserId: 'admin-1',
      responseMethod: 'in person',
      evidenceReference: 'Signed form ref #77',
    });

    const writtenData = create.mock.calls[0]?.[0].data as {
      responseMethod: string;
      evidenceReference: string;
    };
    expect(writtenData.responseMethod).toBe('in person');
    expect(writtenData.evidenceReference).toBe('Signed form ref #77');
  });
});

describe('insertAuditLog', () => {
  it('inserts a single AuditLog row with exactly the given fields', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    await insertAuditLog(db, {
      actorId: 'tc-1',
      action: 'PROPOSAL_CREATED',
      entityType: 'Proposal',
      entityId: PROPOSAL_ID,
      afterState: { clientId: CLIENT_ID, firstVersionId: VERSION_ID, firstVersionNumber: 1 },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        actorId: 'tc-1',
        action: 'PROPOSAL_CREATED',
        entityType: 'Proposal',
        entityId: PROPOSAL_ID,
        beforeState: undefined,
        afterState: { clientId: CLIENT_ID, firstVersionId: VERSION_ID, firstVersionNumber: 1 },
      },
    });
  });

  it('never widens the persisted data beyond the seven named fields, even given an adversarially widened entry containing content', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const db = { auditLog: { create } } as unknown as Prisma.TransactionClient;

    // Simulates a caller mistake: an `entry`-shaped object that also carries
    // a stray `content` property never declared on `insertAuditLog`'s own
    // parameter type. Assigned to a `const` first (not passed as a fresh
    // object literal) so TypeScript's excess-property check does not itself
    // block this from compiling — mirrors audit.test.ts's identical
    // widened-fixture technique.
    const widenedEntry = {
      actorId: 'tc-1',
      action: 'PROPOSAL_VERSION_CREATED',
      entityType: 'ProposalVersion',
      entityId: VERSION_ID,
      afterState: { proposalId: PROPOSAL_ID, versionNumber: 2 },
      content: 'Day 1: Arrival. This must never reach the audit row.',
    };

    await insertAuditLog(db, widenedEntry);

    const writtenData = create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(writtenData).not.toHaveProperty('content');
    expect(Object.keys(writtenData).sort()).toEqual(
      ['id', 'actorId', 'action', 'entityType', 'entityId', 'beforeState', 'afterState'].sort(),
    );
  });
});

// --- Client-portal reads (D-040 §4) ---

const CLIENT_VISIBLE_BASE = {
  proposal: { clientId: CLIENT_ID },
  clientVisibleAt: { not: null },
  supersededAt: null,
};

describe('findClientProposalFacts', () => {
  it('issues exactly the five D-040 §4 counts, each as base predicate + its own addition', async () => {
    const count = vi
      .fn()
      .mockResolvedValueOnce(4) // currentVisibleTotal
      .mockResolvedValueOnce(1) // awaitingResponse
      .mockResolvedValueOnce(2) // accepted
      .mockResolvedValueOnce(1) // acceptedWithoutClientVisibleBooking
      .mockResolvedValueOnce(1); // respondedNonAccept
    const db = { proposalVersion: { count } } as unknown as Prisma.TransactionClient;

    const result = await findClientProposalFacts(db, CLIENT_ID);

    expect(count).toHaveBeenCalledTimes(5);
    expect(count.mock.calls[0]![0]).toEqual({ where: CLIENT_VISIBLE_BASE });
    expect(count.mock.calls[1]![0]).toEqual({
      where: { ...CLIENT_VISIBLE_BASE, acceptance: { is: null } },
    });
    expect(count.mock.calls[2]![0]).toEqual({
      where: { ...CLIENT_VISIBLE_BASE, acceptance: { is: { responseType: 'ACCEPT' } } },
    });
    expect(count.mock.calls[3]![0]).toEqual({
      where: {
        ...CLIENT_VISIBLE_BASE,
        acceptance: { is: { responseType: 'ACCEPT' } },
        OR: [{ booking: { is: null } }, { booking: { is: { status: 'DRAFT' } } }],
      },
    });
    expect(count.mock.calls[4]![0]).toEqual({
      where: {
        ...CLIENT_VISIBLE_BASE,
        acceptance: { is: { responseType: { in: ['DECLINE', 'REQUEST_CHANGES'] } } },
      },
    });

    expect(result).toEqual({
      currentVisibleTotal: 4,
      awaitingResponse: 1,
      accepted: 2,
      acceptedWithoutClientVisibleBooking: 1,
      respondedNonAccept: 1,
    });
  });

  it('acceptedWithoutClientVisibleBooking counts a missing booking OR a DRAFT booking (never a non-DRAFT one)', async () => {
    const count = vi.fn().mockResolvedValue(0);
    const db = { proposalVersion: { count } } as unknown as Prisma.TransactionClient;

    await findClientProposalFacts(db, CLIENT_ID);

    const acwcvbWhere = count.mock.calls[3]![0].where;
    expect(acwcvbWhere.OR).toEqual([
      { booking: { is: null } },
      { booking: { is: { status: 'DRAFT' } } },
    ]);
    expect(acwcvbWhere.acceptance).toEqual({ is: { responseType: 'ACCEPT' } });
  });

  it('every count carries the clientVisibleAt-set AND supersededAt-null predicate (superseded/draft versions excluded)', async () => {
    const count = vi.fn().mockResolvedValue(0);
    const db = { proposalVersion: { count } } as unknown as Prisma.TransactionClient;

    await findClientProposalFacts(db, CLIENT_ID);

    for (const call of count.mock.calls) {
      expect(call[0].where.clientVisibleAt).toEqual({ not: null });
      expect(call[0].where.supersededAt).toBeNull();
      expect(call[0].where.proposal).toEqual({ clientId: CLIENT_ID });
    }
  });
});

describe('findClientProposalPreview', () => {
  it('applies the current-visible predicate, deterministic proposal-level ordering, take: 5, and a content-free select', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { versionNumber: 3, acceptance: { responseType: 'ACCEPT' } },
      { versionNumber: 1, acceptance: null },
    ]);
    const db = { proposalVersion: { findMany } } as unknown as Prisma.TransactionClient;

    const result = await findClientProposalPreview(db, CLIENT_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: CLIENT_VISIBLE_BASE,
      orderBy: [{ proposal: { createdAt: 'desc' } }, { proposal: { id: 'asc' } }],
      take: 5,
      select: { versionNumber: true, acceptance: { select: { responseType: true } } },
    });
    expect(result).toEqual([
      { versionNumber: 3, responseType: 'ACCEPT' },
      { versionNumber: 1, responseType: null },
    ]);
    const select = findMany.mock.calls[0]![0].select;
    expect(select).not.toHaveProperty('content');
    expect(select).not.toHaveProperty('id');
    expect(select).not.toHaveProperty('proposalId');
  });

  it('maps an absent acceptance to responseType: null', async () => {
    const findMany = vi.fn().mockResolvedValue([{ versionNumber: 1, acceptance: null }]);
    const db = { proposalVersion: { findMany } } as unknown as Prisma.TransactionClient;

    expect(await findClientProposalPreview(db, CLIENT_ID)).toEqual([
      { versionNumber: 1, responseType: null },
    ]);
  });
});
