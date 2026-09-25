import { beforeEach, describe, expect, it, vi } from 'vitest';

// service.ts imports `prisma` from `@/lib/db` (transitively via
// @/lib/serializable-transaction, and directly for reads), which eagerly
// validates env vars and opens a real database adapter at import time —
// mock it before `./service` is imported, mirroring
// features/bookings/service.test.ts exactly. `runSerializableWithRetry` is
// intentionally left unmocked (real implementation), so these tests exercise
// the real retry/backoff logic composed with a mocked `$transaction`.
const { transactionMock } = vi.hoisted(() => ({ transactionMock: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { $transaction: transactionMock, marker: 'prisma-singleton' },
}));

const repositoryMocks = vi.hoisted(() => ({
  findBookingFinancialsForActor: vi.fn(),
  findPaymentPlanByBookingIdForActor: vi.fn(),
  findPaymentPlanWithBookingForActor: vi.fn(),
  createPaymentPlanWithInstallments: vi.fn(),
  sumInstallmentAmounts: vi.fn(),
  approvePaymentPlanRow: vi.fn(),
  findInstallmentForAllocation: vi.fn(),
  findPaymentForActor: vi.fn(),
  createPendingPayment: vi.fn(),
  findStatusHistoryByIdempotencyKey: vi.fn(),
  sumRefundsForPayment: vi.fn(),
  transitionPaymentStatus: vi.fn(),
  findRefundByIdempotencyKey: vi.fn(),
  createRefund: vi.fn(),
  findAllocationForRefund: vi.fn(),
  findAllocationByIdempotencyKey: vi.fn(),
  createAllocation: vi.fn(),
  sumNetActiveAllocationsForPayment: vi.fn(),
  sumNetActiveAllocationsForInstallment: vi.fn(),
  findAllocationForReversal: vi.fn(),
  findAllocationReversalByIdempotencyKey: vi.fn(),
  createAllocationReversal: vi.fn(),
  findReceiptByPaymentId: vi.fn(),
  createReceipt: vi.fn(),
  findBookingCurrencyCode: vi.fn(),
  insertAuditLog: vi.fn(),
  findBookingPaymentSummaryData: vi.fn(),
  findApprovedBookingIdsForClient: vi.fn(),
}));
vi.mock('./repository', () => repositoryMocks);

const authorizationMocks = vi.hoisted(() => ({ canAccessClient: vi.fn() }));
vi.mock('@/features/assignments/authorization', () => authorizationMocks);

import { Prisma } from '@/generated/prisma/client';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import { PaymentError } from './errors';
import {
  approvePaymentPlan,
  confirmPayment,
  createAllocation,
  getBookingPaymentSummaryForStaff,
  getClientPaymentSummaries,
  issueReceipt,
  proposePaymentPlan,
  recordPayment,
  refundPayment,
  reverseAllocation,
  reversePayment,
} from './service';

const TX_CLIENT = { marker: 'tx-client' };

const ADMIN_MANAGER: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: 'ADMIN_MANAGER',
};
const TRAVEL_CONSULTANT: AuthenticatedUser = {
  id: 'tc-1',
  email: 'tc@example.test',
  name: 'TC',
  role: 'TRAVEL_CONSULTANT',
};
const FINANCE: AuthenticatedUser = {
  id: 'finance-1',
  email: 'finance@example.test',
  name: 'Finance',
  role: 'FINANCE_ACCOUNTING',
};
const CLIENT_USER: AuthenticatedUser = {
  id: 'user-1',
  email: 'client@example.test',
  name: 'Client',
  role: 'CLIENT',
};
const VISA: AuthenticatedUser = {
  id: 'visa-1',
  email: 'visa@example.test',
  name: 'Visa',
  role: 'VISA_DOCUMENTATION',
};

const d = (value: string) => new Prisma.Decimal(value);

beforeEach(() => {
  vi.clearAllMocks();
  transactionMock.mockImplementation((fn: (tx: unknown) => unknown) => fn(TX_CLIENT));
  // `clearAllMocks` keeps implementations, so reset the idempotency lookups
  // every test relies on being empty unless it says otherwise.
  repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(null);
  repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue(null);
  repositoryMocks.findAllocationByIdempotencyKey.mockResolvedValue(null);
  repositoryMocks.findAllocationReversalByIdempotencyKey.mockResolvedValue(null);
  repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('0.00'));
  repositoryMocks.sumNetActiveAllocationsForInstallment.mockResolvedValue(d('0.00'));
});

/**
 * Raw summary data for a Booking with one Payment (`payment-1`) and,
 * optionally, allocations of that Payment against one Installment — the
 * shape `refundPayment`'s write-time credit/allocation checks read.
 */
function summaryDataFor(options: {
  paymentAmount: string;
  refunded: string;
  allocations?: { id: string; amount: string; refundAllocated: string; isReversed?: boolean }[];
}) {
  return {
    booking: {
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: d('500.00'),
      currencyCode: 'PHP',
    },
    plan: {
      id: 'plan-1',
      approvedByStaffUserId: 'finance-1',
      approvedAt: new Date('2026-09-01'),
      installments: [
        {
          id: 'inst-1',
          dueDate: new Date('2026-10-01'),
          amount: d('500.00'),
          allocations: (options.allocations ?? []).map((allocation) => ({
            id: allocation.id,
            paymentId: 'payment-1',
            amount: d(allocation.amount),
            isReversed: allocation.isReversed ?? false,
            refundAllocatedTotal: d(allocation.refundAllocated),
            paymentStatus: 'CONFIRMED' as const,
          })),
        },
      ],
    },
    payments: [
      {
        id: 'payment-1',
        amount: d(options.paymentAmount),
        status: 'CONFIRMED' as const,
        refundedTotal: d(options.refunded),
        receipt: null as { receiptNumber: string; issuedAt: Date } | null,
      },
    ],
  };
}

// A P2002 exactly as @prisma/adapter-pg reports it: no `meta.target`;
// model in `meta.modelName`; columns under
// `meta.driverAdapterError.cause.constraint.fields`, quoted when mixed-case.
function adapterUniqueViolation(modelName: string, fields: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.8.0',
    meta: {
      modelName,
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: fields.map((f) => (/[A-Z]/.test(f) ? `"${f}"` : f)) },
        },
      },
    },
  });
}

// The commit-time write-conflict form: a raw DriverAdapterError.
function rawAdapterWriteConflict(): Error {
  return Object.assign(new Error('TransactionWriteConflict'), {
    name: 'DriverAdapterError',
    cause: { originalCode: '40001', kind: 'TransactionWriteConflict' },
  });
}

async function expectPaymentError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(PaymentError);
  await promise.catch((error: PaymentError) => {
    expect(error.code).toBe(code);
  });
}

