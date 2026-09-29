// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const serviceMocks = vi.hoisted(() => ({
  getPaymentBookingHeaderForActor: vi.fn(),
  getBookingPaymentSummaryForStaff: vi.fn(),
}));
vi.mock('@/features/payments/service', () => serviceMocks);

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ refresh: vi.fn() }),
}));

// The real PaymentError and Decimal, so the page's own error handling and
// money formatting run for real.
import { Prisma } from '@/generated/prisma/client';
import { PaymentError } from '@/features/payments/errors';

import AdminPaymentDetailPage from './page';

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const PLAN_ID = '11111111-1111-4111-8111-111111111111';
const d = (value: string) => new Prisma.Decimal(value);

const ACTORS = {
  ADMIN_MANAGER: { id: 'admin-1', email: 'a@example.test', name: 'Admin', role: 'ADMIN_MANAGER' },
  TRAVEL_CONSULTANT: { id: 'tc-1', email: 't@example.test', name: 'TC', role: 'TRAVEL_CONSULTANT' },
  FINANCE_ACCOUNTING: {
    id: 'finance-1',
    email: 'f@example.test',
    name: 'Finance',
    role: 'FINANCE_ACCOUNTING',
  },
} as const;

function headerRecord(status = 'CONFIRMED') {
  return {
    id: BOOKING_ID,
    bookingReference: 'HPB-VERIFY',
    status,
    client: { fullName: 'Ana Client' },
  };
}

type SummaryOverrides = Partial<{
  totalAmount: Prisma.Decimal | null;
  currencyCode: string | null;
  activePlan: { id: string; status: 'PROPOSED' | 'APPROVED' } | null;
  payments: {
    id: string;
    amount: Prisma.Decimal;
    status: string;
    receipt: { receiptNumber: string; issuedAt: Date } | null;
  }[];
  withInstallment: boolean;
}>;

function summary(overrides: SummaryOverrides = {}) {
  const totalAmount = overrides.totalAmount === undefined ? d('500.00') : overrides.totalAmount;
  return {
    bookingId: BOOKING_ID,
    totalAmount,
    currencyCode: overrides.currencyCode === undefined ? 'PHP' : overrides.currencyCode,
    planApproved: overrides.activePlan?.status === 'APPROVED',
    activePlan: overrides.activePlan ?? null,
    confirmedAmountPaid: d('0.00'),
    remainingBalance: totalAmount,
    overpayment: totalAmount ? d('0.00') : null,
    unappliedCredit: d('0.00'),
    nextPaymentDue: null,
    installments: overrides.withInstallment
      ? [
          {
            id: 'inst-1',
            dueDate: new Date('2026-10-01T00:00:00Z'),
            amount: d('500.00'),
            outstandingAmount: d('500.00'),
            allocations: [],
          },
        ]
      : [],
    payments: overrides.payments ?? [],
  };
}

function params(bookingId = BOOKING_ID) {
  return Promise.resolve({ bookingId });
}

async function renderAs(role: keyof typeof ACTORS, overrides: SummaryOverrides = {}) {
  getCurrentUserMock.mockResolvedValue(ACTORS[role]);
  serviceMocks.getPaymentBookingHeaderForActor.mockResolvedValue(headerRecord());
  serviceMocks.getBookingPaymentSummaryForStaff.mockResolvedValue(summary(overrides));
  render(await AdminPaymentDetailPage({ params: params() }));
}

