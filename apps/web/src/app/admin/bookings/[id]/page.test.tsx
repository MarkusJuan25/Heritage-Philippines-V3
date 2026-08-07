// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getBookingByIdMock } = vi.hoisted(() => ({ getBookingByIdMock: vi.fn() }));
vi.mock('@/features/bookings/service', () => ({ getBookingById: getBookingByIdMock }));

// page.tsx (Stage 2D) calls `findActiveAssignmentForBooking` directly —
// mocked here the same way `getBookingById` is above. `@/lib/db` is also
// mocked because page.tsx now imports `prisma` from it directly to pass
// through as that function's first argument; importing the real module
// would eagerly validate env vars and open a real database adapter
// (mirrors features/bookings/service.test.ts's identical discipline).
const { findActiveAssignmentForBookingMock } = vi.hoisted(() => ({
  findActiveAssignmentForBookingMock: vi.fn(),
}));
vi.mock('@/features/assignments/repository', () => ({
  findActiveAssignmentForBooking: findActiveAssignmentForBookingMock,
}));
vi.mock('@/lib/db', () => ({ prisma: { marker: 'prisma-singleton' } }));

const { redirectMock, routerRefreshMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  routerRefreshMock: vi.fn(),
}));
// BookingStatusTransitionPanel (Stage 2C, rendered for every successfully
// resolved Booking) calls useRouter().refresh() on a successful
// submission — this page itself calls neither, but the whole
// `next/navigation` module is replaced here, so every export any rendered
// child component needs must be provided (mirrors
// admin/proposals/[id]/page.test.tsx's identical discipline).
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), refresh: routerRefreshMock }),
}));

// The real BookingError class — not mocked — so this page's own
// `error instanceof BookingError` checks (BOOKING_NOT_FOUND /
// BOOKING_FORBIDDEN) exercise real logic rather than an unrelated mock
// class (mirrors admin/proposals/[id]/page.test.tsx's identical
// discipline).
import { BookingError } from '@/features/bookings/errors';
import type { BookingRecord } from '@/features/bookings/repository';
// The real BookingStatus enum and isTransitionAllowed — not mocked — so
// this page's own server-side filtering (`Object.values(BookingStatus)
// .filter((status) => isTransitionAllowed(...))`) exercises real D-014
// transition-matrix logic rather than an unrelated mock.
import { BookingStatus } from '@/generated/prisma/client';
// The mocked singleton itself, so tests can assert
// findActiveAssignmentForBooking was called with this exact identity as
// its first argument (proving page.tsx passes the shared `prisma` client
// through, not some other value).
import { prisma } from '@/lib/db';