describe('proposePaymentPlan', () => {
  const input = {
    bookingId: 'booking-1',
    installments: [{ sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' }],
  };

  it('rejects a non-TRAVEL_CONSULTANT actor', async () => {
    await expectPaymentError(proposePaymentPlan(ADMIN_MANAGER, input), 'ROLE_NOT_PERMITTED');
    await expectPaymentError(proposePaymentPlan(FINANCE, input), 'ROLE_NOT_PERMITTED');
    expect(repositoryMocks.findBookingFinancialsForActor).not.toHaveBeenCalled();
  });

  it.each([
    [
      'duplicate sequence numbers',
      [
        { sequenceNumber: 1, isDeposit: false, amount: '250.00', dueDate: '2026-10-01' },
        { sequenceNumber: 1, isDeposit: false, amount: '250.00', dueDate: '2026-11-01' },
      ],
    ],
    [
      'more than one deposit',
      [
        { sequenceNumber: 1, isDeposit: true, amount: '250.00', dueDate: '2026-10-01' },
        { sequenceNumber: 2, isDeposit: true, amount: '250.00', dueDate: '2026-11-01' },
      ],
    ],
    [
      'a deposit that is not sequence number 1 (D-019)',
      [
        { sequenceNumber: 1, isDeposit: false, amount: '250.00', dueDate: '2026-10-01' },
        { sequenceNumber: 2, isDeposit: true, amount: '250.00', dueDate: '2026-11-01' },
      ],
    ],
  ])(
    'rejects %s with PAYMENT_PLAN_CONFLICT before any database work',
    async (_label, installments) => {
      await expectPaymentError(
        proposePaymentPlan(TRAVEL_CONSULTANT, { bookingId: 'booking-1', installments }),
        'PAYMENT_PLAN_CONFLICT',
      );
      expect(transactionMock).not.toHaveBeenCalled();
      expect(repositoryMocks.createPaymentPlanWithInstallments).not.toHaveBeenCalled();
    },
  );

  it('creates the plan when the booking has financials set and no plan exists yet', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue({
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: d('500.00'),
      currencyCode: 'PHP',
    });
    repositoryMocks.findPaymentPlanByBookingIdForActor.mockResolvedValue(null);
    repositoryMocks.createPaymentPlanWithInstallments.mockResolvedValue({ id: 'plan-1' });

    const result = await proposePaymentPlan(TRAVEL_CONSULTANT, input);

    expect(result).toEqual({ id: 'plan-1' });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ action: 'PAYMENT_PLAN_PROPOSED' }),
    );
  });

  it('rejects when the booking is not accessible to the actor', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue(null);
    await expectPaymentError(proposePaymentPlan(TRAVEL_CONSULTANT, input), 'BOOKING_FORBIDDEN');
  });

  it('rejects when the booking has no totalAmount/currencyCode yet', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue({
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: null,
      currencyCode: null,
    });
    await expectPaymentError(proposePaymentPlan(TRAVEL_CONSULTANT, input), 'PAYMENT_PLAN_CONFLICT');
  });

  it('rejects when a plan already exists for the booking (pre-check)', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue({
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: d('500.00'),
      currencyCode: 'PHP',
    });
    repositoryMocks.findPaymentPlanByBookingIdForActor.mockResolvedValue({ id: 'existing-plan' });
    await expectPaymentError(proposePaymentPlan(TRAVEL_CONSULTANT, input), 'PAYMENT_PLAN_CONFLICT');
    expect(repositoryMocks.createPaymentPlanWithInstallments).not.toHaveBeenCalled();
  });

  it('rejects (never silently succeeds) on a concurrent bookingId unique-constraint race', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue({
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: d('500.00'),
      currencyCode: 'PHP',
    });
    repositoryMocks.findPaymentPlanByBookingIdForActor.mockResolvedValue(null);
    repositoryMocks.createPaymentPlanWithInstallments.mockRejectedValue(
      adapterUniqueViolation('PaymentPlan', ['bookingId']),
    );
    await expectPaymentError(proposePaymentPlan(TRAVEL_CONSULTANT, input), 'PAYMENT_PLAN_CONFLICT');
  });
});

describe('approvePaymentPlan', () => {
  const input = { paymentPlanId: 'plan-1' };

  it('rejects a non-FINANCE_ACCOUNTING actor', async () => {
    await expectPaymentError(approvePaymentPlan(TRAVEL_CONSULTANT, input), 'ROLE_NOT_PERMITTED');
  });

  it('approves when installments sum exactly to the booking total', async () => {
    repositoryMocks.findPaymentPlanWithBookingForActor.mockResolvedValue({
      plan: { id: 'plan-1', approvedAt: null },
      booking: {
        id: 'booking-1',
        clientId: 'client-1',
        totalAmount: d('500.00'),
        currencyCode: 'PHP',
      },
    });
    repositoryMocks.sumInstallmentAmounts.mockResolvedValue(d('500.00'));
    repositoryMocks.approvePaymentPlanRow.mockResolvedValue({
      id: 'plan-1',
      approvedAt: new Date(),
    });

    const result = await approvePaymentPlan(FINANCE, input);

    expect(result).toEqual(expect.objectContaining({ id: 'plan-1' }));
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ action: 'PAYMENT_PLAN_APPROVED' }),
    );
  });

  it('is an idempotent no-op when the plan is already approved', async () => {
    const alreadyApproved = { id: 'plan-1', approvedAt: new Date('2026-01-01') };
    repositoryMocks.findPaymentPlanWithBookingForActor.mockResolvedValue({
      plan: alreadyApproved,
      booking: {
        id: 'booking-1',
        clientId: 'client-1',
        totalAmount: d('500.00'),
        currencyCode: 'PHP',
      },
    });

    const result = await approvePaymentPlan(FINANCE, input);

    expect(result).toBe(alreadyApproved);
    expect(repositoryMocks.approvePaymentPlanRow).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('rejects when installments do not sum to the booking total (reconciliation failure)', async () => {
    repositoryMocks.findPaymentPlanWithBookingForActor.mockResolvedValue({
      plan: { id: 'plan-1', approvedAt: null },
      booking: {
        id: 'booking-1',
        clientId: 'client-1',
        totalAmount: d('500.00'),
        currencyCode: 'PHP',
      },
    });
    repositoryMocks.sumInstallmentAmounts.mockResolvedValue(d('499.99'));

    await expectPaymentError(approvePaymentPlan(FINANCE, input), 'PAYMENT_PLAN_CONFLICT');
    expect(repositoryMocks.approvePaymentPlanRow).not.toHaveBeenCalled();
  });

  it('rejects when the plan is not accessible to the actor', async () => {
    repositoryMocks.findPaymentPlanWithBookingForActor.mockResolvedValue(null);
    await expectPaymentError(approvePaymentPlan(FINANCE, input), 'PAYMENT_PLAN_FORBIDDEN');
  });
});

