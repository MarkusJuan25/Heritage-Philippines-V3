import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/lib/auth/guards';

// Real-PostgreSQL integration coverage for D-054 Stage 2 (D-054 §11's Stage
// 2 validation requirement): the exact D-019 formulas, status-transition
// terminal states, idempotent retries, allocation-reversal restrictions, and
// unapplied-credit computation, all proven against a real database with real
// foreign-key/CHECK/unique constraints — every mocked test elsewhere in this
// feature (schemas.test.ts, calculations.test.ts, repository.test.ts,
// service.test.ts, audit.test.ts, errors.test.ts) intentionally mocks Prisma
// and cannot prove this.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/bookings/service.integration.test.ts and every other existing
// integration suite in this repository — see that file's own doc comment for
// the full rationale. In short: no `@/lib/db` or `./service` static import;
// everything real is imported dynamically inside `beforeAll` only after
// `TEST_DATABASE_URL` has been validated; the suite is
// `describe.skipIf`-skipped entirely (no import, no connection) whenever
// `TEST_DATABASE_URL` is unset, which is the default for `pnpm test` today.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

/**
 * Parses and validates `TEST_DATABASE_URL` without ever interpolating the
 * raw connection string into a thrown message — a deliberate, self-contained
 * copy of the identical guard established in every other feature's own
 * service.integration.test.ts, not a shared import, matching those files'
 * own precedent.
 */
function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the payments integration suite.',
    );
  }

  if (!ALLOWED_TEST_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `TEST_DATABASE_URL must use the postgresql:// or postgres:// protocol (got "${parsed.protocol}"). Refusing to proceed.`,
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_TEST_HOSTNAMES.has(hostname)) {
    throw new Error(
      `TEST_DATABASE_URL hostname must be localhost, 127.0.0.1, or ::1 (got "${hostname}"). Refusing to run against a non-local host.`,
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName !== REQUIRED_TEST_DATABASE_NAME) {
    throw new Error(
      `TEST_DATABASE_URL must target the "${REQUIRED_TEST_DATABASE_NAME}" database (got "${databaseName || '(empty)'}"). Refusing to run against any other database, including heritage_v3_dev.`,
    );
  }

  if (!parsed.username) {
    throw new Error('TEST_DATABASE_URL must include a non-empty username. Refusing to proceed.');
  }
}

const rawTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasTestDatabaseUrl = typeof rawTestDatabaseUrl === 'string' && rawTestDatabaseUrl.length > 0;

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
const originalRateLimitSecret = process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;