beforeEach(() => {
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('AdminPaymentDetailPage — access and not-found', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    await expect(AdminPaymentDetailPage({ params: params() })).rejects.toThrow('REDIRECT:/login');
  });

  it.each(['VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'renders access denied for %s without any read',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ACTORS.ADMIN_MANAGER, role });
      render(await AdminPaymentDetailPage({ params: params() }));

      expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
      expect(serviceMocks.getPaymentBookingHeaderForActor).not.toHaveBeenCalled();
    },
  );

  it('renders not found for a malformed id without any read', async () => {
    getCurrentUserMock.mockResolvedValue(ACTORS.FINANCE_ACCOUNTING);
    render(await AdminPaymentDetailPage({ params: params('not-a-uuid') }));

    expect(screen.getByRole('heading', { name: 'Booking not found' })).toBeInTheDocument();
    expect(serviceMocks.getPaymentBookingHeaderForActor).not.toHaveBeenCalled();
  });

  it.each(['BOOKING_NOT_FOUND', 'BOOKING_FORBIDDEN'] as const)(
    'renders the same not-found state for %s and never reads the summary',
    async (code) => {
      getCurrentUserMock.mockResolvedValue(ACTORS.TRAVEL_CONSULTANT);
      serviceMocks.getPaymentBookingHeaderForActor.mockRejectedValue(
        new PaymentError(code, 'Booking not found or not accessible.'),
      );
      render(await AdminPaymentDetailPage({ params: params() }));

      expect(
        screen.getByText('This booking was not found or is not accessible to you.'),
      ).toBeInTheDocument();
      expect(serviceMocks.getBookingPaymentSummaryForStaff).not.toHaveBeenCalled();
    },
  );

  it('rethrows an unexpected error to the error boundary', async () => {
    getCurrentUserMock.mockResolvedValue(ACTORS.FINANCE_ACCOUNTING);
    serviceMocks.getPaymentBookingHeaderForActor.mockRejectedValue(new Error('database down'));
    await expect(AdminPaymentDetailPage({ params: params() })).rejects.toThrow('database down');
  });

  it('reads the summary for the resolved Booking only after the scoped header read', async () => {
    await renderAs('FINANCE_ACCOUNTING');

    expect(serviceMocks.getPaymentBookingHeaderForActor).toHaveBeenCalledWith(
      ACTORS.FINANCE_ACCOUNTING,
      BOOKING_ID,
    );
    expect(serviceMocks.getBookingPaymentSummaryForStaff).toHaveBeenCalledWith(
      ACTORS.FINANCE_ACCOUNTING,
      BOOKING_ID,
    );
    expect(serviceMocks.getPaymentBookingHeaderForActor.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMocks.getBookingPaymentSummaryForStaff.mock.invocationCallOrder[0]!,
    );
    expect(screen.getByRole('heading', { name: 'HPB-VERIFY' })).toBeInTheDocument();
    expect(screen.getByText('Ana Client')).toBeInTheDocument();
  });
});

describe('AdminPaymentDetailPage — financials', () => {
  it('gives Finance/Accounting the financials form', async () => {
    await renderAs('FINANCE_ACCOUNTING', { totalAmount: null, currencyCode: null });

    expect(screen.getByRole('heading', { name: 'Set the booking total' })).toBeInTheDocument();
    expect(screen.getByLabelText('Booking total')).toBeInTheDocument();
  });

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'] as const)(
    'shows %s the financials read-only, with a note when they are not set',
    async (role) => {
      await renderAs(role, { totalAmount: null, currencyCode: null });

      expect(screen.queryByLabelText('Booking total')).not.toBeInTheDocument();
      expect(screen.getByRole('note')).toHaveTextContent(
        'The booking total and currency are not set yet',
      );
    },
  );

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'] as const)(
    'shows %s the set total read-only',
    async (role) => {
      await renderAs(role);

      expect(
        screen.getByText('Booking total', { selector: 'dt' }).nextElementSibling,
      ).toHaveTextContent('PHP 500.00');
      expect(screen.queryByLabelText('Booking total')).not.toBeInTheDocument();
    },
  );
});