describe('recordPayment', () => {
  const input = { bookingId: 'booking-1', amount: '150.00', idempotencyKey: 'record-1' };

  it('rejects a non-FINANCE_ACCOUNTING actor', async () => {
    await expectPaymentError(recordPayment(TRAVEL_CONSULTANT, input), 'ROLE_NOT_PERMITTED');
  });

  it('records a PENDING payment for an accessible booking', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue({
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: d('500.00'),
      currencyCode: 'PHP',
    });
    repositoryMocks.createPendingPayment.mockResolvedValue({ id: 'payment-1', status: 'PENDING' });

    const result = await recordPayment(FINANCE, input);
    expect(result).toEqual({ id: 'payment-1', status: 'PENDING' });
  });

  it('rejects when the booking is not accessible', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue(null);
    await expectPaymentError(recordPayment(FINANCE, input), 'BOOKING_FORBIDDEN');
  });

  // D-019's booking_financials_pairing constraint: a Booking has both
  // totalAmount and currencyCode, or neither — the only two states mocked.
  it('refuses a booking with neither total nor currency before writing anything (D-054 §17 Rule 4)', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue({
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: null,
      currencyCode: null,
    });

    await expectPaymentError(recordPayment(FINANCE, input), 'BOOKING_CURRENCY_NOT_SET');
    expect(repositoryMocks.createPendingPayment).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('records a payment for a booking with total and currency set, without requiring a payment plan', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue({
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: d('500.00'),
      currencyCode: 'PHP',
    });
    repositoryMocks.createPendingPayment.mockResolvedValue({ id: 'payment-1', status: 'PENDING' });

    await expect(recordPayment(FINANCE, input)).resolves.toEqual({
      id: 'payment-1',
      status: 'PENDING',
    });
    expect(repositoryMocks.findPaymentPlanByBookingIdForActor).not.toHaveBeenCalled();
  });

  describe('idempotency (D-054 §17 Rule 6)', () => {
    const accessibleBooking = {
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: d('500.00'),
      currencyCode: 'PHP',
    };
    const initialRow = { paymentId: 'payment-1', previousStatus: null, newStatus: 'PENDING' };
    const original = {
      id: 'payment-1',
      bookingId: 'booking-1',
      clientId: 'client-1',
      amount: d('150.00'),
      status: 'PENDING',
    };

    beforeEach(() => {
      repositoryMocks.findBookingFinancialsForActor.mockResolvedValue(accessibleBooking);
    });

    it("stores the key on the new payment's initial status-history row", async () => {
      repositoryMocks.createPendingPayment.mockResolvedValue(original);
      await recordPayment(FINANCE, input);
      expect(repositoryMocks.createPendingPayment).toHaveBeenCalledWith(
        TX_CLIENT,
        expect.objectContaining({ idempotencyKey: 'record-1', amount: '150.00' }),
      );
    });

    it('checks booking access before looking up the key', async () => {
      repositoryMocks.findBookingFinancialsForActor.mockResolvedValue(null);
      await expectPaymentError(recordPayment(FINANCE, input), 'BOOKING_FORBIDDEN');
      expect(repositoryMocks.findStatusHistoryByIdempotencyKey).not.toHaveBeenCalled();
    });

    it('returns the original payment, in its current status, and writes nothing on a retry', async () => {
      repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(initialRow);
      repositoryMocks.findPaymentForActor.mockResolvedValue({ ...original, status: 'CONFIRMED' });

      await expect(recordPayment(FINANCE, input)).resolves.toEqual({
        ...original,
        status: 'CONFIRMED',
      });
      expect(repositoryMocks.findPaymentForActor).toHaveBeenCalledWith(
        TX_CLIENT,
        { id: FINANCE.id, role: 'FINANCE_ACCOUNTING' },
        'payment-1',
      );
      expect(repositoryMocks.createPendingPayment).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it.each([
      ['a different amount', { ...original, amount: d('150.01') }],
      ['a different booking', { ...original, bookingId: 'booking-2' }],
      ['a payment the actor cannot access', null],
    ])('rejects the key when it names %s, without writing', async (_label, found) => {
      repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(initialRow);
      repositoryMocks.findPaymentForActor.mockResolvedValue(found);

      await expectPaymentError(recordPayment(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
      expect(repositoryMocks.createPendingPayment).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    });

    it.each([
      ['CONFIRMED', 'PENDING'],
      ['REVERSED', 'CONFIRMED'],
      ['REFUNDED', 'CONFIRMED'],
    ])(
      'rejects a key already used for a %s transition, never creating a payment',
      async (newStatus, previousStatus) => {
        repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue({
          paymentId: 'payment-1',
          previousStatus,
          newStatus,
        });

        await expectPaymentError(recordPayment(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
        expect(repositoryMocks.findPaymentForActor).not.toHaveBeenCalled();
        expect(repositoryMocks.createPendingPayment).not.toHaveBeenCalled();
      },
    );

    it("answers the losing side of a concurrent duplicate with the winner's payment", async () => {
      repositoryMocks.createPendingPayment.mockRejectedValue(
        adapterUniqueViolation('Payment', ['idempotencyKey']),
      );
      repositoryMocks.findStatusHistoryByIdempotencyKey
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(initialRow);
      repositoryMocks.findPaymentForActor.mockResolvedValue(original);

      await expect(recordPayment(FINANCE, input)).resolves.toEqual(original);
      expect(repositoryMocks.createPendingPayment).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a duplicate Payment id', adapterUniqueViolation('Payment', ['id'])],
      ['a refund key', adapterUniqueViolation('PaymentRefund', ['idempotencyKey'])],
      ['an allocation key', adapterUniqueViolation('PaymentAllocation', ['idempotencyKey'])],
    ])('never treats %s as a status-history key race', async (_label, violation) => {
      repositoryMocks.createPendingPayment.mockRejectedValue(violation);

      await expectPaymentError(recordPayment(FINANCE, input), 'PAYMENT_CONFLICT');
      // Only the in-transaction lookup ran; no replay was attempted.
      expect(repositoryMocks.findStatusHistoryByIdempotencyKey).toHaveBeenCalledTimes(1);
      expect(repositoryMocks.findPaymentForActor).not.toHaveBeenCalled();
    });

    it('rejects the losing side when the concurrent winner recorded a different amount', async () => {
      repositoryMocks.createPendingPayment.mockRejectedValue(
        adapterUniqueViolation('Payment', ['idempotencyKey']),
      );
      repositoryMocks.findStatusHistoryByIdempotencyKey
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(initialRow);
      repositoryMocks.findPaymentForActor.mockResolvedValue({ ...original, amount: d('99.00') });

      await expectPaymentError(recordPayment(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
    });
  });
});

describe('payment write conflicts (shared lib/prisma-errors.ts handling)', () => {
  const confirmInput = { paymentId: 'payment-1', reason: 'Verified', idempotencyKey: 'idem-1' };

  it('retries the commit-time raw adapter conflict and maps exhausted retries to PAYMENT_CONFLICT', async () => {
    transactionMock.mockImplementation(async () => {
      throw rawAdapterWriteConflict();
    });

    await expectPaymentError(confirmPayment(FINANCE, confirmInput), 'PAYMENT_CONFLICT');
    expect(transactionMock).toHaveBeenCalledTimes(3);
  });

  it('answers a lost confirmation race on its own key with the prior result, re-checking assignment', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'PENDING',
      amount: d('150.00'),
    });
    repositoryMocks.transitionPaymentStatus.mockRejectedValue(
      adapterUniqueViolation('Payment', ['idempotencyKey']),
    );
    // After the rolled-back attempt, the concurrent winner's row is visible.
    repositoryMocks.findStatusHistoryByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ paymentId: 'payment-1', newStatus: 'CONFIRMED' });
    repositoryMocks.findPaymentForActor
      .mockResolvedValueOnce({ id: 'payment-1', status: 'PENDING', amount: d('150.00') })
      .mockResolvedValueOnce({ id: 'payment-1', status: 'CONFIRMED', amount: d('150.00') });

    await expect(confirmPayment(FINANCE, confirmInput)).resolves.toEqual({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    expect(repositoryMocks.findPaymentForActor).toHaveBeenLastCalledWith(
      expect.anything(),
      { id: FINANCE.id, role: 'FINANCE_ACCOUNTING' },
      'payment-1',
    );
  });

  it('never treats an idempotencyKey unique violation on another model as a confirmation replay', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'PENDING',
      amount: d('150.00'),
    });
    repositoryMocks.transitionPaymentStatus.mockRejectedValue(
      adapterUniqueViolation('PaymentRefund', ['idempotencyKey']),
    );

    await expectPaymentError(confirmPayment(FINANCE, confirmInput), 'PAYMENT_CONFLICT');
    // Only the in-transaction pre-check ran; no replay lookup after the error.
    expect(repositoryMocks.findStatusHistoryByIdempotencyKey).toHaveBeenCalledTimes(1);
  });
});