describe.skipIf(!hasTestDatabaseUrl)('payments service integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let proposePaymentPlan: (typeof import('./service'))['proposePaymentPlan'];
  let approvePaymentPlan: (typeof import('./service'))['approvePaymentPlan'];
  let recordPayment: (typeof import('./service'))['recordPayment'];
  let confirmPayment: (typeof import('./service'))['confirmPayment'];
  let reversePayment: (typeof import('./service'))['reversePayment'];
  let refundPayment: (typeof import('./service'))['refundPayment'];
  let createAllocation: (typeof import('./service'))['createAllocation'];
  let reverseAllocation: (typeof import('./service'))['reverseAllocation'];
  let issueReceipt: (typeof import('./service'))['issueReceipt'];
  let getBookingPaymentSummaryForStaff: (typeof import('./service'))['getBookingPaymentSummaryForStaff'];
  let getClientPaymentSummaries: (typeof import('./service'))['getClientPaymentSummaries'];
  let PaymentError: (typeof import('./errors'))['PaymentError'];
  let createProposal: (typeof import('@/features/proposals/service'))['createProposal'];
  let publishProposalVersion: (typeof import('@/features/proposals/service'))['publishProposalVersion'];
  let recordProposalResponse: (typeof import('@/features/proposals/service'))['recordProposalResponse'];
  let createBooking: (typeof import('@/features/bookings/service'))['createBooking'];

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;
  let financeActor: AuthenticatedUser;
  let unassignedTcActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;
  const actorUserIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdProposalIds: string[] = [];
  const createdBookingIds: string[] = [];

  beforeAll(async () => {
    validateTestDatabaseUrl(rawTestDatabaseUrl!);

    process.env.DATABASE_URL = rawTestDatabaseUrl;
    if (!process.env.BETTER_AUTH_SECRET) {
      process.env.BETTER_AUTH_SECRET =
        'integration-test-only-secret-not-a-real-credential-0000000000';
      didSetBetterAuthSecret = true;
    }
    if (!process.env.BETTER_AUTH_URL) {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      didSetBetterAuthUrl = true;
    }
    if (!process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET) {
      process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET =
        'integration-test-only-rl-secret-not-a-real-credential-00000000';
      didSetRateLimitSecret = true;
    }

    ({ prisma } = await import('@/lib/db'));
    ({
      proposePaymentPlan,
      approvePaymentPlan,
      recordPayment,
      confirmPayment,
      reversePayment,
      refundPayment,
      createAllocation,
      reverseAllocation,
      issueReceipt,
      getBookingPaymentSummaryForStaff,
      getClientPaymentSummaries,
    } = await import('./service'));
    ({ PaymentError } = await import('./errors'));
    ({ createProposal, publishProposalVersion, recordProposalResponse } =
      await import('@/features/proposals/service'));
    ({ createBooking } = await import('@/features/bookings/service'));

    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    if (rows[0]?.current_database !== REQUIRED_TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to proceed: the connected database reports current_database() = "${rows[0]?.current_database}", not "${REQUIRED_TEST_DATABASE_NAME}".`,
      );
    }

    async function createStaffFixture(
      role: 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' | 'FINANCE_ACCOUNTING',
    ): Promise<AuthenticatedUser> {
      const id = randomUUID();
      const email = `payments-integration-${role.toLowerCase()}-${randomUUID()}@example.test`;
      const name = `Integration ${role}`;
      await prisma!.user.create({ data: { id, name, email, role, isActive: true } });
      actorUserIds.push(id);
      return { id, name, email, role };
    }

    adminActor = await createStaffFixture('ADMIN_MANAGER');
    tcActor = await createStaffFixture('TRAVEL_CONSULTANT');
    financeActor = await createStaffFixture('FINANCE_ACCOUNTING');
    unassignedTcActor = await createStaffFixture('TRAVEL_CONSULTANT');
  });

  afterAll(async () => {
    try {
      if (prisma) {
        try {
          await prisma.receipt.deleteMany({ where: { issuedByStaffUserId: { in: actorUserIds } } });
          await prisma.paymentRefundAllocation.deleteMany({
            where: { paymentRefund: { performedByStaffUserId: { in: actorUserIds } } },
          });
          await prisma.paymentRefund.deleteMany({
            where: { performedByStaffUserId: { in: actorUserIds } },
          });
          await prisma.paymentAllocationReversal.deleteMany({
            where: { reversedByStaffUserId: { in: actorUserIds } },
          });
          await prisma.paymentAllocation.deleteMany({
            where: { allocatedByStaffUserId: { in: actorUserIds } },
          });
          await prisma.paymentStatusHistory.deleteMany({
            where: { changedByUserId: { in: actorUserIds } },
          });
          await prisma.payment.deleteMany({ where: { clientId: { in: createdClientIds } } });
          await prisma.installment.deleteMany({
            where: { paymentPlan: { clientId: { in: createdClientIds } } },
          });
          await prisma.paymentPlan.deleteMany({ where: { clientId: { in: createdClientIds } } });
          await prisma.auditLog.deleteMany({ where: { actorId: { in: actorUserIds } } });
          await prisma.staffAssignment.deleteMany({
            where: {
              OR: [
                { clientId: { in: createdClientIds } },
                { bookingId: { in: createdBookingIds } },
                { assignedStaffId: { in: actorUserIds } },
                { assignedByUserId: { in: actorUserIds } },
              ],
            },
          });
          // Every Booking created via `createBooking` (features/bookings)
          // writes an initial BookingStatusHistory row; that table's FK is
          // `onDelete: Restrict`, so it must be cleared before the Booking
          // itself can be deleted below.
          await prisma.bookingStatusHistory.deleteMany({
            where: { bookingId: { in: createdBookingIds } },
          });
          await prisma.booking.deleteMany({ where: { id: { in: createdBookingIds } } });
          await prisma.proposalAcceptance.deleteMany({
            where: { proposalVersion: { proposal: { clientId: { in: createdClientIds } } } },
          });
          await prisma.proposalVersion.deleteMany({
            where: { proposal: { clientId: { in: createdClientIds } } },
          });
          await prisma.proposal.deleteMany({ where: { clientId: { in: createdClientIds } } });
          await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
          await prisma.user.deleteMany({ where: { id: { in: actorUserIds } } });
        } finally {
          await prisma.$disconnect();
        }
      }
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
      if (didSetBetterAuthSecret) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
      if (didSetBetterAuthUrl) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
      if (didSetRateLimitSecret) delete process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;
      else process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET = originalRateLimitSecret;
    }
  });

  async function createClientFixture(): Promise<{ id: string }> {
    const id = randomUUID();
    await prisma!.client.create({
      data: {
        id,
        fullName: `Payments Fixture Client ${randomUUID()}`,
        email: `payments-integration-${randomUUID()}@example.test`,
      },
    });
    createdClientIds.push(id);
    return { id };
  }

  /**
   * A real Booking, with `totalAmount`/`currencyCode` set (D-019's own
   * creation-order invariant — no service in this repository populates
   * these yet, so this fixture sets them directly, exactly as
   * features/bookings/service.integration.test.ts's own
   * `createAcceptedProposalVersionFixture` builds its Booking prerequisite
   * chain via the real, unmodified `createProposal` ->
   * `publishProposalVersion` -> `recordProposalResponse('ACCEPT')` ->
   * `createBooking` chain), and a booking-level StaffAssignment for both
   * `tcActor` and `financeActor` (this feature's own booking-level
   * assignment model, repository.ts's `bookingAssignmentFilter`).
   */
  async function createAssignedBookingFixture(totalAmount = '500.00'): Promise<{
    bookingId: string;
    clientId: string;
  }> {
    const client = await createClientFixture();
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: tcActor.id,
        assignedByUserId: adminActor.id,
        role: 'TRAVEL_CONSULTANT',
        clientId: client.id,
      },
    });

    const { proposal, version } = await createProposal(tcActor, {
      clientId: client.id,
      content: `Payments fixture proposal content ${randomUUID()}.`,
    });
    createdProposalIds.push(proposal.id);
    await publishProposalVersion(tcActor, version.id, { expectedCurrentVersionId: null });
    await recordProposalResponse(adminActor, version.id, {
      responseType: 'ACCEPT',
      respondedAt: new Date().toISOString(),
      responseMethod: 'phone',
      evidenceReference: `Payments fixture evidence ${randomUUID()}`,
    });

    const { booking } = await createBooking(tcActor, { proposalVersionId: version.id });
    createdBookingIds.push(booking.id);

    await prisma!.booking.update({
      where: { id: booking.id },
      data: { totalAmount, currencyCode: 'PHP' },
    });

    // D-054 Stage 2 amendment: two concurrent active Booking-level
    // assignments, one per role, are now possible because of the new
    // `staff_assignment_active_booking_role_key` partial unique index
    // (`(bookingId, role)`, replacing the old bare-`bookingId` one). Before
    // this amendment, the second insert below always failed the old
    // role-agnostic `staff_assignment_active_booking_key` unique index.
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: tcActor.id,
        assignedByUserId: adminActor.id,
        role: 'TRAVEL_CONSULTANT',
        bookingId: booking.id,
      },
    });
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: financeActor.id,
        assignedByUserId: adminActor.id,
        role: 'FINANCE_ACCOUNTING',
        bookingId: booking.id,
      },
    });

    return { bookingId: booking.id, clientId: client.id };
  }

  it('runs the full happy path: propose, approve, record, confirm, allocate — and the summary reflects D-019 formulas exactly', async () => {
    const { bookingId, clientId } = await createAssignedBookingFixture('500.00');

    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '200.00', dueDate: '2026-10-01' },
        { sequenceNumber: 2, isDeposit: false, amount: '300.00', dueDate: '2026-11-01' },
      ],
    });
    expect(plan.approvedAt).toBeNull();

    const approved = await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    expect(approved.approvedAt).not.toBeNull();

    const payment = await recordPayment(financeActor, { bookingId, amount: '200.00' });
    expect(payment.status).toBe('PENDING');

    const confirmed = await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified bank transfer receipt',
      idempotencyKey: randomUUID(),
    });
    expect(confirmed.status).toBe('CONFIRMED');

    const installments = await prisma!.installment.findMany({
      where: { paymentPlanId: plan.id },
      orderBy: { sequenceNumber: 'asc' },
    });
    const depositInstallment = installments[0]!;

    const allocation = await createAllocation(financeActor, {
      paymentId: payment.id,
      installmentId: depositInstallment.id,
      amount: '200.00',
      idempotencyKey: randomUUID(),
    });
    expect(allocation.amount.toFixed(2)).toBe('200.00');

    const summary = await getBookingPaymentSummaryForStaff(adminActor, bookingId);
    expect(summary.confirmedAmountPaid.toFixed(2)).toBe('200.00');
    expect(summary.remainingBalance?.toFixed(2)).toBe('300.00');
    expect(summary.unappliedCredit.toFixed(2)).toBe('0.00');
    expect(
      summary.installments
        .find((i) => i.id === depositInstallment.id)
        ?.outstandingAmount.toFixed(2),
    ).toBe('0.00');

    // No ClientProfile ownership link exists for this raw fixture — proves
    // canAccessClient truly gates this read. Matching this codebase's own
    // established client-portal convention (features/client-portal/service.ts:
    // an ownership rejection always throws — CLIENT_FORBIDDEN/BOOKING_FORBIDDEN
    // — never a silently empty result), getClientPaymentSummaries throws
    // rather than returning [].
    await expect(
      getClientPaymentSummaries(
        { id: clientId, email: 'unused@example.test', name: 'unused', role: 'CLIENT' },
        clientId,
      ),
    ).rejects.toMatchObject({ code: 'BOOKING_FORBIDDEN' });
  });

  it('computes unapplied Booking credit when a confirmed payment has no allocation yet', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
      ],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    const payment = await recordPayment(financeActor, { bookingId, amount: '150.00' });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });

    const summary = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summary.confirmedAmountPaid.toFixed(2)).toBe('150.00');
    expect(summary.unappliedCredit.toFixed(2)).toBe('150.00');
  });

  it('is idempotent under a real concurrent retry: two confirmPayment calls with the same key confirm exactly once', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const payment = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    const idempotencyKey = randomUUID();

    const [first, second] = await Promise.all([
      confirmPayment(financeActor, { paymentId: payment.id, reason: 'Verified', idempotencyKey }),
      confirmPayment(financeActor, { paymentId: payment.id, reason: 'Verified', idempotencyKey }),
    ]);

    expect(first.status).toBe('CONFIRMED');
    expect(second.status).toBe('CONFIRMED');

    const historyCount = await prisma!.paymentStatusHistory.count({
      where: { paymentId: payment.id, newStatus: 'CONFIRMED' },
    });
    expect(historyCount).toBe(1);
  });

  it('records a partial refund without changing status, then completes it to REFUNDED', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const payment = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });

    const partial = await refundPayment(financeActor, {
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Partial cancellation',
      idempotencyKey: randomUUID(),
    });
    expect(partial.payment.status).toBe('CONFIRMED');

    const summaryAfterPartial = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summaryAfterPartial.confirmedAmountPaid.toFixed(2)).toBe('60.00');

    const final = await refundPayment(financeActor, {
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Full cancellation of remainder',
      idempotencyKey: randomUUID(),
    });
    expect(final.payment.status).toBe('REFUNDED');

    const summaryAfterFull = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summaryAfterFull.confirmedAmountPaid.toFixed(2)).toBe('0.00');
  });

  it('reaches every terminal state and proves no further transition is possible from it', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const payment = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });
    await reversePayment(financeActor, {
      paymentId: payment.id,
      reason: 'Confirmed in error',
      idempotencyKey: randomUUID(),
    });

    await expect(
      reversePayment(financeActor, {
        paymentId: payment.id,
        reason: 'Again',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYMENT_TRANSITION' });

    await expect(
      refundPayment(financeActor, {
        paymentId: payment.id,
        amount: '10.00',
        reason: 'Should not work',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYMENT_TRANSITION' });

    await expect(
      confirmPayment(financeActor, {
        paymentId: payment.id,
        reason: 'Again',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYMENT_TRANSITION' });
  });

  it('rejects reversing an allocation once a refund has been allocated against it (D-019 default policy), against real CHECK constraints', async () => {
    const { bookingId } = await createAssignedBookingFixture('100.00');
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '100.00', dueDate: '2026-10-01' },
      ],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    const payment = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });

    const installment = await prisma!.installment.findFirstOrThrow({
      where: { paymentPlanId: plan.id },
    });
    const allocation = await createAllocation(financeActor, {
      paymentId: payment.id,
      installmentId: installment.id,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });

    await refundPayment(financeActor, {
      paymentId: payment.id,
      amount: '30.00',
      reason: 'Partial refund against allocation',
      idempotencyKey: randomUUID(),
      allocationId: allocation.id,
    });

    await expect(
      reverseAllocation(financeActor, {
        allocationId: allocation.id,
        reason: 'Attempted correction',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ALLOCATION_REVERSAL_NOT_PERMITTED' });
  });

  it('rejects reusing a confirmation key from one payment on another payment, leaving the second payment PENDING', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const first = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    const second = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    const idempotencyKey = randomUUID();

    await confirmPayment(financeActor, { paymentId: first.id, reason: 'Verified', idempotencyKey });

    await expect(
      confirmPayment(financeActor, { paymentId: second.id, reason: 'Verified', idempotencyKey }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    await expect(
      reversePayment(financeActor, { paymentId: first.id, reason: 'Wrong', idempotencyKey }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });

    const secondNow = await prisma!.payment.findUniqueOrThrow({ where: { id: second.id } });
    expect(secondNow.status).toBe('PENDING');
    const firstNow = await prisma!.payment.findUniqueOrThrow({ where: { id: first.id } });
    expect(firstNow.status).toBe('CONFIRMED');
  });

  it('keeps unapplied credit and net active allocation non-negative through unlinked and allocation-linked refunds (D-019 write-time guarantees)', async () => {
    const { bookingId } = await createAssignedBookingFixture('100.00');
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '100.00', dueDate: '2026-10-01' },
      ],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    const payment = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });
    const installment = await prisma!.installment.findFirstOrThrow({
      where: { paymentPlanId: plan.id },
    });
    const allocation = await createAllocation(financeActor, {
      paymentId: payment.id,
      installmentId: installment.id,
      amount: '60.00',
      idempotencyKey: randomUUID(),
    });

    // 40.00 unapplied credit: an unlinked 50.00 refund would take it to -10.00.
    await expect(
      refundPayment(financeActor, {
        paymentId: payment.id,
        amount: '50.00',
        reason: 'Too much from credit',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_REMAINING' });

    await refundPayment(financeActor, {
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Refund of unapplied credit',
      idempotencyKey: randomUUID(),
    });

    // Credit is now zero; the remaining 60.00 is allocated, so it can only
    // be refunded through that allocation.
    await expect(
      refundPayment(financeActor, {
        paymentId: payment.id,
        amount: '60.00',
        reason: 'Unlinked remainder',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_REMAINING' });

    const final = await refundPayment(financeActor, {
      paymentId: payment.id,
      amount: '60.00',
      reason: 'Remainder through its allocation',
      idempotencyKey: randomUUID(),
      allocationId: allocation.id,
    });
    expect(final.payment.status).toBe('REFUNDED');

    const summary = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summary.confirmedAmountPaid.toFixed(2)).toBe('0.00');
    expect(summary.unappliedCredit.toFixed(2)).toBe('0.00');
    expect(summary.installments[0]?.outstandingAmount.toFixed(2)).toBe('100.00');
    expect(summary.installments[0]?.allocations).toEqual([
      expect.objectContaining({ id: allocation.id, isReversed: false }),
    ]);
    expect(summary.installments[0]?.allocations[0]?.refundedAmount.toFixed(2)).toBe('60.00');
  });

  it('rejects linking a refund to a reversed allocation', async () => {
    const { bookingId } = await createAssignedBookingFixture('100.00');
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '100.00', dueDate: '2026-10-01' },
      ],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    const payment = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });
    const installment = await prisma!.installment.findFirstOrThrow({
      where: { paymentPlanId: plan.id },
    });
    const allocation = await createAllocation(financeActor, {
      paymentId: payment.id,
      installmentId: installment.id,
      amount: '50.00',
      idempotencyKey: randomUUID(),
    });
    await reverseAllocation(financeActor, {
      allocationId: allocation.id,
      reason: 'Misallocated',
      idempotencyKey: randomUUID(),
    });

    await expect(
      refundPayment(financeActor, {
        paymentId: payment.id,
        amount: '10.00',
        reason: 'Against a reversed allocation',
        idempotencyKey: randomUUID(),
        allocationId: allocation.id,
      }),
    ).rejects.toMatchObject({ code: 'ALLOCATION_NOT_PERMITTED' });
    expect(await prisma!.paymentRefund.count({ where: { paymentId: payment.id } })).toBe(0);
  });

  async function approvedSingleInstallmentBooking(total: string): Promise<{
    bookingId: string;
    installmentId: string;
  }> {
    const { bookingId } = await createAssignedBookingFixture(total);
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [{ sequenceNumber: 1, isDeposit: true, amount: total, dueDate: '2026-10-01' }],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    const installment = await prisma!.installment.findFirstOrThrow({
      where: { paymentPlanId: plan.id },
    });
    return { bookingId, installmentId: installment.id };
  }

  async function confirmedPayment(bookingId: string, amount: string): Promise<string> {
    const payment = await recordPayment(financeActor, { bookingId, amount });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });
    return payment.id;
  }

  it('limits allocation by the payment net of refunds linked to its allocations (D-054 §17 Rule 2)', async () => {
    const { bookingId, installmentId } = await approvedSingleInstallmentBooking('100.00');
    const paymentId = await confirmedPayment(bookingId, '100.00');
    const first = await createAllocation(financeActor, {
      paymentId,
      installmentId,
      amount: '50.00',
      idempotencyKey: randomUUID(),
    });
    await refundPayment(financeActor, {
      paymentId,
      amount: '30.00',
      reason: 'Partial refund through its allocation',
      idempotencyKey: randomUUID(),
      allocationId: first.id,
    });

    // Net contribution 70.00, net active allocation 20.00: 50.00 is still
    // unallocated. A gross count (50.00 allocated) would allow only 20.00.
    await createAllocation(financeActor, {
      paymentId,
      installmentId,
      amount: '50.00',
      idempotencyKey: randomUUID(),
    });
    await expect(
      createAllocation(financeActor, {
        paymentId,
        installmentId,
        amount: '0.01',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ALLOCATION_NOT_PERMITTED' });

    const summary = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summary.confirmedAmountPaid.toFixed(2)).toBe('70.00');
    expect(summary.unappliedCredit.toFixed(2)).toBe('0.00');
    expect(summary.installments[0]?.outstandingAmount.toFixed(2)).toBe('30.00');
  });

  it("refuses an unlinked refund that would draw on another payment's credit, even when the booking has credit", async () => {
    const { bookingId, installmentId } = await approvedSingleInstallmentBooking('200.00');
    const allocatedPaymentId = await confirmedPayment(bookingId, '100.00');
    const creditPaymentId = await confirmedPayment(bookingId, '100.00');
    await createAllocation(financeActor, {
      paymentId: allocatedPaymentId,
      installmentId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });

    // The booking has 100.00 unapplied credit, but all of it belongs to the
    // second payment.
    await expect(
      refundPayment(financeActor, {
        paymentId: allocatedPaymentId,
        amount: '10.00',
        reason: 'Unlinked refund from a fully allocated payment',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_REMAINING' });
    expect(await prisma!.paymentRefund.count({ where: { paymentId: allocatedPaymentId } })).toBe(0);

    await refundPayment(financeActor, {
      paymentId: creditPaymentId,
      amount: '10.00',
      reason: 'Unlinked refund from its own credit',
      idempotencyKey: randomUUID(),
    });
    const summary = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summary.unappliedCredit.toFixed(2)).toBe('90.00');
  });

  it('returns a preserved receipt unchanged after the payment is fully REFUNDED, writing nothing new (D-054 §17 Rule 3)', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const paymentId = await confirmedPayment(bookingId, '100.00');

    const issued = await issueReceipt(financeActor, { paymentId });
    expect(issued.paymentStatus).toBe('CONFIRMED');
    const original = await prisma!.receipt.findUniqueOrThrow({ where: { paymentId } });

    await refundPayment(financeActor, {
      paymentId,
      amount: '100.00',
      reason: 'Full refund',
      idempotencyKey: randomUUID(),
    });

    const repeat = await issueReceipt(financeActor, { paymentId });
    expect(repeat.paymentStatus).toBe('REFUNDED');
    expect(repeat.receipt).toEqual(issued.receipt);

    expect(await prisma!.receipt.count({ where: { paymentId } })).toBe(1);
    expect(await prisma!.receipt.findUniqueOrThrow({ where: { paymentId } })).toEqual(original);
    expect(
      await prisma!.auditLog.count({
        where: { action: 'RECEIPT_ISSUED', entityId: issued.receipt.id },
      }),
    ).toBe(1);
  });

  it('returns a preserved receipt unchanged after the payment is REVERSED', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const paymentId = await confirmedPayment(bookingId, '100.00');
    const issued = await issueReceipt(financeActor, { paymentId });

    await reversePayment(financeActor, {
      paymentId,
      reason: 'Confirmed in error',
      idempotencyKey: randomUUID(),
    });

    const repeat = await issueReceipt(financeActor, { paymentId });
    expect(repeat).toEqual({ receipt: issued.receipt, paymentStatus: 'REVERSED' });
    expect(await prisma!.receipt.count({ where: { paymentId } })).toBe(1);
    expect(
      await prisma!.auditLog.count({
        where: { action: 'RECEIPT_ISSUED', entityId: issued.receipt.id },
      }),
    ).toBe(1);
  });

  it('resolves concurrent issueReceipt requests to exactly one receipt and one audit entry, every caller receiving that same receipt (shared conflict retry, lib/serializable-transaction.ts)', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const paymentId = await confirmedPayment(bookingId, '100.00');

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => issueReceipt(financeActor, { paymentId })),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toEqual([]);
    const receiptIds = new Set(
      results.map(
        (result) =>
          (result as PromiseFulfilledResult<Awaited<ReturnType<typeof issueReceipt>>>).value.receipt
            .id,
      ),
    );
    expect(receiptIds.size).toBe(1);
    for (const result of results) {
      expect(
        (result as PromiseFulfilledResult<Awaited<ReturnType<typeof issueReceipt>>>).value
          .paymentStatus,
      ).toBe('CONFIRMED');
    }
    expect(await prisma!.receipt.count({ where: { paymentId } })).toBe(1);
    expect(
      await prisma!.auditLog.count({
        where: { action: 'RECEIPT_ISSUED', entityId: [...receiptIds][0]! },
      }),
    ).toBe(1);
  });

  it('refuses a new receipt once a payment without one is REFUNDED or REVERSED, but allows one while partially refunded', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');

    const refundedId = await confirmedPayment(bookingId, '100.00');
    await refundPayment(financeActor, {
      paymentId: refundedId,
      amount: '100.00',
      reason: 'Full refund',
      idempotencyKey: randomUUID(),
    });
    await expect(issueReceipt(financeActor, { paymentId: refundedId })).rejects.toMatchObject({
      code: 'RECEIPT_NOT_PERMITTED',
    });

    const reversedId = await confirmedPayment(bookingId, '100.00');
    await reversePayment(financeActor, {
      paymentId: reversedId,
      reason: 'Confirmed in error',
      idempotencyKey: randomUUID(),
    });
    await expect(issueReceipt(financeActor, { paymentId: reversedId })).rejects.toMatchObject({
      code: 'RECEIPT_NOT_PERMITTED',
    });

    expect(
      await prisma!.receipt.count({ where: { paymentId: { in: [refundedId, reversedId] } } }),
    ).toBe(0);

    const partialId = await confirmedPayment(bookingId, '100.00');
    await refundPayment(financeActor, {
      paymentId: partialId,
      amount: '40.00',
      reason: 'Partial refund',
      idempotencyKey: randomUUID(),
    });
    const partial = await issueReceipt(financeActor, { paymentId: partialId });
    expect(partial.paymentStatus).toBe('CONFIRMED');
    expect(partial.receipt.amount.toFixed(2)).toBe('100.00');
  });

  it('refuses a booking with neither total nor currency, writing nothing, and records one with both set, without any plan, later issuing its receipt (D-054 §17 Rule 4)', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');

    // D-019's booking_financials_pairing constraint, proven against the
    // real database: total and currency can only be set, or cleared,
    // together — a currency without a total (or the reverse) never exists.
    // Through @prisma/adapter-pg a CHECK violation surfaces as a raw
    // DriverAdapterError (Postgres 23514), not as Prisma's P2004.
    const pairingViolation = {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23514',
        originalMessage: expect.stringContaining('booking_financials_pairing'),
      },
    };
    await expect(
      prisma!.booking.update({ where: { id: bookingId }, data: { totalAmount: null } }),
    ).rejects.toMatchObject(pairingViolation);
    await expect(
      prisma!.booking.update({ where: { id: bookingId }, data: { currencyCode: null } }),
    ).rejects.toMatchObject(pairingViolation);
    const unchanged = await prisma!.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(unchanged.totalAmount?.toFixed(2)).toBe('500.00');
    expect(unchanged.currencyCode).toBe('PHP');

    await prisma!.booking.update({
      where: { id: bookingId },
      data: { totalAmount: null, currencyCode: null },
    });

    await expect(
      recordPayment(financeActor, { bookingId, amount: '100.00' }),
    ).rejects.toMatchObject({ code: 'BOOKING_CURRENCY_NOT_SET', status: 409 });
    expect(await prisma!.payment.count({ where: { bookingId } })).toBe(0);
    expect(
      await prisma!.auditLog.count({
        where: {
          actorId: financeActor.id,
          action: 'PAYMENT_RECORDED',
          afterState: { path: ['bookingId'], equals: bookingId },
        },
      }),
    ).toBe(0);

    await prisma!.booking.update({
      where: { id: bookingId },
      data: { totalAmount: '500.00', currencyCode: 'PHP' },
    });
    expect(await prisma!.paymentPlan.count({ where: { bookingId } })).toBe(0);
    const paymentId = await confirmedPayment(bookingId, '100.00');
    const receipt = await issueReceipt(financeActor, { paymentId });
    expect(receipt.receipt.currencyCode).toBe('PHP');
    expect(receipt.paymentStatus).toBe('CONFIRMED');
  });

  it("never lets an installment's net active allocation exceed its amount, leaving the excess as unapplied credit (D-054 §17 Rule 5)", async () => {
    const { bookingId, installmentId } = await approvedSingleInstallmentBooking('100.00');
    const paymentId = await confirmedPayment(bookingId, '150.00');

    await createAllocation(financeActor, {
      paymentId,
      installmentId,
      amount: '60.00',
      idempotencyKey: randomUUID(),
    });
    await expect(
      createAllocation(financeActor, {
        paymentId,
        installmentId,
        amount: '40.01',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ALLOCATION_NOT_PERMITTED' });
    await createAllocation(financeActor, {
      paymentId,
      installmentId,
      amount: '40.00',
      idempotencyKey: randomUUID(),
    });
    await expect(
      createAllocation(financeActor, {
        paymentId,
        installmentId,
        amount: '0.01',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ALLOCATION_NOT_PERMITTED' });

    const summary = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summary.installments[0]?.outstandingAmount.toFixed(2)).toBe('0.00');
    expect(summary.unappliedCredit.toFixed(2)).toBe('50.00');
    expect(await prisma!.paymentAllocation.count({ where: { installmentId } })).toBe(2);
  });

  it('reopens installment capacity only through a linked refund, an allocation reversal, or a payment reversal', async () => {
    const { bookingId, installmentId } = await approvedSingleInstallmentBooking('100.00');
    const creditPaymentId = await confirmedPayment(bookingId, '100.00');
    const allocateFromCredit = (amount: string) =>
      createAllocation(financeActor, {
        paymentId: creditPaymentId,
        installmentId,
        amount,
        idempotencyKey: randomUUID(),
      });

    // Fill the installment from a second payment, then prove it is full.
    const fillingPaymentId = await confirmedPayment(bookingId, '100.00');
    const filling = await createAllocation(financeActor, {
      paymentId: fillingPaymentId,
      installmentId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
    await expect(allocateFromCredit('0.01')).rejects.toMatchObject({
      code: 'ALLOCATION_NOT_PERMITTED',
    });

    // 1. A refund linked to the allocation reopens exactly its amount.
    await refundPayment(financeActor, {
      paymentId: fillingPaymentId,
      amount: '10.00',
      reason: 'Partial refund through its allocation',
      idempotencyKey: randomUUID(),
      allocationId: filling.id,
    });
    await expect(allocateFromCredit('10.01')).rejects.toMatchObject({
      code: 'ALLOCATION_NOT_PERMITTED',
    });
    const refilled = await allocateFromCredit('10.00');

    // 2. An allocation reversal reopens that allocation's amount.
    await reverseAllocation(financeActor, {
      allocationId: refilled.id,
      reason: 'Misallocated',
      idempotencyKey: randomUUID(),
    });
    await allocateFromCredit('10.00');
    await expect(allocateFromCredit('0.01')).rejects.toMatchObject({
      code: 'ALLOCATION_NOT_PERMITTED',
    });

    // 3. Reversing an allocated payment (no refunds) drops its allocations.
    // First make room by reversing the credit payment's active allocation,
    // then fill that room from a payment that will itself be reversed.
    const reversiblePaymentId = await confirmedPayment(bookingId, '30.00');
    const creditActiveAllocation = await prisma!.paymentAllocation.findFirstOrThrow({
      where: { paymentId: creditPaymentId, installmentId, reversal: null },
    });
    await reverseAllocation(financeActor, {
      allocationId: creditActiveAllocation.id,
      reason: 'Make room for the reversible payment',
      idempotencyKey: randomUUID(),
    });
    await createAllocation(financeActor, {
      paymentId: reversiblePaymentId,
      installmentId,
      amount: '10.00',
      idempotencyKey: randomUUID(),
    });
    await expect(allocateFromCredit('0.01')).rejects.toMatchObject({
      code: 'ALLOCATION_NOT_PERMITTED',
    });
    await reversePayment(financeActor, {
      paymentId: reversiblePaymentId,
      reason: 'Confirmed in error',
      idempotencyKey: randomUUID(),
    });
    await allocateFromCredit('10.00');

    const summary = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summary.installments[0]?.outstandingAmount.toFixed(2)).toBe('0.00');
    expect(summary.unappliedCredit.toFixed(2)).toBe('90.00');
  });

  it('serializes concurrent allocations to one installment so together they never exceed its amount', async () => {
    const { bookingId, installmentId } = await approvedSingleInstallmentBooking('100.00');
    const firstPaymentId = await confirmedPayment(bookingId, '100.00');
    const secondPaymentId = await confirmedPayment(bookingId, '100.00');

    const results = await Promise.allSettled(
      [firstPaymentId, secondPaymentId, firstPaymentId, secondPaymentId].map((paymentId) =>
        createAllocation(financeActor, {
          paymentId,
          installmentId,
          amount: '40.00',
          idempotencyKey: randomUUID(),
        }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(2);
    for (const failure of rejected) {
      expect(failure.reason).toMatchObject({ code: 'ALLOCATION_NOT_PERMITTED' });
    }
    const summary = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summary.installments[0]?.outstandingAmount.toFixed(2)).toBe('20.00');
    expect(summary.unappliedCredit.toFixed(2)).toBe('120.00');
  });

  it('rejects allocating against an installment whose payment plan is not yet approved', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '100.00', dueDate: '2026-10-01' },
      ],
    });
    const payment = await recordPayment(financeActor, { bookingId, amount: '100.00' });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });
    const installment = await prisma!.installment.findFirstOrThrow({
      where: { paymentPlanId: plan.id },
    });

    await expect(
      createAllocation(financeActor, {
        paymentId: payment.id,
        installmentId: installment.id,
        amount: '50.00',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ALLOCATION_NOT_PERMITTED' });
  });

  it('denies an unassigned TRAVEL_CONSULTANT from proposing a plan or reading the booking summary (never revealing existence)', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');

    await expect(
      proposePaymentPlan(unassignedTcActor, {
        bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_FORBIDDEN' });

    await expect(
      getBookingPaymentSummaryForStaff(unassignedTcActor, bookingId),
    ).rejects.toMatchObject({
      code: 'BOOKING_FORBIDDEN',
    });
  });

  it('rejects a conflicting write attempt: proposing a second plan for a booking that already has one', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
      ],
    });

    await expect(
      proposePaymentPlan(tcActor, {
        bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '999.00', dueDate: '2026-12-01' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PLAN_CONFLICT' });
  });

  it('refuses a plan whose deposit is not the first installment (D-019), writing nothing', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');

    await expect(
      proposePaymentPlan(tcActor, {
        bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: false, amount: '250.00', dueDate: '2026-10-01' },
          { sequenceNumber: 2, isDeposit: true, amount: '250.00', dueDate: '2026-11-01' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PLAN_CONFLICT', status: 409 });
    expect(await prisma!.paymentPlan.count({ where: { bookingId } })).toBe(0);

    // The same booking still accepts a valid plan afterwards.
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '250.00', dueDate: '2026-10-01' },
        { sequenceNumber: 2, isDeposit: false, amount: '250.00', dueDate: '2026-11-01' },
      ],
    });
    expect(await prisma!.installment.count({ where: { paymentPlanId: plan.id } })).toBe(2);
  });

  it('rejects approval when installments do not sum to the booking total', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '400.00', dueDate: '2026-10-01' },
      ],
    });

    await expect(
      approvePaymentPlan(financeActor, { paymentPlanId: plan.id }),
    ).rejects.toMatchObject({
      code: 'PAYMENT_PLAN_CONFLICT',
    });
  });

  it('never throws a raw PaymentError-unrelated error for any of the above — every rejection is a PaymentError', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    try {
      await proposePaymentPlan(unassignedTcActor, {
        bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
        ],
      });
      expect.fail('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentError);
    }
  });
});
