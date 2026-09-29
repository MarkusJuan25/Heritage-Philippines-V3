import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the routes are imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

const serviceMocks = vi.hoisted(() => ({
  proposePaymentPlan: vi.fn(),
  approvePaymentPlan: vi.fn(),
  withdrawPaymentPlan: vi.fn(),
  recordPayment: vi.fn(),
  confirmPayment: vi.fn(),
  reversePayment: vi.fn(),
  refundPayment: vi.fn(),
  issueReceipt: vi.fn(),
  createAllocation: vi.fn(),
  reverseAllocation: vi.fn(),
  setBookingFinancials: vi.fn(),
}));
vi.mock('@/features/payments/service', () => serviceMocks);

import { PaymentError } from '@/features/payments/errors';

import { POST as approvePlan } from './plans/[id]/approval/route';
import { POST as withdrawPlan } from './plans/[id]/withdrawal/route';
import { POST as proposePlan } from './plans/route';
import { POST as confirmPayment } from './[id]/confirmation/route';
import { POST as issueReceipt } from './[id]/receipt/route';
import { POST as refundPayment } from './[id]/refunds/route';
import { POST as reversePayment } from './[id]/reversal/route';
import { POST as reverseAllocation } from './allocations/[id]/reversal/route';
import { POST as createAllocation } from './allocations/route';
import { POST as recordPayment } from './route';
import { PUT as setFinancials } from './bookings/[id]/financials/route';

const ROLES = [
  'SYSTEM_ADMINISTRATOR',
  'ADMIN_MANAGER',
  'TRAVEL_CONSULTANT',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
] as const;

const ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';

type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

type RouteCase = {
  name: string;
  handler: Handler;
  service: keyof typeof serviceMocks;
  roles: readonly (typeof ROLES)[number][];
  idKey: string | null;
  body: Record<string, unknown>;
  successStatus: number;
  responseKey: string | null;
};

const CASES: RouteCase[] = [
  {
    name: 'POST /api/payments/plans',
    handler: proposePlan as Handler,
    service: 'proposePaymentPlan',
    roles: ['TRAVEL_CONSULTANT'],
    idKey: null,
    body: {
      bookingId: ID,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
      ],
    },
    successStatus: 201,
    responseKey: 'plan',
  },
  {
    name: 'POST /api/payments/plans/[id]/approval',
    handler: approvePlan as Handler,
    service: 'approvePaymentPlan',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: 'paymentPlanId',
    body: {},
    successStatus: 200,
    responseKey: 'plan',
  },
  {
    name: 'POST /api/payments/plans/[id]/withdrawal',
    handler: withdrawPlan as Handler,
    service: 'withdrawPaymentPlan',
    roles: ['TRAVEL_CONSULTANT', 'FINANCE_ACCOUNTING'],
    idKey: 'paymentPlanId',
    body: { reason: 'Wrong structure' },
    successStatus: 200,
    responseKey: 'plan',
  },
  {
    name: 'POST /api/payments',
    handler: recordPayment as Handler,
    service: 'recordPayment',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: null,
    body: { bookingId: ID, amount: '100.00', idempotencyKey: 'k-1' },
    successStatus: 201,
    responseKey: 'payment',
  },
  {
    name: 'POST /api/payments/[id]/confirmation',
    handler: confirmPayment as Handler,
    service: 'confirmPayment',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: 'paymentId',
    body: { reason: 'Verified', idempotencyKey: 'k-1' },
    successStatus: 200,
    responseKey: 'payment',
  },
  {
    name: 'POST /api/payments/[id]/reversal',
    handler: reversePayment as Handler,
    service: 'reversePayment',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: 'paymentId',
    body: { reason: 'Duplicate entry', idempotencyKey: 'k-1' },
    successStatus: 200,
    responseKey: 'payment',
  },
  {
    name: 'POST /api/payments/[id]/refunds',
    handler: refundPayment as Handler,
    service: 'refundPayment',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: 'paymentId',
    body: { amount: '50.00', reason: 'Excursion cancelled', idempotencyKey: 'k-1' },
    successStatus: 200,
    responseKey: null,
  },
  {
    name: 'POST /api/payments/[id]/receipt',
    handler: issueReceipt as Handler,
    service: 'issueReceipt',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: 'paymentId',
    body: {},
    successStatus: 200,
    responseKey: null,
  },
  {
    name: 'POST /api/payments/allocations',
    handler: createAllocation as Handler,
    service: 'createAllocation',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: null,
    body: { paymentId: ID, installmentId: OTHER_ID, amount: '50.00', idempotencyKey: 'k-1' },
    successStatus: 201,
    responseKey: 'allocation',
  },
  {
    name: 'POST /api/payments/allocations/[id]/reversal',
    handler: reverseAllocation as Handler,
    service: 'reverseAllocation',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: 'allocationId',
    body: { reason: 'Misallocated', idempotencyKey: 'k-1' },
    successStatus: 200,
    responseKey: 'reversal',
  },
  {
    name: 'PUT /api/payments/bookings/[id]/financials',
    handler: setFinancials as Handler,
    service: 'setBookingFinancials',
    roles: ['FINANCE_ACCOUNTING'],
    idKey: 'bookingId',
    body: { totalAmount: '115000.00', currencyCode: 'PHP' },
    successStatus: 200,
    responseKey: 'financials',
  },
];