describe('confirmPayment', () => {
  const input = { paymentId: 'payment-1', reason: 'Verified', idempotencyKey: 'idem-1' };

  it('rejects a non-FINANCE_ACCOUNTING actor', async () => {
    await expectPaymentError(confirmPayment(VISA, input), 'ROLE_NOT_PERMITTED');
  });

  it('confirms a PENDING payment', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'PENDING',
      amount: d('150.00'),
    });
    repositoryMocks.transitionPaymentStatus.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
    });

    const result = await confirmPayment(FINANCE, input);
    expect(result).toEqual({ id: 'payment-1', status: 'CONFIRMED' });
  });

  it('returns the already-confirmed payment on an idempotent retry, without re-transitioning', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue({
      paymentId: 'payment-1',
      newStatus: 'CONFIRMED',
    });
    repositoryMocks.findPaymentForActor.mockResolvedValue({ id: 'payment-1', status: 'CONFIRMED' });

    const result = await confirmPayment(FINANCE, input);
    expect(result).toEqual({ id: 'payment-1', status: 'CONFIRMED' });
    expect(repositoryMocks.findPaymentForActor).toHaveBeenCalledWith(
      TX_CLIENT,
      { id: FINANCE.id, role: 'FINANCE_ACCOUNTING' },
      'payment-1',
    );
    expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
  });

  it('rejects a key already used for a different payment, never returning that payment', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue({
      paymentId: 'someone-elses-payment',
      newStatus: 'CONFIRMED',
    });

    await expectPaymentError(confirmPayment(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
    expect(repositoryMocks.findPaymentForActor).not.toHaveBeenCalled();
    expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
  });

  it('rejects a key already used for a different status transition on the same payment', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue({
      paymentId: 'payment-1',
      newStatus: 'REVERSED',
    });

    await expectPaymentError(confirmPayment(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
  });

  it('re-checks assignment on replay: a matching key for an unassigned payment is PAYMENT_FORBIDDEN', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue({
      paymentId: 'payment-1',
      newStatus: 'CONFIRMED',
    });
    repositoryMocks.findPaymentForActor.mockResolvedValue(null);

    await expectPaymentError(confirmPayment(FINANCE, input), 'PAYMENT_FORBIDDEN');
  });

  it('rejects confirming a payment that is not PENDING', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });

    await expectPaymentError(confirmPayment(FINANCE, input), 'INVALID_PAYMENT_TRANSITION');
    expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
  });

  it('rejects when the payment is not accessible', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue(null);
    await expectPaymentError(confirmPayment(FINANCE, input), 'PAYMENT_FORBIDDEN');
  });
});

describe('reversePayment', () => {
  const input = {
    paymentId: 'payment-1',
    reason: 'Erroneous confirmation',
    idempotencyKey: 'idem-1',
  };

  it('reverses a CONFIRMED payment with zero refunds', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.transitionPaymentStatus.mockResolvedValue({
      id: 'payment-1',
      status: 'REVERSED',
    });

    const result = await reversePayment(FINANCE, input);
    expect(result).toEqual({ id: 'payment-1', status: 'REVERSED' });
  });

  it.each(['PENDING', 'REJECTED', 'CANCELLED', 'FAILED', 'REFUNDED', 'REVERSED'] as const)(
    'rejects reversing a payment whose status is %s (only CONFIRMED is reversible)',
    async (status) => {
      repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(null);
      repositoryMocks.findPaymentForActor.mockResolvedValue({
        id: 'payment-1',
        status,
        amount: d('150.00'),
      });

      await expectPaymentError(reversePayment(FINANCE, input), 'INVALID_PAYMENT_TRANSITION');
      expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
    },
  );

  it('rejects reversing a CONFIRMED payment that already has a refund (mutual exclusion)', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('10.00'));

    await expectPaymentError(reversePayment(FINANCE, input), 'INVALID_PAYMENT_TRANSITION');
    expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
  });

  it('is idempotent by key', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue({
      paymentId: 'payment-1',
      newStatus: 'REVERSED',
    });
    repositoryMocks.findPaymentForActor.mockResolvedValue({ id: 'payment-1', status: 'REVERSED' });
    const result = await reversePayment(FINANCE, input);
    expect(result).toEqual({ id: 'payment-1', status: 'REVERSED' });
    expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
  });

  it('rejects reusing a confirmation key to reverse (never reports the confirmation as a reversal)', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue({
      paymentId: 'payment-1',
      newStatus: 'CONFIRMED',
    });
    await expectPaymentError(reversePayment(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
    expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
  });
});

