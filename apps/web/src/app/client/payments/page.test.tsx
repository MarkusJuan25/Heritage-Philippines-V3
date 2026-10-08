// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getOwnClientForUserMock } = vi.hoisted(() => ({ getOwnClientForUserMock: vi.fn() }));
vi.mock('@/features/clients/service', () => ({ getOwnClientForUser: getOwnClientForUserMock }));

const { getClientPaymentSummariesMock } = vi.hoisted(() => ({
  getClientPaymentSummariesMock: vi.fn(),
}));
vi.mock('@/features/payments/service', () => ({
  getClientPaymentSummaries: getClientPaymentSummariesMock,
}));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

// The real error classes and Decimal, so the page's own error handling and
// money formatting run for real.
import { Prisma } from '@/generated/prisma/client';
import { ClientError } from '@/features/clients/errors';
import { PaymentError } from '@/features/payments/errors';

import Link from 'next/link';

import ClientPaymentsPage from './page';

const d = (value: string) => new Prisma.Decimal(value);
const CLIENT_USER = { id: 'user-1', email: 'client@example.test', name: 'Ana', role: 'CLIENT' };
const OWN_CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

// Internal ids that must never be rendered to the client.
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLMENT_IDS = [
  '22222222-2222-4222-8222-222222222221',
  '22222222-2222-4222-8222-222222222222',
];
const PAYMENT_IDS = [
  '33333333-3333-4333-8333-333333333331',
  '33333333-3333-4333-8333-333333333332',
  '33333333-3333-4333-8333-333333333333',
];

function summary(overrides: Record<string, unknown> = {}) {
  return {
    bookingId: BOOKING_ID,
    bookingReference: 'HPB-ANA0001',
    totalAmount: d('100000.00'),
    currencyCode: 'PHP',
    planApproved: true,
    confirmedAmountPaid: d('25000.00'),
    remainingBalance: d('75000.00'),
    overpayment: d('0.00'),
    unappliedCredit: d('987654.32'),
    nextPaymentDue: new Date('2026-10-15T00:00:00.000Z'),
    nextPaymentDueAmount: d('30000.00'),
    installments: [
      {
        id: INSTALLMENT_IDS[0],
        dueDate: new Date('2026-10-15T00:00:00.000Z'),
        amount: d('30000.00'),
        outstandingAmount: d('30000.00'),
      },
      {
        id: INSTALLMENT_IDS[1],
        dueDate: new Date('2026-11-15T00:00:00.000Z'),
        amount: d('70000.00'),
        outstandingAmount: d('70000.00'),
      },
    ],
    payments: [
      {
        id: PAYMENT_IDS[0],
        amount: d('30000.00'),
        status: 'CONFIRMED',
        receipt: { receiptNumber: 'RCPT-0001', issuedAt: new Date('2026-09-29T02:00:00.000Z') },
      },
      {
        id: PAYMENT_IDS[1],
        amount: d('10000.00'),
        status: 'REVERSED',
        receipt: { receiptNumber: 'RCPT-0002', issuedAt: new Date('2026-09-29T03:00:00.000Z') },
      },
      { id: PAYMENT_IDS[2], amount: d('1000.00'), status: 'PENDING', receipt: null },
    ],
    ...overrides,
  };
}

/**
 * The values this page's RSC payload would carry, which Next.js inlines into
 * the HTML: every element's key, and the props of every host element and
 * client component (`next/link`). Every other function component here is a
 * server component, rendered on the server, so it is expanded rather than
 * serialized. Visible-markup checks alone cannot see keys.
 */
function rscSerializedValues(node: ReactNode, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) rscSerializedValues(child as ReactNode, out);
    return out;
  }
  if (!isValidElement(node)) {
    out.push(node);
    return out;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  out.push(element.key);
  if (typeof element.type === 'function' && element.type !== Link) {
    const component = element.type as (props: Record<string, unknown>) => ReactNode;
    return rscSerializedValues(component(element.props), out);
  }
  const { children, ...props } = element.props;
  out.push(props);
  return rscSerializedValues(children as ReactNode, out);
}

async function renderPage() {
  const jsx = await ClientPaymentsPage();
  return render(<>{jsx}</>);
}

