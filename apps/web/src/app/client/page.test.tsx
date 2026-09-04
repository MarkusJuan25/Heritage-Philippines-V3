// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getClientOverviewMock } = vi.hoisted(() => ({ getClientOverviewMock: vi.fn() }));
vi.mock('@/features/client-portal/service', () => ({ getClientOverview: getClientOverviewMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import ClientOverviewPage from './page';

const CLIENT_USER = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client One',
  role: 'CLIENT',
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

const POPULATED_OVERVIEW = {
  identity: { fullName: 'Juan Dela Cruz', email: 'juan@example.com', phone: '+63 900 111 2222' },
  proposals: {
    currentVisibleTotal: 2,
    preview: [
      { versionNumber: 3, statusLabel: 'Accepted' },
      { versionNumber: 1, statusLabel: 'Awaiting your response' },
    ],
  },
  bookings: {
    total: 1,
    byStatus: { ...EMPTY_BY_STATUS, CONFIRMED: 1 },
    preview: [
      {
        bookingReference: 'HPB-9999TESTREF9999TEST',
        statusLabel: 'Confirmed',
        travelStartDate: new Date('2026-11-02T00:00:00.000Z'),
        travelEndDate: new Date('2026-11-10T00:00:00.000Z'),
        destination: 'Palawan',
        tourPackageName: 'Island Hopping',
      },
    ],
  },
  travelStatus: {
    proposalLine: {
      state: 'PROPOSALS_AWAITING_YOU',
      sentence: 'You have 1 proposal waiting for your response.',
    },
    progressLine: { state: 'BOOKING_CONFIRMED', sentence: 'At least one booking is confirmed.' },
  },
  consultant: { name: 'Maria Santos' },
};

const EMPTY_OVERVIEW = {
  identity: { fullName: 'Solo Client', email: null, phone: null },
  proposals: { currentVisibleTotal: 0, preview: [] },
  bookings: { total: 0, byStatus: { ...EMPTY_BY_STATUS }, preview: [] },
  travelStatus: {
    proposalLine: null,
    progressLine: {
      state: 'AWAITING_FIRST_PROPOSAL',
      sentence: "We're preparing your first proposal.",
    },
  },
  consultant: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClientOverviewPage (D-040 §2 Layer 3)', () => {
  it('takes no props — no dynamic segment, no searchParams, no caller-controlled object', () => {
    expect(ClientOverviewPage.length).toBe(0);
  });

  it('redirects to /login when there is no session, without composing the overview', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(ClientOverviewPage()).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(getClientOverviewMock).not.toHaveBeenCalled();
  });

  it('resolves client identity ONLY through the authenticated actor: getClientOverview is called with exactly the session user', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getClientOverviewMock.mockResolvedValue(EMPTY_OVERVIEW);

    await ClientOverviewPage();

    expect(getClientOverviewMock).toHaveBeenCalledTimes(1);
    expect(getClientOverviewMock).toHaveBeenCalledWith(CLIENT_USER);
    expect(getClientOverviewMock.mock.calls[0]).toHaveLength(1);
  });

  it('renders the composed overview: heading, identity, four sections, travel-status lines and consultant', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getClientOverviewMock.mockResolvedValue(POPULATED_OVERVIEW);

    const jsx = await ClientOverviewPage();
    const { container } = render(jsx);

    expect(screen.getByRole('heading', { level: 1, name: 'Home / Overview' })).toBeInTheDocument();
    expect(container.querySelector('main')).toBeNull(); // the one <main> is the layout's

    // Identity
    expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('juan@example.com')).toBeInTheDocument();
    expect(screen.getByText('+63 900 111 2222')).toBeInTheDocument();

    // Section headings
    expect(screen.getByRole('heading', { level: 2, name: 'Proposals (2)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Bookings (1)' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Your travel status' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Your travel consultant' }),
    ).toBeInTheDocument();

    // Previews + travel status + consultant
    expect(screen.getByText('HPB-9999TESTREF9999TEST')).toBeInTheDocument();
    expect(screen.getByText('You have 1 proposal waiting for your response.')).toBeInTheDocument();
    expect(screen.getByText('At least one booking is confirmed.')).toBeInTheDocument();
    expect(screen.getByText('Maria Santos')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Support & Messages is planned for a later phase. Until then, Maria Santos, your Heritage Philippines travel consultant, is your point of contact.',
      ),
    ).toBeInTheDocument();
  });

  it('renders every empty/null state: both section empty copies, the fall-through progress line, and the travel-team fallback', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getClientOverviewMock.mockResolvedValue(EMPTY_OVERVIEW);

    const jsx = await ClientOverviewPage();
    render(jsx);

    expect(
      screen.getByText(
        'No proposals to review yet. Your travel consultant will prepare one for you.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No bookings yet. A booking is created after you accept a proposal.'),
    ).toBeInTheDocument();
    expect(screen.getByText("We're preparing your first proposal.")).toBeInTheDocument();
    expect(screen.getByText('Your Heritage Philippines travel team.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Support & Messages is planned for a later phase. Until then, your Heritage Philippines travel team is your point of contact.',
      ),
    ).toBeInTheDocument();

    // Null identity fields render as an explicit placeholder, never fabricated.
    const values = Array.from(document.querySelectorAll('dd')).map((dd) => dd.textContent);
    expect(values).toEqual(['Solo Client', '—', '—']);
  });

  it('renders only the identifier-minimized DTO: the caller userId and other server-only identifiers never appear; bookingReference does', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getClientOverviewMock.mockResolvedValue(POPULATED_OVERVIEW);

    const jsx = await ClientOverviewPage();
    const { container } = render(jsx);

    const html = container.innerHTML;
    expect(html).toContain('HPB-9999TESTREF9999TEST'); // the one permitted client-facing identifier

    expect(html).not.toContain(CLIENT_USER.id);
    for (const forbidden of [
      'clientId',
      'userId',
      'proposalId',
      'proposalVersionId',
      'bookingId',
      'invitationId',
      'internalNotes',
      'clientVisibleNotes',
      'totalAmount',
      'currencyCode',
      'travelerCount',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