describe('refundPayment', () => {
  const input = {
    paymentId: 'payment-1',
    amount: '50.00',
    reason: 'Partial refund',
    idempotencyKey: 'idem-1',
  };

  it('records a partial refund and leaves the payment CONFIRMED', async () => {
    repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.createRefund.mockResolvedValue({
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: d('50.00'),
      reason: 'Partial refund',
    });

    const result = await refundPayment(FINANCE, input);

    expect(result.refund).toEqual(expect.objectContaining({ id: 'refund-1' }));
    expect(result.payment.status).toBe('CONFIRMED');
    expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
  });

  it('transitions the payment to REFUNDED once cumulative refunds equal the full amount', async () => {
    repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('100.00'));
    repositoryMocks.createRefund.mockResolvedValue({
      id: 'refund-2',
      paymentId: 'payment-1',
      amount: d('50.00'),
      reason: 'Final refund',
    });
    repositoryMocks.transitionPaymentStatus.mockResolvedValue({
      id: 'payment-1',
      status: 'REFUNDED',
    });

    const result = await refundPayment(FINANCE, { ...input, reason: 'Final refund' });

    expect(result.payment.status).toBe('REFUNDED');
    expect(repositoryMocks.transitionPaymentStatus).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ newStatus: 'REFUNDED', idempotencyKey: 'idem-1' }),
    );
  });

  it('rejects a refund that would exceed the remaining unrefunded amount', async () => {
    repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('120.00'));

    await expectPaymentError(refundPayment(FINANCE, input), 'REFUND_EXCEEDS_REMAINING');
    expect(repositoryMocks.createRefund).not.toHaveBeenCalled();
  });

  it('rejects refunding a payment that is not CONFIRMED', async () => {
    repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'PENDING',
      amount: d('150.00'),
    });

    await expectPaymentError(refundPayment(FINANCE, input), 'INVALID_PAYMENT_TRANSITION');
  });

  it('is idempotent by key', async () => {
    repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue({
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: d('50.00'),
      reason: 'Partial refund',
      allocationId: null,
    });
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });

    const result = await refundPayment(FINANCE, input);
    expect(result.refund).toEqual({
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: d('50.00'),
      reason: 'Partial refund',
    });
    expect(repositoryMocks.createRefund).not.toHaveBeenCalled();
  });

  it.each([
    ['a different payment', { paymentId: 'other-payment' }],
    ['a different amount', { amount: d('20.00') }],
    ['a different allocation', { allocationId: 'alloc-9' }],
  ])('rejects a replayed key recorded for %s', async (_label, override) => {
    repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue({
      id: 'refund-1',
      paymentId: 'payment-1',
      amount: d('50.00'),
      reason: 'Partial refund',
      allocationId: null,
      ...override,
    });

    await expectPaymentError(refundPayment(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
    expect(repositoryMocks.createRefund).not.toHaveBeenCalled();
  });

  it('rejects a key already held by another status transition', async () => {
    repositoryMocks.findStatusHistoryByIdempotencyKey.mockResolvedValue({
      paymentId: 'payment-1',
      newStatus: 'CONFIRMED',
    });

    await expectPaymentError(refundPayment(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
    expect(repositoryMocks.createRefund).not.toHaveBeenCalled();
  });

  it("rejects an unlinked refund larger than this payment's own unallocated credit (D-054 §17 Rule 2)", async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    // 150.00 paid, 120.00 of it allocated: only 30.00 of this payment is unallocated.
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('120.00'));

    await expectPaymentError(refundPayment(FINANCE, input), 'REFUND_EXCEEDS_REMAINING');
    expect(repositoryMocks.createRefund).not.toHaveBeenCalled();
  });

  it("never draws on another payment's credit: the booking-wide summary is not consulted", async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    // This payment is fully allocated; any booking credit belongs to other payments.
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('150.00'));

    await expectPaymentError(
      refundPayment(FINANCE, { ...input, amount: '10.00' }),
      'REFUND_EXCEEDS_REMAINING',
    );
    expect(repositoryMocks.findBookingPaymentSummaryData).not.toHaveBeenCalled();
    expect(repositoryMocks.createRefund).not.toHaveBeenCalled();
  });

  it('counts allocations net of their linked refunds when sizing an unlinked refund', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('100.00'),
    });
    // 30.00 already refunded through a 50.00 allocation: net contribution
    // 70.00, net active allocation 20.00, so 50.00 is unallocated.
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('30.00'));
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('20.00'));
    repositoryMocks.createRefund.mockResolvedValue({ id: 'refund-2', paymentId: 'payment-1' });

    await refundPayment(FINANCE, { ...input, amount: '50.00' });
    expect(repositoryMocks.createRefund).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ amount: '50.00', allocationId: undefined }),
    );
  });

  it('allows a refund linked to an allocation even when the payment has no unallocated credit', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.findAllocationForRefund.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      amount: d('150.00'),
      isReversed: false,
      refundAllocatedTotal: d('0.00'),
    });
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('150.00'));
    repositoryMocks.createRefund.mockResolvedValue({ id: 'refund-1', paymentId: 'payment-1' });

    await refundPayment(FINANCE, { ...input, allocationId: 'alloc-1' });
    expect(repositoryMocks.createRefund).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ allocationId: 'alloc-1', amount: '50.00' }),
    );
  });

  it('rejects the final refund while the payment still has unrefunded net active allocation', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('100.00'));
    repositoryMocks.findAllocationForRefund.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      amount: d('100.00'),
      isReversed: false,
      refundAllocatedTotal: d('0.00'),
    });
    // 100.00 allocated, none refunded through it yet; the last 50.00 would
    // make the Payment REFUNDED with 50.00 still allocated.
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('100.00'));

    await expectPaymentError(
      refundPayment(FINANCE, { ...input, allocationId: 'alloc-1' }),
      'REFUND_EXCEEDS_REMAINING',
    );
    expect(repositoryMocks.createRefund).not.toHaveBeenCalled();
    expect(repositoryMocks.transitionPaymentStatus).not.toHaveBeenCalled();
  });

  it('rejects a refund linked to a reversed allocation', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.findAllocationForRefund.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      amount: d('100.00'),
      isReversed: true,
      refundAllocatedTotal: d('0.00'),
    });

    await expectPaymentError(
      refundPayment(FINANCE, { ...input, allocationId: 'alloc-1' }),
      'ALLOCATION_NOT_PERMITTED',
    );
    expect(repositoryMocks.createRefund).not.toHaveBeenCalled();
  });

  it('rejects when the specified allocation would be refunded beyond its own remaining amount', async () => {
    repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.findAllocationForRefund.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      amount: d('40.00'),
      isReversed: false,
      refundAllocatedTotal: d('0.00'),
    });

    await expectPaymentError(
      refundPayment(FINANCE, { ...input, amount: '50.00', allocationId: 'alloc-1' }),
      'REFUND_EXCEEDS_REMAINING',
    );
  });

  it('rejects when the specified allocation does not belong to the payment', async () => {
    repositoryMocks.findRefundByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.findAllocationForRefund.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'other-payment',
      amount: d('100.00'),
      isReversed: false,
      refundAllocatedTotal: d('0.00'),
    });

    await expectPaymentError(
      refundPayment(FINANCE, { ...input, allocationId: 'alloc-1' }),
      'ALLOCATION_NOT_PERMITTED',
    );
  });
});