import AdminBookingDetailPage from './page';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};
const TRAVEL_CONSULTANT = {
  id: 'tc-1',
  email: 'tc@example.test',
  name: 'TC',
  role: 'TRAVEL_CONSULTANT',
};

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function bookingDetail(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: BOOKING_ID,
    bookingReference: 'HPB-AAAAAAAAAAAAAAAAAAAA',
    clientId: 'client-1',
    proposalVersionId: 'version-1',
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
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function params(id = BOOKING_ID): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // `vi.resetAllMocks()` in `afterEach` below strips every mock's
  // implementation, including `redirectMock`'s throwing behavior set at
  // creation time — without restoring it here, only the very first test in
  // this file to exercise a redirect would ever see it actually throw
  // (mirrors admin/proposals/[id]/page.test.tsx's identical discipline).
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  // Safe default for every test that doesn't specifically exercise
  // assignment behavior: no active assignment.
  findActiveAssignmentForBookingMock.mockResolvedValue(null);
  // BookingAssignmentPanel (rendered by this page, Stage 2D) fetches the
  // eligible Travel Consultant list on mount for an ADMIN_MANAGER actor —
  // stubbed globally here so every existing test unrelated to that panel's
  // own behavior still renders deterministically, with a safe empty
  // default a test can override (mirrors
  // admin/clients/[id]/page.test.tsx's identical discipline for
  // ClientAssignmentPanel).
  fetchMock = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, { items: [], page: 1, pageSize: 100, total: 0 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('AdminBookingDetailPage', () => {
  it('redirects to /login when there is no session', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminBookingDetailPage({ params: params() })).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(getBookingByIdMock).not.toHaveBeenCalled();
    expect(findActiveAssignmentForBookingMock).not.toHaveBeenCalled();
  });

  it('renders the detail for an authorized ADMIN_MANAGER', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(bookingDetail());

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'HPB-AAAAAAAAAAAAAAAAAAAA' })).toBeInTheDocument();
    expect(findActiveAssignmentForBookingMock).toHaveBeenCalledTimes(1);
  });

  it('renders the detail for an authorized TRAVEL_CONSULTANT, calling getBookingById with the exact actor and id', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    getBookingByIdMock.mockResolvedValue(bookingDetail());

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('heading', { name: 'HPB-AAAAAAAAAAAAAAAAAAAA' })).toBeInTheDocument();
    expect(getBookingByIdMock).toHaveBeenCalledWith(TRAVEL_CONSULTANT, BOOKING_ID);
    expect(getBookingByIdMock).toHaveBeenCalledTimes(1);
    expect(findActiveAssignmentForBookingMock).toHaveBeenCalledTimes(1);
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders an in-place permission-denied state for role %s, never calling getBookingById',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByText('Access denied')).toBeInTheDocument();
      expect(getBookingByIdMock).not.toHaveBeenCalled();
      expect(findActiveAssignmentForBookingMock).not.toHaveBeenCalled();
    },
  );

  it('renders a not-found state for a malformed id, without calling getBookingById', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    const jsx = await AdminBookingDetailPage({ params: params('not-a-uuid') });
    render(jsx);

    expect(screen.getByText('Booking not found')).toBeInTheDocument();
    expect(screen.getByText('This booking link is invalid.')).toBeInTheDocument();
    expect(getBookingByIdMock).not.toHaveBeenCalled();
    expect(findActiveAssignmentForBookingMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Assignment')).not.toBeInTheDocument();
  });

  it('renders a not-found state for BOOKING_NOT_FOUND (ADMIN_MANAGER, genuinely missing)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockRejectedValue(
      new BookingError('BOOKING_NOT_FOUND', 'Booking not found.'),
    );

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Booking not found')).toBeInTheDocument();
    expect(
      screen.getByText('This booking was not found or is not accessible to you.'),
    ).toBeInTheDocument();
    expect(findActiveAssignmentForBookingMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Assignment')).not.toBeInTheDocument();
  });

  it('renders the identical not-found state for BOOKING_FORBIDDEN (never distinguishable from missing)', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
    getBookingByIdMock.mockRejectedValue(
      new BookingError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.'),
    );

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('Booking not found')).toBeInTheDocument();
    expect(
      screen.getByText('This booking was not found or is not accessible to you.'),
    ).toBeInTheDocument();
    // Never leaks any Booking-specific content for the forbidden case.
    expect(screen.queryByText('HPB-AAAAAAAAAAAAAAAAAAAA')).not.toBeInTheDocument();
    expect(findActiveAssignmentForBookingMock).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected getBookingById error rather than rendering a not-found or access-denied state, never calling findActiveAssignmentForBooking', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockRejectedValue(new Error('unexpected failure'));

    await expect(AdminBookingDetailPage({ params: params() })).rejects.toThrow(
      'unexpected failure',
    );
    expect(findActiveAssignmentForBookingMock).not.toHaveBeenCalled();
  });

  it('renders the complete authoritative detail for every authorized BookingRecord field', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(
      bookingDetail({
        status: 'IN_PREPARATION',
        tourPackageName: 'Palawan Explorer',
        destination: 'Palawan',
        travelStartDate: new Date('2026-09-15T00:00:00Z'),
        travelEndDate: new Date('2026-09-22T00:00:00Z'),
        travelerCount: 4,
        includedServices: 'Hotel\nBreakfast',
        excludedServices: 'Airfare',
        specialRequests: 'Vegetarian meals',
        internalNotes: 'Staff-only note',
        clientVisibleNotes: 'Welcome pack included',
      }),
    );

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('In Preparation')).toBeInTheDocument();
    expect(screen.getByText('Palawan Explorer')).toBeInTheDocument();
    expect(screen.getByText('Palawan')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Airfare')).toBeInTheDocument();
    expect(screen.getByText('Vegetarian meals')).toBeInTheDocument();
    expect(screen.getByText('Staff-only note')).toBeInTheDocument();
    expect(screen.getByText('Welcome pack included')).toBeInTheDocument();
    expect(screen.getByText('version-1')).toBeInTheDocument();
  });

  it('links the Client identity to /admin/clients/[clientId]', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(bookingDetail({ clientId: 'client-99' }));

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    const clientLink = screen.getByRole('link', { name: 'client-99' });
    expect(clientLink).toHaveAttribute('href', '/admin/clients/client-99');
  });

  it('renders proposalVersionId as non-link reference text only', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(bookingDetail({ proposalVersionId: 'version-77' }));

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByText('version-77')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'version-77' })).not.toBeInTheDocument();
  });

  it('renders the explicit "Not set" placeholder for every nullable field that is null, never a fabricated value', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(bookingDetail());

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    // tourPackageName, destination, travelStartDate, travelEndDate,
    // travelerCount, includedServices, excludedServices, specialRequests,
    // internalNotes, clientVisibleNotes — 10 null fields.
    expect(screen.getAllByText('Not set')).toHaveLength(10);
  });

  it('renders real travel dates with correct <time dateTime> values and en-PH formatting', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    const travelStartDate = new Date('2026-09-15T00:00:00Z');
    const travelEndDate = new Date('2026-09-22T00:00:00Z');
    getBookingByIdMock.mockResolvedValue(bookingDetail({ travelStartDate, travelEndDate }));

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    const startEl = screen.getByText(travelStartDate.toLocaleDateString('en-PH'));
    expect(startEl.tagName).toBe('TIME');
    expect(startEl).toHaveAttribute('dateTime', '2026-09-15');

    const endEl = screen.getByText(travelEndDate.toLocaleDateString('en-PH'));
    expect(endEl.tagName).toBe('TIME');
    expect(endEl).toHaveAttribute('dateTime', '2026-09-22');
  });

  it('renders createdAt and updatedAt as full timestamps with correct <time dateTime> values', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    const createdAt = new Date('2026-08-01T10:30:00Z');
    const updatedAt = new Date('2026-08-02T11:45:00Z');
    getBookingByIdMock.mockResolvedValue(bookingDetail({ createdAt, updatedAt }));

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    const createdEl = screen.getByText(createdAt.toLocaleString('en-PH'));
    expect(createdEl.tagName).toBe('TIME');
    expect(createdEl).toHaveAttribute('dateTime', createdAt.toISOString());

    const updatedEl = screen.getByText(updatedAt.toLocaleString('en-PH'));
    expect(updatedEl.tagName).toBe('TIME');
    expect(updatedEl).toHaveAttribute('dateTime', updatedAt.toISOString());
  });

  it('preserves internal line breaks for multiline free-text fields', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(
      bookingDetail({ includedServices: 'Hotel\nBreakfast\nAirport transfer' }),
    );

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    // getByText's default matcher normalizes whitespace (collapsing
    // newlines), so the raw DOM textContent is asserted directly instead to
    // prove the source value's own line breaks are preserved, not
    // collapsed.
    const dt = screen.getByText('Included services');
    const dd = dt.closest('div')?.querySelector('dd');
    expect(dd?.textContent).toBe('Hotel\nBreakfast\nAirport transfer');
  });

  it('never renders the raw Booking id as a standalone field', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(bookingDetail({ id: 'booking-internal-id-marker' }));

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.queryByText('booking-internal-id-marker')).not.toBeInTheDocument();
  });

  it('never renders or infers totalAmount or currencyCode', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(bookingDetail());

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.queryByText(/total ?amount/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/currency/i)).not.toBeInTheDocument();
  });

  it('renders no edit or status-history control — only the authorized Stage 2C status-transition and Stage 2D assignment controls', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(bookingDetail({ status: 'DRAFT' }));
    findActiveAssignmentForBookingMock.mockResolvedValue(null);

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/history/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create/i })).not.toBeInTheDocument();
    // The Stage 2C status-transition control and the Stage 2D assignment
    // control are this page's only two legitimate interactive sections.
    expect(screen.getByRole('combobox', { name: 'New status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Assignment' })).toBeInTheDocument();
  });

  it('provides a back-navigation link to /admin/bookings', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
    getBookingByIdMock.mockResolvedValue(bookingDetail());

    const jsx = await AdminBookingDetailPage({ params: params() });
    render(jsx);

    expect(screen.getByRole('link', { name: '← Back to Bookings' })).toHaveAttribute(
      'href',
      '/admin/bookings',
    );
  });

  describe('Status-transition panel integration (D-028 §7, Stage 2C)', () => {
    function getOptionTexts(): (string | null)[] {
      const select = screen.getByRole('combobox', { name: 'New status' });
      return Array.from(select.querySelectorAll('option'))
        .map((option) => option.textContent)
        .filter((text) => text !== 'Select a status…');
    }

    it('renders exactly the allowed target statuses (and no others) for a representative mid-lifecycle status', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getBookingByIdMock.mockResolvedValue(bookingDetail({ status: BookingStatus.IN_PREPARATION }));

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(getOptionTexts()).toEqual([
        'Documents Required',
        'Visa Processing',
        'Ready for Travel',
        'Cancelled',
      ]);
    });

    it.each([
      [BookingStatus.DRAFT, ['Pending Confirmation', 'Cancelled']],
      [BookingStatus.PENDING_CONFIRMATION, ['Confirmed', 'Cancelled']],
      [BookingStatus.CONFIRMED, ['In Preparation', 'Cancelled']],
      [BookingStatus.READY_FOR_TRAVEL, ['In Progress', 'Cancelled']],
      [BookingStatus.IN_PROGRESS, ['Completed', 'Cancelled']],
    ])(
      'computes and passes the exact server-filtered allowed target statuses for %s',
      async (status, expectedLabels) => {
        getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
        getBookingByIdMock.mockResolvedValue(bookingDetail({ status }));

        const jsx = await AdminBookingDetailPage({ params: params() });
        render(jsx);

        expect(getOptionTexts()).toEqual(expectedLabels);
      },
    );

    it('presents CANCELLED as an ordinary supplied option whenever it is allowed', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getBookingByIdMock.mockResolvedValue(bookingDetail({ status: BookingStatus.DRAFT }));

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByRole('option', { name: 'Cancelled' })).toBeInTheDocument();
    });

    it('renders the read-only no-transitions message for a terminal status, with no mutation control', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getBookingByIdMock.mockResolvedValue(bookingDetail({ status: BookingStatus.COMPLETED }));

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(
        screen.getByText('No status changes are currently available for this booking.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Update status' })).not.toBeInTheDocument();
    });

    it('renders the panel for an authorized ADMIN_MANAGER', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getBookingByIdMock.mockResolvedValue(bookingDetail({ status: BookingStatus.DRAFT }));

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByRole('heading', { name: 'Status' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'New status' })).toBeInTheDocument();
    });

    it('renders the panel for an authorized TRAVEL_CONSULTANT', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getBookingByIdMock.mockResolvedValue(bookingDetail({ status: BookingStatus.DRAFT }));

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByRole('heading', { name: 'Status' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'New status' })).toBeInTheDocument();
    });

    it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
      'never renders the status-transition panel for excluded role %s',
      async (role) => {
        getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

        const jsx = await AdminBookingDetailPage({ params: params() });
        render(jsx);

        expect(screen.queryByRole('heading', { name: 'Status' })).not.toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      },
    );

    it('never renders the status-transition panel for a malformed id', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

      const jsx = await AdminBookingDetailPage({ params: params('not-a-uuid') });
      render(jsx);

      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('never renders the status-transition panel for a not-found/forbidden Booking', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getBookingByIdMock.mockRejectedValue(
        new BookingError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.'),
      );

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
  });

  describe('Assignment panel integration (D-028 §8, Stage 2D)', () => {
    it('calls findActiveAssignmentForBooking with the resolved booking.id (not the raw route id) and the shared prisma client', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getBookingByIdMock.mockResolvedValue(bookingDetail({ id: 'resolved-record-id' }));
      findActiveAssignmentForBookingMock.mockResolvedValue(null);

      const jsx = await AdminBookingDetailPage({ params: params(BOOKING_ID) });
      render(jsx);

      expect(findActiveAssignmentForBookingMock).toHaveBeenCalledWith(prisma, 'resolved-record-id');
      expect(findActiveAssignmentForBookingMock).toHaveBeenCalledTimes(1);
    });

    it('never starts findActiveAssignmentForBooking before getBookingById has resolved', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      let resolveBooking: (value: BookingRecord) => void = () => {};
      getBookingByIdMock.mockImplementation(
        () =>
          new Promise<BookingRecord>((resolve) => {
            resolveBooking = resolve;
          }),
      );

      const pagePromise = AdminBookingDetailPage({ params: params() });
      // Flush pending microtasks (getCurrentUser's own resolution, the
      // synchronous validation/authorization steps, and the start of the
      // still-pending getBookingById call) without resolving
      // getBookingById itself.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(findActiveAssignmentForBookingMock).not.toHaveBeenCalled();

      resolveBooking(bookingDetail());
      const jsx = await pagePromise;
      render(jsx);

      expect(findActiveAssignmentForBookingMock).toHaveBeenCalledTimes(1);
    });

    it('resolves an active assignment into a { staffId } summary and passes it, with the actor role, into BookingAssignmentPanel', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getBookingByIdMock.mockResolvedValue(bookingDetail());
      findActiveAssignmentForBookingMock.mockResolvedValue({
        id: 'assignment-1',
        assignedStaffId: 'tc-1',
        assignedByUserId: 'admin-1',
        leadId: null,
        clientId: null,
        bookingId: BOOKING_ID,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        endedAt: null,
      });
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          items: [{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      );

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      // ADMIN_MANAGER's own role reached the interactive branch (a
      // Reassign control only renders when a current assignment exists,
      // proving `currentAssignment` reached the panel), resolved to the
      // fetched consultant's display name. "Maria Santos" also appears as
      // a <select> option once the eligible list loads, so the summary
      // line is queried specifically rather than via a bare text match.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Reassign' })).toBeInTheDocument(),
      );
      expect(screen.getByText('Assigned Consultant:').closest('p')?.textContent).toContain(
        'Maria Santos',
      );
    });

    it('resolves no active assignment into a null summary, rendering the explicit Unassigned state', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getBookingByIdMock.mockResolvedValue(bookingDetail());
      findActiveAssignmentForBookingMock.mockResolvedValue(null);
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          items: [{ id: 'tc-1', name: 'Maria Santos', email: 'maria@example.test' }],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      );

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByText('Unassigned')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument(),
      );
    });

    it('passes TRAVEL_CONSULTANT through as a read-only actor, with no eligible-consultant fetch and no mutation controls', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getBookingByIdMock.mockResolvedValue(bookingDetail());
      findActiveAssignmentForBookingMock.mockResolvedValue({
        id: 'assignment-1',
        assignedStaffId: 'tc-1',
        assignedByUserId: 'admin-1',
        leadId: null,
        clientId: null,
        bookingId: BOOKING_ID,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        endedAt: null,
      });

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(screen.getByText('tc-1')).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Assign to' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('propagates an unexpected findActiveAssignmentForBooking failure rather than rendering a not-found or access-denied state', async () => {
      getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);
      getBookingByIdMock.mockResolvedValue(bookingDetail());
      findActiveAssignmentForBookingMock.mockRejectedValue(new Error('assignment lookup failed'));

      await expect(AdminBookingDetailPage({ params: params() })).rejects.toThrow(
        'assignment lookup failed',
      );
    });

    it('never renders the assignment panel for a not-found/forbidden Booking', async () => {
      getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);
      getBookingByIdMock.mockRejectedValue(
        new BookingError('BOOKING_FORBIDDEN', 'Booking not found or not accessible.'),
      );

      const jsx = await AdminBookingDetailPage({ params: params() });
      render(jsx);

      expect(screen.queryByText('Assignment')).not.toBeInTheDocument();
      expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
    });
  });
});
