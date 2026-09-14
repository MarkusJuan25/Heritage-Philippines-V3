import { beforeEach, describe, expect, it, vi } from 'vitest';

// `getClientOverview` composes the six owning-feature CLIENT-safe read
// contracts. Every one of those feature services is mocked here so this
// suite proves the composition wiring in isolation: the role gate, the
// no-profile outcome, that Contract A is resolved from the actor alone,
// that Contracts B-F each receive the server-resolved owned `clientId`, and
// that the assembled DTO is identifier-free. The pure `deriveTravelStatus`
// algorithm and the copy helpers are left real (unit-tested exhaustively in
// travel-status.test.ts).

const clientsServiceMock = vi.hoisted(() => ({ getOwnClientForUser: vi.fn() }));
vi.mock('@/features/clients/service', () => clientsServiceMock);

const proposalsServiceMock = vi.hoisted(() => ({
  getClientProposalFacts: vi.fn(),
  getClientProposalPreview: vi.fn(),
}));
vi.mock('@/features/proposals/service', () => proposalsServiceMock);

const bookingsServiceMock = vi.hoisted(() => ({
  getClientBookingFacts: vi.fn(),
  getClientBookingPreview: vi.fn(),
  NON_DRAFT_BOOKING_STATUSES: [
    'PENDING_CONFIRMATION',
    'CONFIRMED',
    'IN_PREPARATION',
    'DOCUMENTS_REQUIRED',
    'VISA_PROCESSING',
    'READY_FOR_TRAVEL',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED',
  ] as const,
}));
vi.mock('@/features/bookings/service', () => bookingsServiceMock);

const assignmentsServiceMock = vi.hoisted(() => ({ getActiveConsultantNameForClient: vi.fn() }));
vi.mock('@/features/assignments/service', () => assignmentsServiceMock);

import type { AuthenticatedUser } from '@/lib/auth/guards';
import { BookingError } from '@/features/bookings/errors';
import { ProposalError } from '@/features/proposals/errors';

import { ClientPortalError } from './errors';
import { getClientJourneyProgress, getClientOverview } from './service';

const CLIENT: AuthenticatedUser = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client One',
  role: 'CLIENT',
};
const STAFF: AuthenticatedUser = {
  id: 'user-admin-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: 'ADMIN_MANAGER',
};

const OWNED = {
  clientId: 'client-row-1',
  fullName: 'Juan Dela Cruz',
  email: 'juan@example.com',
  phone: '+63 900 000 0000',
};

const EMPTY_BY_STATUS = {
  PENDING_CONFIRMATION: 0,
  CONFIRMED: 0,
  IN_PREPARATION: 0,
  DOCUMENTS_REQUIRED: 0,
  VISA_PROCESSING: 0,
  READY_FOR_TRAVEL: 0,
  IN_PROGRESS: 0,
  COMPLETED: 0,
  CANCELLED: 0,
};