describe('issueReceipt', () => {
  const input = { paymentId: 'payment-1' };
  const preservedReceipt = {
    id: 'receipt-1',
    paymentId: 'payment-1',
    receiptNumber: 'r-1',
    amount: d('150.00'),
    currencyCode: 'PHP',
  };

  function paymentWithStatus(status: string) {
    return { id: 'payment-1', status, amount: d('150.00'), bookingId: 'booking-1' };
  }

  it('issues a new receipt for a CONFIRMED payment, returning the current status separately', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue(paymentWithStatus('CONFIRMED'));
    repositoryMocks.findReceiptByPaymentId.mockResolvedValue(null);
    repositoryMocks.findBookingCurrencyCode.mockResolvedValue('PHP');
    repositoryMocks.createReceipt.mockResolvedValue(preservedReceipt);

    const result = await issueReceipt(FINANCE, input);
    expect(result).toEqual({ receipt: preservedReceipt, paymentStatus: 'CONFIRMED' });
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.insertAuditLog).toHaveBeenCalledWith(
      TX_CLIENT,
      expect.objectContaining({ action: 'RECEIPT_ISSUED' }),
    );
  });

  it.each(['REFUNDED', 'REVERSED', 'PENDING'])(
    'refuses a NEW receipt when the payment is %s and has none yet (D-054 §17 Rule 3)',
    async (status) => {
      repositoryMocks.findPaymentForActor.mockResolvedValue(paymentWithStatus(status));
      repositoryMocks.findReceiptByPaymentId.mockResolvedValue(null);

      await expectPaymentError(issueReceipt(FINANCE, input), 'RECEIPT_NOT_PERMITTED');
      expect(repositoryMocks.createReceipt).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    },
  );

  it.each(['CONFIRMED', 'REFUNDED', 'REVERSED'])(
    'returns the preserved receipt unchanged on a repeat request when the payment is now %s',
    async (status) => {
      repositoryMocks.findPaymentForActor.mockResolvedValue(paymentWithStatus(status));
      repositoryMocks.findReceiptByPaymentId.mockResolvedValue(preservedReceipt);

      const result = await issueReceipt(FINANCE, input);
      expect(result).toEqual({ receipt: preservedReceipt, paymentStatus: status });
      expect(repositoryMocks.createReceipt).not.toHaveBeenCalled();
      expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
    },
  );

  it('answers a lost Receipt.paymentId race with the winner receipt and current status, re-checking assignment and writing nothing', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue(paymentWithStatus('CONFIRMED'));
    repositoryMocks.findReceiptByPaymentId
      .mockResolvedValueOnce(null) // inside the losing transaction
      .mockResolvedValueOnce(preservedReceipt); // after it rolled back
    repositoryMocks.findBookingCurrencyCode.mockResolvedValue('PHP');
    repositoryMocks.createReceipt.mockRejectedValue(
      adapterUniqueViolation('Receipt', ['paymentId']),
    );

    const result = await issueReceipt(FINANCE, input);

    expect(result).toEqual({ receipt: preservedReceipt, paymentStatus: 'CONFIRMED' });
    expect(repositoryMocks.findPaymentForActor).toHaveBeenCalledTimes(2);
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('does not treat a receiptNumber collision as the paymentId race', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue(paymentWithStatus('CONFIRMED'));
    repositoryMocks.findReceiptByPaymentId.mockResolvedValue(null);
    repositoryMocks.findBookingCurrencyCode.mockResolvedValue('PHP');
    repositoryMocks.createReceipt.mockRejectedValue(
      adapterUniqueViolation('Receipt', ['receiptNumber']),
    );

    await expectPaymentError(issueReceipt(FINANCE, input), 'RECEIPT_NOT_PERMITTED');
    expect(repositoryMocks.findReceiptByPaymentId).toHaveBeenCalledTimes(1);
  });

  it('maps exhausted write-conflict retries to RECEIPT_NOT_PERMITTED (try again), never a raw error', async () => {
    transactionMock.mockImplementation(async () => {
      throw rawAdapterWriteConflict();
    });

    await expectPaymentError(issueReceipt(FINANCE, input), 'RECEIPT_NOT_PERMITTED');
    expect(transactionMock).toHaveBeenCalledTimes(3);
  });

  it('checks assignment before reading any receipt', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue(null);

    await expectPaymentError(issueReceipt(FINANCE, input), 'PAYMENT_FORBIDDEN');
    expect(repositoryMocks.findReceiptByPaymentId).not.toHaveBeenCalled();
  });
});

describe('createAllocation', () => {
  const input = {
    paymentId: 'payment-1',
    installmentId: 'inst-1',
    amount: '50.00',
    idempotencyKey: 'idem-1',
  };

  it('creates an allocation within the payment net contribution and an approved plan', async () => {
    repositoryMocks.findAllocationByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-1',
      amount: d('100.00'),
      planApprovedAt: new Date(),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.createAllocation.mockResolvedValue({ id: 'alloc-1' });

    const result = await createAllocation(FINANCE, input);
    expect(result).toEqual({ id: 'alloc-1' });
  });

  it('rejects when the installment plan is not yet approved (D-054 §4 decided invariant)', async () => {
    repositoryMocks.findAllocationByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-1',
      amount: d('100.00'),
      planApprovedAt: null,
    });

    await expectPaymentError(createAllocation(FINANCE, input), 'ALLOCATION_NOT_PERMITTED');
    expect(repositoryMocks.createAllocation).not.toHaveBeenCalled();
  });

  it('rejects when the payment and installment belong to different bookings', async () => {
    repositoryMocks.findAllocationByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-2',
      amount: d('100.00'),
      planApprovedAt: new Date(),
    });

    await expectPaymentError(createAllocation(FINANCE, input), 'ALLOCATION_NOT_PERMITTED');
  });

  it('rejects an allocation larger than the installment remaining capacity, writing nothing (D-054 §17 Rule 5)', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-1',
      amount: d('100.00'),
      planApprovedAt: new Date(),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    // 60.00 of the 100.00 installment is already covered: 40.00 remains.
    repositoryMocks.sumNetActiveAllocationsForInstallment.mockResolvedValue(d('60.00'));

    await expectPaymentError(
      createAllocation(FINANCE, { ...input, amount: '40.01' }),
      'ALLOCATION_NOT_PERMITTED',
    );
    expect(repositoryMocks.sumNetActiveAllocationsForInstallment).toHaveBeenCalledWith(
      TX_CLIENT,
      'inst-1',
    );
    expect(repositoryMocks.createAllocation).not.toHaveBeenCalled();
    expect(repositoryMocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it('allows an allocation that exactly fills the installment remaining capacity', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-1',
      amount: d('100.00'),
      planApprovedAt: new Date(),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.sumNetActiveAllocationsForInstallment.mockResolvedValue(d('60.00'));
    repositoryMocks.createAllocation.mockResolvedValue({ id: 'alloc-9' });

    await expect(createAllocation(FINANCE, { ...input, amount: '40.00' })).resolves.toEqual({
      id: 'alloc-9',
    });
  });

  it('rejects when the allocation would exceed the payment net contribution', async () => {
    repositoryMocks.findAllocationByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('40.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-1',
      amount: d('100.00'),
      planApprovedAt: new Date(),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('0.00'));

    // net contribution is 40.00; allocating 50.00 exceeds it
    await expectPaymentError(createAllocation(FINANCE, input), 'ALLOCATION_NOT_PERMITTED');
    expect(repositoryMocks.createAllocation).not.toHaveBeenCalled();
  });

  it('measures existing allocations net of their linked refunds (D-054 §17 Rule 2)', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('100.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-1',
      amount: d('100.00'),
      planApprovedAt: new Date(),
    });
    // 50.00 allocated with 30.00 refunded through it: net contribution
    // 70.00, net active allocation 20.00. A gross count (50.00) would
    // wrongly refuse this 50.00 allocation.
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('30.00'));
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('20.00'));
    repositoryMocks.createAllocation.mockResolvedValue({ id: 'alloc-2' });

    await expect(createAllocation(FINANCE, input)).resolves.toEqual({ id: 'alloc-2' });
  });

  it('rejects allocating against a non-CONFIRMED/REFUNDED payment (net contribution is zero)', async () => {
    repositoryMocks.findAllocationByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'PENDING',
      amount: d('150.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-1',
      amount: d('100.00'),
      planApprovedAt: new Date(),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.sumNetActiveAllocationsForPayment.mockResolvedValue(d('0.00'));

    await expectPaymentError(createAllocation(FINANCE, input), 'ALLOCATION_NOT_PERMITTED');
  });

  it('is idempotent by key', async () => {
    const existing = {
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: d('50.00'),
    };
    repositoryMocks.findAllocationByIdempotencyKey.mockResolvedValue(existing);
    repositoryMocks.findPaymentForActor.mockResolvedValue({ id: 'payment-1' });
    const result = await createAllocation(FINANCE, input);
    expect(result).toEqual(existing);
    expect(repositoryMocks.createAllocation).not.toHaveBeenCalled();
  });

  it('rejects a replayed key recorded for a different installment', async () => {
    repositoryMocks.findAllocationByIdempotencyKey.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-2',
      amount: d('50.00'),
    });
    await expectPaymentError(createAllocation(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
  });

  it('gives a missing installment the same error as one on another booking', async () => {
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.findInstallmentForAllocation.mockResolvedValue(null);
    const missing = await createAllocation(FINANCE, input).catch((error: unknown) => error);

    repositoryMocks.findInstallmentForAllocation.mockResolvedValue({
      id: 'inst-1',
      bookingId: 'booking-2',
      amount: d('100.00'),
      planApprovedAt: new Date(),
    });
    const otherBooking = await createAllocation(FINANCE, input).catch((error: unknown) => error);

    expect(missing).toBeInstanceOf(PaymentError);
    expect(otherBooking).toBeInstanceOf(PaymentError);
    expect((missing as PaymentError).code).toBe('ALLOCATION_NOT_PERMITTED');
    expect((otherBooking as PaymentError).message).toBe((missing as PaymentError).message);
  });
});

