import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db` (transitively, via
// @/lib/serializable-transaction, and directly for non-transactional reads),
// which eagerly validates env vars and opens a real database adapter at
// import time. Mock it before `./service` is imported — the same reason
// features/assignments/service.test.ts and features/staff/service.test.ts
// mock it. `runSerializableWithRetry` itself is intentionally left unmocked
// (real implementation), so these tests exercise the real retry/backoff
// logic composed with a mocked `$transaction`.
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { $transaction: transactionMock, marker: 'prisma-singleton' },
}));

const repositoryMocks = vi.hoisted(() => ({
  findBookingByProposalVersionIdForActor: vi.fn(),
  findBookingByIdForActor: vi.fn(),
  listBookingsForActor: vi.fn(),
  findEligibleProposalVersionForActor: vi.fn(),
  createBookingWithInitialHistory: vi.fn(),
  updateBookingStatusWithHistory: vi.fn(),
  insertAuditLog: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import type { BookingActor, BookingRecord } from './repository';
import { createBooking, getBookingById, listBookings, updateBookingStatus } from './service';

const TX_CLIENT = { marker: 'tx-client' };

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

// The narrowed `BookingActor` shape `assertBookingActor` produces from the
// two `AuthenticatedUser`s above — repository calls now receive this, not
// the full `AuthenticatedUser` (see service.ts's `assertBookingActor`).
const ADMIN_MANAGER_ACTOR: BookingActor = { id: ADMIN_MANAGER.id, role: 'ADMIN_MANAGER' };
const TRAVEL_CONSULTANT_ACTOR: BookingActor = {
  id: TRAVEL_CONSULTANT.id,
  role: 'TRAVEL_CONSULTANT',
};

const PROPOSAL_VERSION_ID = 'pv-1';
const CLIENT_ID = 'client-1';

function bookingRecord(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'booking-1',
    bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD',
    clientId: CLIENT_ID,
    proposalVersionId: PROPOSAL_VERSION_ID,
    status: 'DRAFT',
    tourPackageName: null,
    destination: null,
    travelStartDate: null,
    travelEndDate: null,
    travelerCount: null,
    includedServices: null,
    excludedServices: null,
    specialRequests: null,
    internalNotes: null,
    clientVisibleNotes: null,
    createdAt: new Date('2026-07-20T00:00:00Z'),
    updatedAt: new Date('2026-07-20T00:00:00Z'),
    ...overrides,
  };
}

function eligibleProposalVersion(
  overrides: Partial<{ id: string; clientId: string; hasAcceptedAcceptance: boolean }> = {},
) {
  return {
    id: PROPOSAL_VERSION_ID,
    clientId: CLIENT_ID,
    hasAcceptedAcceptance: true,
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
  repositoryMocks.findBookingByProposalVersionIdForActor.mockResolvedValue(null);
  repositoryMocks.findEligibleProposalVersionForActor.mockResolvedValue(eligibleProposalVersion());
});

describe('createBooking', () => {
  it('creates a Booking for ADMIN_MANAGER, writing the Booking, initial DRAFT history, and one audit entry atomically', async () => {
    const created = bookingRecord();
    repositoryMocks.createBookingWithInitialHistory.mockResolvedValue(created);

    const result = await createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID });

    expect(result).toEqual({ booking: created, created: true });

    expect(repositoryMocks.findEligibleProposalVersionForActor).toHaveBeenCalledWith(
      TX_CLIENT,
      ADMIN_MANAGER_ACTOR,
      PROPOSAL_VERSION_ID,
    );
    expect(repositoryMocks.createBookingWithInitialHistory).toHaveBeenCalledWith(TX_CLIENT, {
      id: expect.any(String),
      bookingReference: expect.stringMatching(/^HPB-[0-9A-F]{20}$/),
      clientId: CLIENT_ID,
      proposalVersionId: PROPOSAL_VERSION_ID,
      changedByUserId: ADMIN_MANAGER.id,
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ADMIN_MANAGER.id,
      action: 'BOOKING_CREATED',
      entityType: 'Booking',
      entityId: created.id,
      afterState: {
        id: created.id,
        bookingReference: created.bookingReference,
        clientId: created.clientId,
        proposalVersionId: created.proposalVersionId,
        status: created.status,
      },
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledTimes(1);
    // Both the eligibility check, the write, and the audit entry happened
    // inside the single $transaction callback — never as separate
    // top-level transactions.
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('creates a Booking for an assigned TRAVEL_CONSULTANT', async () => {
    const created = bookingRecord();
    repositoryMocks.createBookingWithInitialHistory.mockResolvedValue(created);

    const result = await createBooking(TRAVEL_CONSULTANT, {
      proposalVersionId: PROPOSAL_VERSION_ID,
    });

    expect(result).toEqual({ booking: created, created: true });
    expect(repositoryMocks.findEligibleProposalVersionForActor).toHaveBeenCalledWith(
      TX_CLIENT,
      TRAVEL_CONSULTANT_ACTOR,
      PROPOSAL_VERSION_ID,
    );
    expect(repositoryMocks.createBookingWithInitialHistory).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ changedByUserId: TRAVEL_CONSULTANT.id }),
    );
  });

  it('rejects an unassigned TRAVEL_CONSULTANT with PROPOSAL_VERSION_FORBIDDEN (403), not a 404 — no resource-existence leak', async () => {
    repositoryMocks.findEligibleProposalVersionForActor.mockResolvedValue(null);

    await expect(
      createBooking(TRAVEL_CONSULTANT, { proposalVersionId: PROPOSAL_VERSION_ID }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_FORBIDDEN', status: 403 });
    expect(repositoryMocks.createBookingWithInitialHistory).not.toHaveBeenCalled();
  });

  it('reports a genuinely missing ProposalVersion as PROPOSAL_VERSION_NOT_FOUND (404) for ADMIN_MANAGER', async () => {
    repositoryMocks.findEligibleProposalVersionForActor.mockResolvedValue(null);

    await expect(
      createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_NOT_FOUND', status: 404 });
    expect(repositoryMocks.createBookingWithInitialHistory).not.toHaveBeenCalled();
  });

  it('rejects with PROPOSAL_VERSION_NOT_ACCEPTED when there is no ProposalAcceptance at all', async () => {
    repositoryMocks.findEligibleProposalVersionForActor.mockResolvedValue(
      eligibleProposalVersion({ hasAcceptedAcceptance: false }),
    );

    await expect(
      createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID }),
    ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_NOT_ACCEPTED', status: 409 });
    expect(repositoryMocks.createBookingWithInitialHistory).not.toHaveBeenCalled();
  });

  it.each(['DECLINE', 'REQUEST_CHANGES'])(
    'rejects with PROPOSAL_VERSION_NOT_ACCEPTED for a %s response (repository already reports hasAcceptedAcceptance: false)',
    async () => {
      repositoryMocks.findEligibleProposalVersionForActor.mockResolvedValue(
        eligibleProposalVersion({ hasAcceptedAcceptance: false }),
      );

      await expect(
        createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID }),
      ).rejects.toMatchObject({ code: 'PROPOSAL_VERSION_NOT_ACCEPTED' });
    },
  );

  it('derives Booking.clientId from the resolved ProposalVersion, never from caller input, satisfying the client-consistency invariant by construction', async () => {
    repositoryMocks.findEligibleProposalVersionForActor.mockResolvedValue(
      eligibleProposalVersion({ clientId: 'resolved-client-42' }),
    );
    repositoryMocks.createBookingWithInitialHistory.mockResolvedValue(
      bookingRecord({ clientId: 'resolved-client-42' }),
    );

    await createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID });

    expect(repositoryMocks.createBookingWithInitialHistory).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ clientId: 'resolved-client-42' }),
    );
  });

  it('is idempotent: an existing actor-accessible Booking for the same proposalVersionId is returned unchanged with no new write and no new audit entry', async () => {
    const existing = bookingRecord();
    repositoryMocks.findBookingByProposalVersionIdForActor.mockResolvedValue(existing);

    const result = await createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID });

    expect(result).toEqual({ booking: existing, created: false });
    expect(repositoryMocks.findEligibleProposalVersionForActor).not.toHaveBeenCalled();
    expect(repositoryMocks.createBookingWithInitialHistory).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('retries with a freshly generated bookingReference when reference uniqueness loses a race, without duplicating the audit entry', async () => {
    const created = bookingRecord();
    repositoryMocks.createBookingWithInitialHistory
      .mockRejectedValueOnce(conflictError('P2002', ['bookingReference']))
      .mockResolvedValueOnce(created);

    const result = await createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID });

    expect(result).toEqual({ booking: created, created: true });
    expect(repositoryMocks.createBookingWithInitialHistory).toHaveBeenCalledTimes(2);
    const [firstAttempt, secondAttempt] =
      repositoryMocks.createBookingWithInitialHistory.mock.calls;
    expect(firstAttempt?.[1].bookingReference).not.toEqual(secondAttempt?.[1].bookingReference);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting bookingReference retries, mapping the residual conflict to the controlled BOOKING_CONFLICT envelope', async () => {
    repositoryMocks.createBookingWithInitialHistory.mockRejectedValue(
      conflictError('P2002', ['bookingReference']),
    );

    await expect(
      createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID }),
    ).rejects.toMatchObject({ code: 'BOOKING_CONFLICT', status: 409 });
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('re-reads and returns the actor-accessible Booking as the idempotent result when proposalVersionId uniqueness loses a race', async () => {
    const raced = bookingRecord({ id: 'booking-from-other-request' });
    repositoryMocks.createBookingWithInitialHistory.mockRejectedValueOnce(
      conflictError('P2002', ['proposalVersionId']),
    );
    repositoryMocks.findBookingByProposalVersionIdForActor
      .mockResolvedValueOnce(null) // inside the losing transaction attempt
      .mockResolvedValueOnce(raced); // the post-conflict re-read

    const result = await createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID });

    expect(result).toEqual({ booking: raced, created: false });
    // The re-read happens outside the aborted transaction, against the
    // module's `prisma` singleton, not the (now-aborted) tx client.
    expect(repositoryMocks.findBookingByProposalVersionIdForActor).toHaveBeenLastCalledWith(
      prisma,
      ADMIN_MANAGER_ACTOR,
      PROPOSAL_VERSION_ID,
    );
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('maps a serialization conflict that survives every retry to BOOKING_CONFLICT, never a raw Prisma error', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2034');
    });

    await expect(
      createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID }),
    ).rejects.toMatchObject({ code: 'BOOKING_CONFLICT', status: 409 });
  });

  it('rethrows an unrelated, unexpected error unchanged rather than mapping it to BOOKING_CONFLICT', async () => {
    const unexpected = new Error('unexpected internal failure');
    transactionMock.mockImplementation(async () => {
      throw unexpected;
    });

    await expect(
      createBooking(ADMIN_MANAGER, { proposalVersionId: PROPOSAL_VERSION_ID }),
    ).rejects.toBe(unexpected);
  });
});

describe('getBookingById', () => {
  it('returns the Booking when the actor-scoped repository query finds one', async () => {
    const found = bookingRecord();
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(found);

    const result = await getBookingById(ADMIN_MANAGER, found.id);

    expect(result).toEqual(found);
    expect(repositoryMocks.findBookingByIdForActor).toHaveBeenCalledWith(
      prisma,
      ADMIN_MANAGER_ACTOR,
      found.id,
    );
  });

  it('throws BOOKING_NOT_FOUND (404) for ADMIN_MANAGER when the Booking genuinely does not exist', async () => {
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(null);

    await expect(getBookingById(ADMIN_MANAGER, 'missing-id')).rejects.toMatchObject({
      code: 'BOOKING_NOT_FOUND',
      status: 404,
    });
  });

  it('throws BOOKING_FORBIDDEN (403), not 404, for TRAVEL_CONSULTANT — no resource-existence leak', async () => {
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(null);

    await expect(getBookingById(TRAVEL_CONSULTANT, 'some-id')).rejects.toMatchObject({
      code: 'BOOKING_FORBIDDEN',
      status: 403,
    });
  });
});

describe('listBookings', () => {
  it('applies page/pageSize pagination and returns the actor-scoped page', async () => {
    const items = [bookingRecord()];
    repositoryMocks.listBookingsForActor.mockResolvedValue({ items, total: 1 });

    const result = await listBookings(ADMIN_MANAGER, { page: 2, pageSize: 10 });

    expect(result).toEqual({ items, page: 2, pageSize: 10, total: 1 });
    expect(repositoryMocks.listBookingsForActor).toHaveBeenCalledWith(prisma, ADMIN_MANAGER_ACTOR, {
      skip: 10,
      take: 10,
    });
  });
});

describe('updateBookingStatus', () => {
  it('transitions status for ADMIN_MANAGER, writing the update, history, and one audit entry atomically', async () => {
    const found = bookingRecord({ status: 'DRAFT' });
    const updated = bookingRecord({ status: 'PENDING_CONFIRMATION' });
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(found);
    repositoryMocks.updateBookingStatusWithHistory.mockResolvedValue(updated);

    const result = await updateBookingStatus(ADMIN_MANAGER, found.id, {
      expectedStatus: 'DRAFT',
      newStatus: 'PENDING_CONFIRMATION',
    });

    expect(result).toEqual(updated);
    expect(repositoryMocks.findBookingByIdForActor).toHaveBeenCalledWith(
      TX_CLIENT,
      ADMIN_MANAGER_ACTOR,
      found.id,
    );
    expect(repositoryMocks.updateBookingStatusWithHistory).toHaveBeenCalledWith(TX_CLIENT, {
      id: found.id,
      previousStatus: 'DRAFT',
      newStatus: 'PENDING_CONFIRMATION',
      changedByUserId: ADMIN_MANAGER.id,
    });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(TX_CLIENT, {
      actorId: ADMIN_MANAGER.id,
      action: 'BOOKING_STATUS_CHANGED',
      entityType: 'Booking',
      entityId: found.id,
      beforeState: { status: 'DRAFT' },
      afterState: { status: 'PENDING_CONFIRMATION' },
    });
    // The lookup, the write, and the audit entry all happened inside the
    // single $transaction callback — never as separate top-level
    // transactions.
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('transitions status for an assigned TRAVEL_CONSULTANT', async () => {
    const found = bookingRecord({ status: 'CONFIRMED' });
    const updated = bookingRecord({ status: 'IN_PREPARATION' });
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(found);
    repositoryMocks.updateBookingStatusWithHistory.mockResolvedValue(updated);

    const result = await updateBookingStatus(TRAVEL_CONSULTANT, found.id, {
      expectedStatus: 'CONFIRMED',
      newStatus: 'IN_PREPARATION',
    });

    expect(result).toEqual(updated);
    expect(repositoryMocks.findBookingByIdForActor).toHaveBeenCalledWith(
      TX_CLIENT,
      TRAVEL_CONSULTANT_ACTOR,
      found.id,
    );
    expect(repositoryMocks.updateBookingStatusWithHistory).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ changedByUserId: TRAVEL_CONSULTANT.id }),
    );
  });

  it('throws BOOKING_NOT_FOUND (404) for ADMIN_MANAGER when the booking genuinely does not exist, without writing', async () => {
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(null);

    await expect(
      updateBookingStatus(ADMIN_MANAGER, 'missing-id', {
        expectedStatus: 'DRAFT',
        newStatus: 'PENDING_CONFIRMATION',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', status: 404 });
    expect(repositoryMocks.updateBookingStatusWithHistory).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('throws BOOKING_FORBIDDEN (403), not 404, for TRAVEL_CONSULTANT when the booking is missing or inaccessible — no resource-existence leak', async () => {
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(null);

    await expect(
      updateBookingStatus(TRAVEL_CONSULTANT, 'some-id', {
        expectedStatus: 'DRAFT',
        newStatus: 'PENDING_CONFIRMATION',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_FORBIDDEN', status: 403 });
    expect(repositoryMocks.updateBookingStatusWithHistory).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('is idempotent: requesting the current status again returns the Booking unchanged, with no history row and no audit entry', async () => {
    const found = bookingRecord({ status: 'CONFIRMED' });
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(found);

    const result = await updateBookingStatus(ADMIN_MANAGER, found.id, {
      expectedStatus: 'CONFIRMED',
      newStatus: 'CONFIRMED',
    });

    expect(result).toEqual(found);
    expect(repositoryMocks.updateBookingStatusWithHistory).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('treats a same-status request as an idempotent no-op even when expectedStatus is stale (checked before the conflict check)', async () => {
    const found = bookingRecord({ status: 'CONFIRMED' });
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(found);

    const result = await updateBookingStatus(ADMIN_MANAGER, found.id, {
      expectedStatus: 'DRAFT', // stale — actual current status is CONFIRMED
      newStatus: 'CONFIRMED', // but this already matches the actual current status
    });

    expect(result).toEqual(found);
    expect(repositoryMocks.updateBookingStatusWithHistory).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('throws BOOKING_CONFLICT (409) with no writes when expectedStatus no longer matches the actual current status', async () => {
    const found = bookingRecord({ status: 'CONFIRMED' });
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(found);

    await expect(
      updateBookingStatus(ADMIN_MANAGER, found.id, {
        expectedStatus: 'DRAFT',
        newStatus: 'IN_PREPARATION',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_CONFLICT', status: 409 });
    expect(repositoryMocks.updateBookingStatusWithHistory).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('throws INVALID_STATUS_TRANSITION (409) with no writes for a transition the matrix disallows', async () => {
    const found = bookingRecord({ status: 'DRAFT' });
    repositoryMocks.findBookingByIdForActor.mockResolvedValue(found);

    await expect(
      updateBookingStatus(ADMIN_MANAGER, found.id, {
        expectedStatus: 'DRAFT',
        newStatus: 'COMPLETED',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION', status: 409 });
    expect(repositoryMocks.updateBookingStatusWithHistory).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'CANCELLED'] as const)(
    'rejects every outgoing transition from the terminal status %s',
    async (terminalStatus) => {
      const found = bookingRecord({ status: terminalStatus });
      repositoryMocks.findBookingByIdForActor.mockResolvedValue(found);

      await expect(
        updateBookingStatus(ADMIN_MANAGER, found.id, {
          expectedStatus: terminalStatus,
          newStatus: 'DRAFT',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION', status: 409 });
      expect(repositoryMocks.updateBookingStatusWithHistory).not.toHaveBeenCalled();
    },
  );

  it('maps a serialization conflict that survives every retry to BOOKING_CONFLICT, never a raw Prisma error', async () => {
    transactionMock.mockImplementation(async () => {
      throw conflictError('P2034');
    });

    await expect(
      updateBookingStatus(ADMIN_MANAGER, 'booking-1', {
        expectedStatus: 'DRAFT',
        newStatus: 'PENDING_CONFIRMATION',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_CONFLICT', status: 409 });
  });

  it('rethrows an unrelated, unexpected error unchanged rather than mapping it to BOOKING_CONFLICT', async () => {
    const unexpected = new Error('unexpected internal failure');
    transactionMock.mockImplementation(async () => {
      throw unexpected;
    });

    await expect(
      updateBookingStatus(ADMIN_MANAGER, 'booking-1', {
        expectedStatus: 'DRAFT',
        newStatus: 'PENDING_CONFIRMATION',
      }),
    ).rejects.toBe(unexpected);
  });
});

// Defense-in-depth: `withRole(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'], ...)`
// already rejects every other role at the route layer (see
// app/api/bookings/route.test.ts and .../[id]/route.test.ts) — these tests
// prove the *service* layer independently rejects the same roles too, so a
// direct call bypassing the route (a future internal caller, a
// misconfigured route, a test) can never reach `repository.ts` with an
// unsupported role.
const REJECTED_ROLES = [
  'CLIENT',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'SYSTEM_ADMINISTRATOR',
] as const;

function actorWithRole(role: (typeof REJECTED_ROLES)[number]): AuthenticatedUser {
  return { id: 'someone-1', email: 'someone@example.test', name: 'Someone', role };
}

describe('service-boundary role rejection (defense-in-depth beyond withRole)', () => {
  it.each(REJECTED_ROLES)(
    'createBooking rejects %s with a controlled 403, never opening a transaction',
    async (role) => {
      await expect(
        createBooking(actorWithRole(role), { proposalVersionId: PROPOSAL_VERSION_ID }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );

  it.each(REJECTED_ROLES)(
    'getBookingById rejects %s with a controlled 403, never querying the repository',
    async (role) => {
      await expect(getBookingById(actorWithRole(role), 'some-id')).rejects.toMatchObject({
        code: 'ROLE_NOT_PERMITTED',
        status: 403,
      });
      expect(repositoryMocks.findBookingByIdForActor).not.toHaveBeenCalled();
    },
  );

  it.each(REJECTED_ROLES)(
    'listBookings rejects %s with a controlled 403, never querying the repository',
    async (role) => {
      await expect(
        listBookings(actorWithRole(role), { page: 1, pageSize: 20 }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
      expect(repositoryMocks.listBookingsForActor).not.toHaveBeenCalled();
    },
  );

  it.each(REJECTED_ROLES)(
    'updateBookingStatus rejects %s with a controlled 403, never opening a transaction',
    async (role) => {
      await expect(
        updateBookingStatus(actorWithRole(role), 'some-id', {
          expectedStatus: 'DRAFT',
          newStatus: 'PENDING_CONFIRMATION',
        }),
      ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
      expect(transactionMock).not.toHaveBeenCalled();
    },
  );
});