function primeHappyPath() {
  clientsServiceMock.getOwnClientForUser.mockResolvedValue(OWNED);
  proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
    currentVisibleTotal: 1,
    awaitingResponse: 1,
    accepted: 0,
    acceptedWithoutClientVisibleBooking: 0,
    respondedNonAccept: 0,
  });
  proposalsServiceMock.getClientProposalPreview.mockResolvedValue({
    items: [{ versionNumber: 1, statusLabel: 'Awaiting your response' }],
  });
  bookingsServiceMock.getClientBookingFacts.mockResolvedValue({
    byStatus: { ...EMPTY_BY_STATUS, CONFIRMED: 2 },
  });
  bookingsServiceMock.getClientBookingPreview.mockResolvedValue({
    items: [
      {
        bookingReference: 'HPB-1111111111111111AAAA',
        statusLabel: 'Confirmed',
        travelStartDate: null,
        travelEndDate: null,
        destination: 'Palawan',
        tourPackageName: 'Island Hopping',
      },
    ],
  });
  assignmentsServiceMock.getActiveConsultantNameForClient.mockResolvedValue({
    name: 'Maria Santos',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getClientOverview — authorization outcomes', () => {
  it('rejects a non-CLIENT actor with FORBIDDEN before any feature read', async () => {
    await expect(getClientOverview(STAFF)).rejects.toMatchObject({
      name: 'ClientPortalError',
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(clientsServiceMock.getOwnClientForUser).not.toHaveBeenCalled();
    expect(proposalsServiceMock.getClientProposalFacts).not.toHaveBeenCalled();
    expect(bookingsServiceMock.getClientBookingFacts).not.toHaveBeenCalled();
    expect(assignmentsServiceMock.getActiveConsultantNameForClient).not.toHaveBeenCalled();
  });

  it('rejects a CLIENT with no ClientProfile with PROFILE_NOT_SET_UP, and never runs Contracts B-F', async () => {
    clientsServiceMock.getOwnClientForUser.mockResolvedValue(null);

    await expect(getClientOverview(CLIENT)).rejects.toMatchObject({
      name: 'ClientPortalError',
      code: 'PROFILE_NOT_SET_UP',
    });
    await expect(getClientOverview(CLIENT)).rejects.toBeInstanceOf(ClientPortalError);

    expect(proposalsServiceMock.getClientProposalFacts).not.toHaveBeenCalled();
    expect(proposalsServiceMock.getClientProposalPreview).not.toHaveBeenCalled();
    expect(bookingsServiceMock.getClientBookingFacts).not.toHaveBeenCalled();
    expect(bookingsServiceMock.getClientBookingPreview).not.toHaveBeenCalled();
    expect(assignmentsServiceMock.getActiveConsultantNameForClient).not.toHaveBeenCalled();
  });
});

describe('getClientOverview — Contract A and Contracts B-F wiring', () => {
  it('resolves Contract A from the actor alone (no clientId argument)', async () => {
    primeHappyPath();
    await getClientOverview(CLIENT);

    expect(clientsServiceMock.getOwnClientForUser).toHaveBeenCalledTimes(1);
    expect(clientsServiceMock.getOwnClientForUser).toHaveBeenCalledWith(CLIENT);
    expect(clientsServiceMock.getOwnClientForUser.mock.calls[0]).toHaveLength(1);
  });

  it('passes the server-resolved owned clientId (never a caller value) to each of Contracts B-F', async () => {
    primeHappyPath();
    await getClientOverview(CLIENT);

    for (const mock of [
      proposalsServiceMock.getClientProposalFacts,
      proposalsServiceMock.getClientProposalPreview,
      bookingsServiceMock.getClientBookingFacts,
      bookingsServiceMock.getClientBookingPreview,
      assignmentsServiceMock.getActiveConsultantNameForClient,
    ]) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(CLIENT, OWNED.clientId);
    }
  });
});

describe('getClientOverview — assembled DTO', () => {
  it('composes identity, proposal facts, booking facts + total, travel-status lines, and consultant', async () => {
    primeHappyPath();
    const overview = await getClientOverview(CLIENT);

    expect(overview.identity).toEqual({
      fullName: OWNED.fullName,
      email: OWNED.email,
      phone: OWNED.phone,
    });
    expect(overview.proposals).toEqual({
      currentVisibleTotal: 1,
      preview: [{ versionNumber: 1, statusLabel: 'Awaiting your response' }],
    });
    expect(overview.bookings.total).toBe(2);
    expect(overview.bookings.byStatus.CONFIRMED).toBe(2);
    expect(overview.bookings.preview[0]?.bookingReference).toBe('HPB-1111111111111111AAAA');
    // awaitingResponse 1, no active booking -> proposalLine PROPOSALS_AWAITING_YOU,
    // progressLine BOOKING_CONFIRMED (CONFIRMED active peak).
    expect(overview.travelStatus.proposalLine).toEqual({
      state: 'PROPOSALS_AWAITING_YOU',
      sentence: 'You have 1 proposal waiting for your response.',
    });
    expect(overview.travelStatus.progressLine).toEqual({
      state: 'BOOKING_CONFIRMED',
      sentence: 'At least one booking is confirmed.',
    });
    expect(overview.consultant).toEqual({ name: 'Maria Santos' });
  });

  it('omits proposalLine when there is nothing awaiting and no non-accept response', async () => {
    primeHappyPath();
    proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
      currentVisibleTotal: 1,
      awaitingResponse: 0,
      accepted: 1,
      acceptedWithoutClientVisibleBooking: 0,
      respondedNonAccept: 0,
    });
    const overview = await getClientOverview(CLIENT);
    expect(overview.travelStatus.proposalLine).toBeNull();
  });

  it('maps a missing active assignment to a null consultant', async () => {
    primeHappyPath();
    assignmentsServiceMock.getActiveConsultantNameForClient.mockResolvedValue(null);
    const overview = await getClientOverview(CLIENT);
    expect(overview.consultant).toBeNull();
  });

  it('produces a DTO free of every server-only identifier the underlying reads know', async () => {
    // Prime the mocks with fixtures that deliberately carry internal ids —
    // the composition must not surface any of them.
    clientsServiceMock.getOwnClientForUser.mockResolvedValue(OWNED);
    proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
      currentVisibleTotal: 0,
      awaitingResponse: 0,
      accepted: 0,
      acceptedWithoutClientVisibleBooking: 0,
      respondedNonAccept: 0,
    });
    proposalsServiceMock.getClientProposalPreview.mockResolvedValue({ items: [] });
    bookingsServiceMock.getClientBookingFacts.mockResolvedValue({
      byStatus: { ...EMPTY_BY_STATUS },
    });
    bookingsServiceMock.getClientBookingPreview.mockResolvedValue({ items: [] });
    assignmentsServiceMock.getActiveConsultantNameForClient.mockResolvedValue(null);

    const overview = await getClientOverview(CLIENT);
    const serialized = JSON.stringify(overview);

    for (const secret of [
      OWNED.clientId,
      CLIENT.id,
      'client-profile-row-1',
      'proposal-row-1',
      'proposal-version-row-1',
      'booking-row-1',
      'portal-invitation-row-1',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(overview.travelStatus.progressLine.state).toBe('AWAITING_FIRST_PROPOSAL');
  });
});