describe('reverseAllocation', () => {
  const input = { allocationId: 'alloc-1', reason: 'Misallocated', idempotencyKey: 'idem-1' };

  it('reverses an allocation with no refund allocated against it', async () => {
    repositoryMocks.findAllocationReversalByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findAllocationForReversal.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: d('50.00'),
      hasReversal: false,
      hasRefundAllocation: false,
    });
    repositoryMocks.findPaymentForActor.mockResolvedValue({ id: 'payment-1' });
    repositoryMocks.createAllocationReversal.mockResolvedValue({
      id: 'reversal-1',
      paymentAllocationId: 'alloc-1',
    });

    const result = await reverseAllocation(FINANCE, input);
    expect(result).toEqual({ id: 'reversal-1', paymentAllocationId: 'alloc-1' });
  });

  it('rejects reversing an allocation that already has a refund allocated against it', async () => {
    repositoryMocks.findAllocationReversalByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findAllocationForReversal.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: d('50.00'),
      hasReversal: false,
      hasRefundAllocation: true,
    });
    repositoryMocks.findPaymentForActor.mockResolvedValue({ id: 'payment-1' });

    await expectPaymentError(
      reverseAllocation(FINANCE, input),
      'ALLOCATION_REVERSAL_NOT_PERMITTED',
    );
    expect(repositoryMocks.createAllocationReversal).not.toHaveBeenCalled();
  });

  it('rejects reversing an allocation that has already been reversed', async () => {
    repositoryMocks.findAllocationReversalByIdempotencyKey.mockResolvedValue(null);
    repositoryMocks.findAllocationForReversal.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: d('50.00'),
      hasReversal: true,
      hasRefundAllocation: false,
    });
    repositoryMocks.findPaymentForActor.mockResolvedValue({ id: 'payment-1' });

    await expectPaymentError(
      reverseAllocation(FINANCE, input),
      'ALLOCATION_REVERSAL_NOT_PERMITTED',
    );
  });

  it('is idempotent by key, re-checking the actor can still see the payment', async () => {
    repositoryMocks.findAllocationReversalByIdempotencyKey.mockResolvedValue({
      id: 'reversal-1',
      paymentAllocationId: 'alloc-1',
    });
    repositoryMocks.findAllocationForReversal.mockResolvedValue({
      id: 'alloc-1',
      paymentId: 'payment-1',
      installmentId: 'inst-1',
      amount: d('50.00'),
      hasReversal: true,
      hasRefundAllocation: false,
    });
    repositoryMocks.findPaymentForActor.mockResolvedValue({ id: 'payment-1' });
    const result = await reverseAllocation(FINANCE, input);
    expect(result).toEqual({ id: 'reversal-1', paymentAllocationId: 'alloc-1' });
    expect(repositoryMocks.createAllocationReversal).not.toHaveBeenCalled();
  });

  it('rejects a replayed key recorded for a different allocation', async () => {
    repositoryMocks.findAllocationReversalByIdempotencyKey.mockResolvedValue({
      id: 'reversal-1',
      paymentAllocationId: 'alloc-2',
    });
    await expectPaymentError(reverseAllocation(FINANCE, input), 'IDEMPOTENCY_KEY_CONFLICT');
  });

  it('reports a missing allocation as PAYMENT_FORBIDDEN, the same as an unassigned one', async () => {
    repositoryMocks.findAllocationForReversal.mockResolvedValue(null);
    await expectPaymentError(reverseAllocation(FINANCE, input), 'PAYMENT_FORBIDDEN');
  });
});

describe('getBookingPaymentSummaryForStaff', () => {
  const summaryData = {
    booking: {
      id: 'booking-1',
      clientId: 'client-1',
      totalAmount: d('500.00'),
      currencyCode: 'PHP',
    },
    plan: {
      id: 'plan-1',
      approvedByStaffUserId: 'finance-1',
      approvedAt: new Date('2026-09-01'),
      installments: [
        {
          id: 'inst-1',
          dueDate: new Date('2026-10-01'),
          amount: d('500.00'),
          allocations: [
            {
              id: 'alloc-1',
              paymentId: 'payment-1',
              amount: d('200.00'),
              isReversed: false,
              refundAllocatedTotal: d('0.00'),
              paymentStatus: 'CONFIRMED' as const,
            },
          ],
        },
      ],
    },
    payments: [
      {
        id: 'payment-1',
        amount: d('200.00'),
        status: 'CONFIRMED' as const,
        refundedTotal: d('0.00'),
        receipt: { receiptNumber: 'r-1', issuedAt: new Date('2026-09-02') },
      },
    ],
  };

  it('returns BOOKING_NOT_FOUND for ADMIN_MANAGER when the booking does not exist', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue(null);
    await expectPaymentError(
      getBookingPaymentSummaryForStaff(ADMIN_MANAGER, 'missing'),
      'BOOKING_NOT_FOUND',
    );
  });

  it('returns BOOKING_FORBIDDEN for an unassigned TRAVEL_CONSULTANT/FINANCE_ACCOUNTING', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue(null);
    await expectPaymentError(
      getBookingPaymentSummaryForStaff(TRAVEL_CONSULTANT, 'booking-1'),
      'BOOKING_FORBIDDEN',
    );
  });

  it('composes the summary using only calculations.ts formulas', async () => {
    repositoryMocks.findBookingFinancialsForActor.mockResolvedValue(summaryData.booking);
    repositoryMocks.findBookingPaymentSummaryData.mockResolvedValue(summaryData);

    const result = await getBookingPaymentSummaryForStaff(FINANCE, 'booking-1');

    expect(result.confirmedAmountPaid.toFixed(2)).toBe('200.00');
    expect(result.remainingBalance?.toFixed(2)).toBe('300.00');
    expect(result.planApproved).toBe(true);
    expect(result.installments[0]?.outstandingAmount.toFixed(2)).toBe('300.00');
    expect(result.installments[0]?.allocations).toEqual([
      {
        id: 'alloc-1',
        paymentId: 'payment-1',
        amount: d('200.00'),
        refundedAmount: d('0.00'),
        isReversed: false,
      },
    ]);
    expect(result.payments[0]?.receipt).toEqual({
      receiptNumber: 'r-1',
      issuedAt: new Date('2026-09-02'),
    });
  });
});