function user(role: string) {
  return { id: `${role.toLowerCase()}-1`, email: 'staff@example.test', name: role, role };
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/payments', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function context(id = ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(CASES)('$name', (route) => {
  const allowed = route.roles[0]!;

  it('returns 401 without a session, never calling the service', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await route.handler(post(route.body), context());
    expect(response.status).toBe(401);
    expect(serviceMocks[route.service]).not.toHaveBeenCalled();
  });

  it.each(ROLES.filter((role) => !route.roles.includes(role)))(
    'returns 403 for %s, never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: user(role) });
      const response = await route.handler(post(route.body), context());
      expect(response.status).toBe(403);
      expect(serviceMocks[route.service]).not.toHaveBeenCalled();
    },
  );

  it('returns 400 VALIDATION_ERROR for malformed JSON or an unknown field', async () => {
    getSessionMock.mockResolvedValue({ user: user(allowed) });
    for (const body of ['{', { ...route.body, status: 'CONFIRMED' }]) {
      const response = await route.handler(post(body), context());
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
    expect(serviceMocks[route.service]).not.toHaveBeenCalled();
  });

  if (route.idKey) {
    const idKey = route.idKey;

    it('returns 400 for a non-UUID id in the URL', async () => {
      getSessionMock.mockResolvedValue({ user: user(allowed) });
      const response = await route.handler(post(route.body), context('not-a-uuid'));
      expect(response.status).toBe(400);
      expect(serviceMocks[route.service]).not.toHaveBeenCalled();
    });

    it('targets the id in the URL, never one supplied in the body', async () => {
      getSessionMock.mockResolvedValue({ user: user(allowed) });
      serviceMocks[route.service].mockResolvedValue({ id: 'result-1' });
      await route.handler(post({ ...route.body, [idKey]: OTHER_ID }), context());
      expect(serviceMocks[route.service]).toHaveBeenCalledWith(
        expect.objectContaining({ role: allowed }),
        expect.objectContaining({ [idKey]: ID }),
      );
    });
  }

  it.each(route.roles)('calls the service for %s and returns its result', async (role) => {
    getSessionMock.mockResolvedValue({ user: user(role) });
    serviceMocks[route.service].mockResolvedValue({ id: 'result-1' });

    const response = await route.handler(post(route.body), context());

    expect(response.status).toBe(route.successStatus);
    const json = await response.json();
    expect(route.responseKey ? json[route.responseKey] : json).toEqual({ id: 'result-1' });
    expect(serviceMocks[route.service]).toHaveBeenCalledWith(
      expect.objectContaining({ id: user(role).id, role }),
      expect.objectContaining(route.idKey ? { ...route.body, [route.idKey]: ID } : route.body),
    );
  });

  it("maps a PaymentError to its code and status, passing the service's message through", async () => {
    getSessionMock.mockResolvedValue({ user: user(allowed) });
    serviceMocks[route.service].mockRejectedValue(
      new PaymentError('BOOKING_STATUS_NOT_PERMITTED', 'This booking is cancelled.'),
    );
    const response = await route.handler(post(route.body), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: 'BOOKING_STATUS_NOT_PERMITTED', message: 'This booking is cancelled.' },
    });
  });

  it('never exposes an unexpected error, returning the generic 500', async () => {
    getSessionMock.mockResolvedValue({ user: user(allowed) });
    serviceMocks[route.service].mockRejectedValue(new Error('connection to db-host failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await route.handler(post(route.body), context());
    errorSpy.mockRestore();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('db-host');
  });
});