// `getClientJourneyProgress` (D-050 §§2-4, 7) reuses only Contracts B/D and
// the pure `deriveTravelStatus` — mocked identically to the suite above, plus
// the real `ProposalError`/`BookingError` classes (not mocked) so a reused
// contract's own ownership rejection can be constructed and asserted as
// propagating unconverted, per D-050 §2/§7's "no read relies on another
// read's already-performed check" discipline.
describe('getClientJourneyProgress — authorization outcomes', () => {
  it('rejects a non-CLIENT actor with ClientPortalError FORBIDDEN before either reused contract is called', async () => {
    await expect(getClientJourneyProgress(STAFF, OWNED.clientId)).rejects.toMatchObject({
      name: 'ClientPortalError',
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(proposalsServiceMock.getClientProposalFacts).not.toHaveBeenCalled();
    expect(bookingsServiceMock.getClientBookingFacts).not.toHaveBeenCalled();
  });

  it("propagates the proposal contract's own CLIENT_FORBIDDEN unconverted, never as a ClientPortalError or BookingError", async () => {
    proposalsServiceMock.getClientProposalFacts.mockRejectedValue(
      new ProposalError('CLIENT_FORBIDDEN', 'You do not have access to this client.'),
    );
    bookingsServiceMock.getClientBookingFacts.mockResolvedValue({
      byStatus: { ...EMPTY_BY_STATUS },
    });

    await expect(getClientJourneyProgress(CLIENT, 'client-not-owned')).rejects.toBeInstanceOf(
      ProposalError,
    );
    await expect(getClientJourneyProgress(CLIENT, 'client-not-owned')).rejects.toMatchObject({
      name: 'ProposalError',
      code: 'CLIENT_FORBIDDEN',
    });
  });

  it("propagates the booking contract's own BOOKING_FORBIDDEN unconverted, never as a ClientPortalError or ProposalError", async () => {
    proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
      currentVisibleTotal: 0,
      awaitingResponse: 0,
      accepted: 0,
      acceptedWithoutClientVisibleBooking: 0,
      respondedNonAccept: 0,
    });
    bookingsServiceMock.getClientBookingFacts.mockRejectedValue(
      new BookingError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.'),
    );

    await expect(getClientJourneyProgress(CLIENT, 'client-not-owned')).rejects.toBeInstanceOf(
      BookingError,
    );
    await expect(getClientJourneyProgress(CLIENT, 'client-not-owned')).rejects.toMatchObject({
      name: 'BookingError',
      code: 'BOOKING_FORBIDDEN',
    });
  });

  it('calls both reused contracts with the caller-supplied clientId on the success path, never short-circuiting either', async () => {
    proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
      currentVisibleTotal: 1,
      awaitingResponse: 1,
      accepted: 0,
      acceptedWithoutClientVisibleBooking: 0,
      respondedNonAccept: 0,
    });
    bookingsServiceMock.getClientBookingFacts.mockResolvedValue({
      byStatus: { ...EMPTY_BY_STATUS, CONFIRMED: 1 },
    });

    await getClientJourneyProgress(CLIENT, OWNED.clientId);

    expect(proposalsServiceMock.getClientProposalFacts).toHaveBeenCalledTimes(1);
    expect(proposalsServiceMock.getClientProposalFacts).toHaveBeenCalledWith(
      CLIENT,
      OWNED.clientId,
    );
    expect(bookingsServiceMock.getClientBookingFacts).toHaveBeenCalledTimes(1);
    expect(bookingsServiceMock.getClientBookingFacts).toHaveBeenCalledWith(CLIENT, OWNED.clientId);
    // Neither of getClientOverview's other four reads is this composite's
    // concern (D-050 §3) — confirm none of them is called by this function.
    expect(proposalsServiceMock.getClientProposalPreview).not.toHaveBeenCalled();
    expect(bookingsServiceMock.getClientBookingPreview).not.toHaveBeenCalled();
    expect(clientsServiceMock.getOwnClientForUser).not.toHaveBeenCalled();
    expect(assignmentsServiceMock.getActiveConsultantNameForClient).not.toHaveBeenCalled();
  });
});