describe('AdminPaymentDetailPage — plan controls by role and state', () => {
  it('lets the Travel Consultant propose when there is no plan and the total is set', async () => {
    await renderAs('TRAVEL_CONSULTANT');

    expect(screen.getByText('No active payment plan.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose plan' })).toBeInTheDocument();
  });

  it('offers no proposal before the total is set', async () => {
    await renderAs('TRAVEL_CONSULTANT', { totalAmount: null, currencyCode: null });

    expect(screen.queryByRole('button', { name: 'Propose plan' })).not.toBeInTheDocument();
  });

  it('lets Finance/Accounting approve or withdraw a PROPOSED plan', async () => {
    await renderAs('FINANCE_ACCOUNTING', {
      activePlan: { id: PLAN_ID, status: 'PROPOSED' },
      withInstallment: true,
    });

    expect(screen.getByText('Proposed — awaiting Finance approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve plan…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw plan…' })).toBeInTheDocument();
  });

  it('lets the Travel Consultant withdraw but never approve a PROPOSED plan', async () => {
    await renderAs('TRAVEL_CONSULTANT', { activePlan: { id: PLAN_ID, status: 'PROPOSED' } });

    expect(screen.getByRole('button', { name: 'Withdraw plan…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve plan…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose plan' })).not.toBeInTheDocument();
  });

  it('offers no plan action on an APPROVED plan (never withdrawn)', async () => {
    await renderAs('FINANCE_ACCOUNTING', {
      activePlan: { id: PLAN_ID, status: 'APPROVED' },
      withInstallment: true,
    });

    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw plan…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve plan…' })).not.toBeInTheDocument();
  });
});

describe('AdminPaymentDetailPage — payments', () => {
  const PENDING = { id: 'pay-1', amount: d('200.00'), status: 'PENDING', receipt: null };
  const CONFIRMED = { id: 'pay-2', amount: d('300.00'), status: 'CONFIRMED', receipt: null };

  it('shows an empty payments state', async () => {
    await renderAs('ADMIN_MANAGER');
    expect(
      screen.getByText('No payments have been recorded for this booking.'),
    ).toBeInTheDocument();
  });

  it('gives Finance/Accounting recording, confirming, reversing, refunding, receipts, and allocation', async () => {
    await renderAs('FINANCE_ACCOUNTING', {
      activePlan: { id: PLAN_ID, status: 'APPROVED' },
      withInstallment: true,
      payments: [PENDING, CONFIRMED],
    });

    expect(screen.getByRole('heading', { name: 'Record a payment received' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Confirm payment…' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Issue receipt…' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Reverse payment…' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Refund this payment' })).toHaveLength(1);
    expect(
      screen.getByRole('heading', { name: 'Allocate a payment to an installment' }),
    ).toBeInTheDocument();
  });

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'] as const)(
    'shows %s the payment history with no payment control',
    async (role) => {
      await renderAs(role, {
        activePlan: { id: PLAN_ID, status: 'APPROVED' },
        withInstallment: true,
        payments: [
          PENDING,
          { ...CONFIRMED, receipt: { receiptNumber: 'RCPT-1', issuedAt: new Date() } },
        ],
      });

      expect(screen.getByText('Pending')).toBeInTheDocument();
      expect(screen.getByText('RCPT-1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /payment…|receipt…/ })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Record a payment received' }),
      ).not.toBeInTheDocument();
    },
  );

  it('offers no allocation form until the plan is approved', async () => {
    await renderAs('FINANCE_ACCOUNTING', {
      activePlan: { id: PLAN_ID, status: 'PROPOSED' },
      withInstallment: true,
      payments: [CONFIRMED],
    });

    expect(
      screen.queryByRole('heading', { name: 'Allocate a payment to an installment' }),
    ).not.toBeInTheDocument();
  });

  it('warns on a cancelled booking', async () => {
    getCurrentUserMock.mockResolvedValue(ACTORS.FINANCE_ACCOUNTING);
    serviceMocks.getPaymentBookingHeaderForActor.mockResolvedValue(headerRecord('CANCELLED'));
    serviceMocks.getBookingPaymentSummaryForStaff.mockResolvedValue(summary());
    render(await AdminPaymentDetailPage({ params: params() }));

    expect(screen.getByText(/This booking is cancelled\./)).toBeInTheDocument();
  });
});