describe('getClientPaymentSummaries', () => {
  it('rejects a non-CLIENT actor', async () => {
    await expectPaymentError(
      getClientPaymentSummaries(ADMIN_MANAGER, 'client-1'),
      'ROLE_NOT_PERMITTED',
    );
  });

  it('rejects when the client does not own the requested clientId', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: false, status: 403 });
    await expectPaymentError(
      getClientPaymentSummaries(CLIENT_USER, 'client-1'),
      'BOOKING_FORBIDDEN',
    );
  });

  it('returns one summary per approved-plan booking only', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    repositoryMocks.findApprovedBookingIdsForClient.mockResolvedValue(['booking-1']);
    repositoryMocks.findBookingPaymentSummaryData.mockResolvedValue({
      booking: {
        id: 'booking-1',
        clientId: 'client-1',
        totalAmount: d('500.00'),
        currencyCode: 'PHP',
      },
      plan: null,
      payments: [],
    });

    const result = await getClientPaymentSummaries(CLIENT_USER, 'client-1');
    expect(result).toHaveLength(1);
    expect(result[0]?.bookingId).toBe('booking-1');
  });

  it('shows installment balances and receipts but never staff-internal allocation records', async () => {
    authorizationMocks.canAccessClient.mockResolvedValue({ allowed: true });
    repositoryMocks.findApprovedBookingIdsForClient.mockResolvedValue(['booking-1']);
    const data = summaryDataFor({
      paymentAmount: '150.00',
      refunded: '0.00',
      allocations: [{ id: 'alloc-1', amount: '100.00', refundAllocated: '0.00' }],
    });
    data.payments[0]!.receipt = { receiptNumber: 'r-1', issuedAt: new Date('2026-09-02') };
    repositoryMocks.findBookingPaymentSummaryData.mockResolvedValue(data);

    const [summary] = await getClientPaymentSummaries(CLIENT_USER, 'client-1');
    expect(summary?.installments[0]).toEqual({
      id: 'inst-1',
      dueDate: new Date('2026-10-01'),
      amount: d('500.00'),
      outstandingAmount: d('400.00'),
    });
    expect(summary?.installments[0]).not.toHaveProperty('allocations');
    expect(summary?.payments[0]?.receipt?.receiptNumber).toBe('r-1');
  });
});

describe('money-changing operations refuse every role except Finance/Accounting', () => {
  const PAYMENT_ID = '00000000-0000-4000-8000-000000000001';
  const OTHER_ID = '00000000-0000-4000-8000-000000000002';
  const operations: [string, (actor: AuthenticatedUser) => Promise<unknown>][] = [
    ['approvePaymentPlan', (actor) => approvePaymentPlan(actor, { paymentPlanId: PAYMENT_ID })],
    [
      'recordPayment',
      (actor) =>
        recordPayment(actor, { bookingId: OTHER_ID, amount: '10.00', idempotencyKey: 'k' }),
    ],
    [
      'confirmPayment',
      (actor) =>
        confirmPayment(actor, { paymentId: PAYMENT_ID, reason: 'Verified', idempotencyKey: 'k' }),
    ],
    [
      'reversePayment',
      (actor) =>
        reversePayment(actor, { paymentId: PAYMENT_ID, reason: 'Wrong', idempotencyKey: 'k' }),
    ],
    [
      'refundPayment',
      (actor) =>
        refundPayment(actor, {
          paymentId: PAYMENT_ID,
          amount: '10.00',
          reason: 'Refund',
          idempotencyKey: 'k',
        }),
    ],
    ['issueReceipt', (actor) => issueReceipt(actor, { paymentId: PAYMENT_ID })],
    [
      'createAllocation',
      (actor) =>
        createAllocation(actor, {
          paymentId: PAYMENT_ID,
          installmentId: OTHER_ID,
          amount: '10.00',
          idempotencyKey: 'k',
        }),
    ],
    [
      'reverseAllocation',
      (actor) =>
        reverseAllocation(actor, { allocationId: OTHER_ID, reason: 'Wrong', idempotencyKey: 'k' }),
    ],
  ];
  const deniedActors = [TRAVEL_CONSULTANT, ADMIN_MANAGER, VISA, CLIENT_USER];

  it.each(
    operations.flatMap(([name, run]) =>
      deniedActors.map((actor) => [name, actor.role, run, actor] as const),
    ),
  )('%s refuses %s before any database access', async (_name, _role, run, actor) => {
    await expectPaymentError(run(actor), 'ROLE_NOT_PERMITTED');
    expect(transactionMock).not.toHaveBeenCalled();
    for (const mock of Object.values(repositoryMocks)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});

describe('CHECK-constraint violations from payment writes stay generic errors (D-055)', () => {
  // A CHECK violation exactly as the adapter reports it (Postgres 23514),
  // mirroring lib/prisma-errors.test.ts's `rawCheckViolation`.
  function rawCheckViolation(): Error {
    const message = 'new row for relation "payment" violates check constraint "some_check"';
    return Object.assign(new Error(message), {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23514',
        originalMessage: message,
        kind: 'postgres',
        detail: 'Failing row contains (private-client-value).',
      },
    });
  }

  it('confirmPayment propagates the violation unchanged, never as a PaymentError or a retry', async () => {
    const violation = rawCheckViolation();
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'PENDING',
      amount: d('150.00'),
    });
    repositoryMocks.transitionPaymentStatus.mockRejectedValue(violation);

    const promise = confirmPayment(FINANCE, {
      paymentId: 'payment-1',
      reason: 'Verified',
      idempotencyKey: 'idem-1',
    });
    await expect(promise).rejects.toBe(violation);
    await expect(promise).rejects.not.toBeInstanceOf(PaymentError);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('refundPayment propagates the violation unchanged, never as a PaymentError or a retry', async () => {
    const violation = rawCheckViolation();
    repositoryMocks.findPaymentForActor.mockResolvedValue({
      id: 'payment-1',
      status: 'CONFIRMED',
      amount: d('150.00'),
    });
    repositoryMocks.sumRefundsForPayment.mockResolvedValue(d('0.00'));
    repositoryMocks.createRefund.mockRejectedValue(violation);

    const promise = refundPayment(FINANCE, {
      paymentId: 'payment-1',
      amount: '50.00',
      reason: 'Partial cancellation',
      idempotencyKey: 'idem-1',
    });
    await expect(promise).rejects.toBe(violation);
    await expect(promise).rejects.not.toBeInstanceOf(PaymentError);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