describe('getClientJourneyProgress — composed DTO', () => {
  it('composes proposalLine and progressLine identically to the shared deriveTravelStatus derivation', async () => {
    proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
      currentVisibleTotal: 1,
      awaitingResponse: 1,
      accepted: 0,
      acceptedWithoutClientVisibleBooking: 0,
      respondedNonAccept: 0,
    });
    bookingsServiceMock.getClientBookingFacts.mockResolvedValue({
      byStatus: { ...EMPTY_BY_STATUS, CONFIRMED: 2 },
    });

    const progress = await getClientJourneyProgress(CLIENT, OWNED.clientId);

    expect(progress).toEqual({
      proposalLine: {
        state: 'PROPOSALS_AWAITING_YOU',
        sentence: 'You have 1 proposal waiting for your response.',
      },
      progressLine: {
        state: 'BOOKING_CONFIRMED',
        sentence: 'At least one booking is confirmed.',
      },
    });
  });

  it('omits proposalLine when there is nothing awaiting and no non-accept response', async () => {
    proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
      currentVisibleTotal: 1,
      awaitingResponse: 0,
      accepted: 1,
      acceptedWithoutClientVisibleBooking: 0,
      respondedNonAccept: 0,
    });
    bookingsServiceMock.getClientBookingFacts.mockResolvedValue({
      byStatus: { ...EMPTY_BY_STATUS },
    });

    const progress = await getClientJourneyProgress(CLIENT, OWNED.clientId);
    expect(progress.proposalLine).toBeNull();
  });

  it('falls through to AWAITING_FIRST_PROPOSAL with no proposal or booking activity of any kind', async () => {
    proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
      currentVisibleTotal: 0,
      awaitingResponse: 0,
      accepted: 0,
      acceptedWithoutClientVisibleBooking: 0,
      respondedNonAccept: 0,
    });
    bookingsServiceMock.getClientBookingFacts.mockResolvedValue({
      byStatus: { ...EMPTY_BY_STATUS },
    });

    const progress = await getClientJourneyProgress(CLIENT, OWNED.clientId);
    expect(progress.progressLine).toEqual({
      state: 'AWAITING_FIRST_PROPOSAL',
      sentence: "We're preparing your first proposal.",
    });
  });

  it('returns exactly the two-field allow-list, with no BookingStatusHistory-shaped or database-identifier key anywhere', async () => {
    proposalsServiceMock.getClientProposalFacts.mockResolvedValue({
      currentVisibleTotal: 0,
      awaitingResponse: 0,
      accepted: 0,
      acceptedWithoutClientVisibleBooking: 0,
      respondedNonAccept: 0,
    });
    bookingsServiceMock.getClientBookingFacts.mockResolvedValue({
      byStatus: { ...EMPTY_BY_STATUS },
    });

    const progress = await getClientJourneyProgress(CLIENT, OWNED.clientId);

    expect(Object.keys(progress).sort()).toEqual(['progressLine', 'proposalLine']);
    expect(Object.keys(progress.progressLine).sort()).toEqual(['sentence', 'state']);

    const serialized = JSON.stringify(progress);
    for (const forbiddenKey of [
      'previousStatus',
      'newStatus',
      'changedByUserId',
      'bookingId',
      'clientId',
      'proposalVersionId',
      'proposalId',
      'internalNotes',
      'totalAmount',
      'currencyCode',
    ]) {
      expect(serialized).not.toContain(forbiddenKey);
    }
  });
});