beforeEach(() => {
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  getCurrentUserMock.mockResolvedValue(CLIENT_USER);
  getOwnClientForUserMock.mockResolvedValue({ clientId: OWN_CLIENT_ID });
  getClientPaymentSummariesMock.mockResolvedValue([summary()]);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('ClientPaymentsPage — access and ownership', () => {
  it('redirects to /login without a session, reading nothing', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    await expect(ClientPaymentsPage()).rejects.toThrow('REDIRECT:/login');
    expect(getClientPaymentSummariesMock).not.toHaveBeenCalled();
  });

  it('reads only the Client resolved from the session, on this request', async () => {
    await renderPage();

    expect(getOwnClientForUserMock).toHaveBeenCalledWith(CLIENT_USER);
    expect(getClientPaymentSummariesMock).toHaveBeenCalledTimes(1);
    expect(getClientPaymentSummariesMock).toHaveBeenCalledWith(CLIENT_USER, OWN_CLIENT_ID);
  });

  it('renders nothing of its own (the layout panel applies) when no Client is linked', async () => {
    getOwnClientForUserMock.mockResolvedValue(null);
    expect(await ClientPaymentsPage()).toBeNull();
    expect(getClientPaymentSummariesMock).not.toHaveBeenCalled();
  });

  it.each([
    ['ClientError', new ClientError('ROLE_NOT_PERMITTED', 'Not a client.')],
    ['PaymentError', new PaymentError('ROLE_NOT_PERMITTED', 'Not a client.')],
  ])('renders nothing for ROLE_NOT_PERMITTED from %s', async (_label, error) => {
    getClientPaymentSummariesMock.mockRejectedValue(error);
    expect(await ClientPaymentsPage()).toBeNull();
  });

  it('sends a denied or unexpected failure to the error boundary instead of rendering data', async () => {
    const denied = new PaymentError(
      'BOOKING_FORBIDDEN',
      'Payments for this client are not accessible.',
    );
    getClientPaymentSummariesMock.mockRejectedValue(denied);
    await expect(ClientPaymentsPage()).rejects.toBe(denied);

    getClientPaymentSummariesMock.mockRejectedValue(new Error('database down'));
    await expect(ClientPaymentsPage()).rejects.toThrow('database down');
  });

  it('sends a stored-refund integrity failure to the error boundary: the whole page, no card (D-068)', async () => {
    // What `getClientPaymentSummaries` rejects with when any one of the
    // client's approved-plan Bookings is affected; it returns no list.
    const integrity = new Error(
      "Payment summary refused: stored refunds exceed a payment's amount.",
    );
    getClientPaymentSummariesMock.mockRejectedValue(integrity);
    await expect(ClientPaymentsPage()).rejects.toBe(integrity);
  });
});

describe('ClientPaymentsPage — states', () => {
  it('shows a helpful empty state with a Support & Messages path when no plan is approved', async () => {
    getClientPaymentSummariesMock.mockResolvedValue([]);
    await renderPage();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Payments & Receipts' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No payment plans to show yet.')).toBeInTheDocument();
    const supportLinks = screen.getAllByRole('link', { name: 'Support & Messages' });
    expect(supportLinks.length).toBeGreaterThan(0);
    for (const link of supportLinks) expect(link).toHaveAttribute('href', '/client/support');
  });

  it('shows the five server-computed values for an owned Booking with an approved plan', async () => {
    await renderPage();

    const card = screen.getByRole('article', { name: 'Booking HPB-ANA0001' });
    const value = (term: string) =>
      within(card).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent;
    expect(value('Total booking amount')).toBe('PHP 100,000.00');
    expect(value('Confirmed amount paid')).toBe('PHP 25,000.00');
    expect(value('Remaining balance')).toBe('PHP 75,000.00');
    expect(value('Next payment due')).toMatch(/^PHP 30,000\.00 on /);
    expect(within(card).getByRole('link', { name: 'View booking details' })).toHaveAttribute(
      'href',
      '/client/bookings/HPB-ANA0001',
    );
  });

  it('shows the installment schedule and the full payment history with each status and receipt', async () => {
    await renderPage();

    const schedule = screen.getByRole('region', { name: 'Installment schedule' });
    expect(within(schedule).getAllByRole('listitem')).toHaveLength(2);
    expect(schedule).toHaveTextContent('PHP 30,000.00 outstanding');

    const history = screen.getByRole('region', { name: 'Payment history' });
    const rows = within(history).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Confirmed');
    expect(rows[0]).toHaveTextContent('Receipt RCPT-0001, issued');
    // A reversed payment keeps its receipt, marked by the payment's status.
    expect(rows[1]).toHaveTextContent('Reversed');
    expect(rows[1]).toHaveTextContent('Receipt RCPT-0002');
    expect(rows[2]).toHaveTextContent('Pending');
    expect(rows[2]).toHaveTextContent('No receipt');
  });

  it('says nothing is due when the plan is fully covered', async () => {
    getClientPaymentSummariesMock.mockResolvedValue([
      summary({ nextPaymentDue: null, nextPaymentDueAmount: null, remainingBalance: d('0.00') }),
    ]);
    await renderPage();

    expect(
      screen.getByText('Next payment due', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('Nothing is due right now');
  });

  it('shows one card per owned Booking with an approved plan', async () => {
    getClientPaymentSummariesMock.mockResolvedValue([
      summary(),
      summary({ bookingReference: 'HPB-ANA0002', payments: [] }),
    ]);
    await renderPage();

    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(
      within(screen.getByRole('article', { name: 'Booking HPB-ANA0002' })).getByText(
        'No payments have been recorded yet.',
      ),
    ).toBeInTheDocument();
  });
});

describe('ClientPaymentsPage — client-safe output (D-054 §7)', () => {
  it('never renders internal record ids', async () => {
    const { container } = await renderPage();
    const html = container.innerHTML;
    for (const id of [BOOKING_ID, OWN_CLIENT_ID, ...INSTALLMENT_IDS, ...PAYMENT_IDS]) {
      expect(html).not.toContain(id);
    }
  });

  it('never serializes internal record ids into the RSC payload, including as React keys', async () => {
    const payload = JSON.stringify(rscSerializedValues(await ClientPaymentsPage()));

    for (const id of [BOOKING_ID, OWN_CLIENT_ID, ...INSTALLMENT_IDS, ...PAYMENT_IDS]) {
      expect(payload).not.toContain(id);
    }
    // Positive control: the walk does see keys and rendered values.
    expect(payload).toContain('installment-1');
    expect(payload).toContain('payment-3');
    expect(payload).toContain('HPB-ANA0001');
  });

  it('never renders staff-only values such as unapplied credit or overpayment', async () => {
    const { container } = await renderPage();
    expect(container).not.toHaveTextContent(/unapplied|overpayment|allocation/i);
    expect(container).not.toHaveTextContent('987,654.32');
  });

  it('is read-only: no button, form, or input, and no receipt link or file URL', async () => {
    const { container } = await renderPage();

    expect(container.querySelectorAll('button, form, input, select, textarea')).toHaveLength(0);
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs.sort()).toEqual(['/client/bookings/HPB-ANA0001', '/client/support']);
    expect(container.innerHTML).not.toMatch(/receipt[^"]*\.(pdf|png)|\/api\/|download/i);
  });
});
