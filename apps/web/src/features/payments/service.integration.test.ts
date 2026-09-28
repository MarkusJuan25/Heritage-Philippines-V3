import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
  let withdrawPaymentPlan: (typeof import('./service'))['withdrawPaymentPlan'];
  let recordPayment: (typeof import('./service'))['recordPayment'];
  let confirmPayment: (typeof import('./service'))['confirmPayment'];
  let reversePayment: (typeof import('./service'))['reversePayment'];
  let refundPayment: (typeof import('./service'))['refundPayment'];
  let createAllocation: (typeof import('./service'))['createAllocation'];
  let reverseAllocation: (typeof import('./service'))['reverseAllocation'];
  let issueReceipt: (typeof import('./service'))['issueReceipt'];
  let getBookingPaymentSummaryForStaff: (typeof import('./service'))['getBookingPaymentSummaryForStaff'];
  let getClientPaymentSummaries: (typeof import('./service'))['getClientPaymentSummaries'];
  let setBookingFinancials: (typeof import('./service'))['setBookingFinancials'];
  let listPaymentBookingsForActor: (typeof import('./service'))['listPaymentBookingsForActor'];
  let getPaymentBookingHeaderForActor: (typeof import('./service'))['getPaymentBookingHeaderForActor'];
  let PaymentError: (typeof import('./errors'))['PaymentError'];
  let createProposal: (typeof import('@/features/proposals/service'))['createProposal'];
  let publishProposalVersion: (typeof import('@/features/proposals/service'))['publishProposalVersion'];
  let recordProposalResponse: (typeof import('@/features/proposals/service'))['recordProposalResponse'];
  let createBooking: (typeof import('@/features/bookings/service'))['createBooking'];
  let updateBookingStatus: (typeof import('@/features/bookings/service'))['updateBookingStatus'];

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
      withdrawPaymentPlan,
      recordPayment,
      confirmPayment,
      reversePayment,
      refundPayment,
      createAllocation,
      reverseAllocation,
      issueReceipt,
      getBookingPaymentSummaryForStaff,
      getClientPaymentSummaries,
      setBookingFinancials,
      listPaymentBookingsForActor,
      getPaymentBookingHeaderForActor,
    } = await import('./service'));
    ({ PaymentError } = await import('./errors'));
    ({ createProposal, publishProposalVersion, recordProposalResponse } =
      await import('@/features/proposals/service'));
    ({ createBooking, updateBookingStatus } = await import('@/features/bookings/service'));

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
          // ClientProfile is onDelete:Restrict on both its User and Client.
          await prisma.clientProfile.deleteMany({ where: { userId: { in: actorUserIds } } });
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

  /** A user created by a test itself; cleaned up with the shared actors. */
  async function createUserFixture(
    role: 'FINANCE_ACCOUNTING' | 'CLIENT',
  ): Promise<AuthenticatedUser> {
    const id = randomUUID();
    const email = `payments-integration-${role.toLowerCase()}-${randomUUID()}@example.test`;
    const name = `Integration ${role}`;
    await prisma!.user.create({ data: { id, name, email, role, isActive: true } });
    actorUserIds.push(id);
    return { id, name, email, role };
  }

  /** A booking with an approved plan and one confirmed payment of `paid`. */
  async function createPaidBookingFixture(paid: string): Promise<{
    bookingId: string;
    clientId: string;
    paymentId: string;
  }> {
    const { bookingId, clientId } = await createAssignedBookingFixture('500.00');
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
      ],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: paid,
      idempotencyKey: randomUUID(),
    });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });
    return { bookingId, clientId, paymentId: payment.id };
  }

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

  it('sets and locks Booking financials by active plan and independently by a Payment', async () => {
    const { bookingId } = await createAssignedBookingFixture();
    await prisma!.booking.update({
      where: { id: bookingId },
      data: { totalAmount: null, currencyCode: null },
    });
    const input = { bookingId, totalAmount: '500.00', currencyCode: 'PHP' as const };
    await expect(setBookingFinancials(tcActor, input)).rejects.toMatchObject({
      code: 'ROLE_NOT_PERMITTED',
    });
    await expect(setBookingFinancials(adminActor, input)).rejects.toMatchObject({
      code: 'ROLE_NOT_PERMITTED',
    });
    await expect(
      setBookingFinancials(financeActor, { ...input, currencyCode: 'USD' as 'PHP' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_CONFLICT' });
    const set = await setBookingFinancials(financeActor, input);
    expect(set.totalAmount?.toFixed(2)).toBe('500.00');
    await expect(
      setBookingFinancials(financeActor, { ...input, totalAmount: '600.00' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_CONFLICT' });
    const corrected = await setBookingFinancials(financeActor, {
      ...input,
      totalAmount: '600.00',
      reason: 'Agreed correction',
    });
    expect(corrected.totalAmount?.toFixed(2)).toBe('600.00');
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '600.00', dueDate: '2026-10-01' },
      ],
    });
    await expect(setBookingFinancials(financeActor, input)).rejects.toMatchObject({
      code: 'BOOKING_FINANCIALS_LOCKED',
    });
    await withdrawPaymentPlan(tcActor, { paymentPlanId: plan.id, reason: 'Change terms' });
    await expect(
      setBookingFinancials(financeActor, { ...input, reason: 'Requoted after plan withdrawal' }),
    ).resolves.toMatchObject({ currencyCode: 'PHP' });
    await recordPayment(financeActor, { bookingId, amount: '10.00', idempotencyKey: randomUUID() });
    await expect(
      setBookingFinancials(financeActor, { ...input, totalAmount: '700.00', reason: 'New quote' }),
    ).rejects.toMatchObject({ code: 'BOOKING_FINANCIALS_LOCKED' });
  });

  it('scopes and pages the payment Booking list and header', async () => {
    const { bookingId } = await createAssignedBookingFixture();
    const listed = await listPaymentBookingsForActor(financeActor, {
      page: 1,
      pageSize: 20,
      planState: 'none',
    });
    expect(listed.items.some((booking) => booking.id === bookingId)).toBe(true);
    expect(listed.total).toBeGreaterThanOrEqual(1);
    await expect(getPaymentBookingHeaderForActor(financeActor, bookingId)).resolves.toMatchObject({
      id: bookingId,
      client: { fullName: expect.any(String) },
    });
    const unassigned = await listPaymentBookingsForActor(
      { ...financeActor, id: randomUUID() },
      { page: 1, pageSize: 20 },
    );
    expect(unassigned.items.some((booking) => booking.id === bookingId)).toBe(false);
    await expect(
      getPaymentBookingHeaderForActor({ ...financeActor, id: randomUUID() }, bookingId),
    ).rejects.toMatchObject({ code: 'BOOKING_FORBIDDEN' });
  });

  it('blocks new plan, payment and financial writes on CANCELLED while preserving a record replay', async () => {
    const { bookingId } = await createAssignedBookingFixture();
    const oldKey = `record-${randomUUID()}`;
    const pending = await recordPayment(financeActor, {
      bookingId,
      amount: '25.00',
      idempotencyKey: oldKey,
    });
    const confirmed = await recordPayment(financeActor, {
      bookingId,
      amount: '10.00',
      idempotencyKey: randomUUID(),
    });
    const oldConfirmationKey = randomUUID();
    await confirmPayment(financeActor, {
      paymentId: confirmed.id,
      reason: 'received before cancellation',
      idempotencyKey: oldConfirmationKey,
    });
    await prisma!.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });
    await expect(
      proposePaymentPlan(tcActor, {
        bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_STATUS_NOT_PERMITTED' });
    await expect(
      recordPayment(financeActor, { bookingId, amount: '25.00', idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'BOOKING_STATUS_NOT_PERMITTED' });
    await expect(
      confirmPayment(financeActor, {
        paymentId: pending.id,
        reason: 'received',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_STATUS_NOT_PERMITTED' });
    await expect(
      setBookingFinancials(financeActor, {
        bookingId,
        totalAmount: '600.00',
        currencyCode: 'PHP',
        reason: 'correction',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_STATUS_NOT_PERMITTED' });
    await expect(
      recordPayment(financeActor, { bookingId, amount: '25.00', idempotencyKey: oldKey }),
    ).resolves.toMatchObject({ id: pending.id });
    await expect(
      confirmPayment(financeActor, {
        paymentId: confirmed.id,
        reason: 'received before cancellation',
        idempotencyKey: oldConfirmationKey,
      }),
    ).resolves.toMatchObject({ id: confirmed.id, status: 'CONFIRMED' });
  });

  it('locks an approved plan with no payment and keeps COMPLETED financial writes available', async () => {
    const { bookingId } = await createAssignedBookingFixture();
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
      ],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    await expect(
      setBookingFinancials(financeActor, {
        bookingId,
        totalAmount: '600.00',
        currencyCode: 'PHP',
        reason: 'Late change',
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_FINANCIALS_LOCKED' });

    const completed = await createAssignedBookingFixture();
    await prisma!.booking.update({
      where: { id: completed.bookingId },
      data: { status: 'COMPLETED' },
    });
    await expect(
      setBookingFinancials(financeActor, {
        bookingId: completed.bookingId,
        totalAmount: '600.00',
        currencyCode: 'PHP',
        reason: 'Final quote',
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(
      proposePaymentPlan(tcActor, {
        bookingId: completed.bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '600.00', dueDate: '2026-10-01' },
        ],
      }),
    ).resolves.toMatchObject({ status: 'PROPOSED' });
  });

  it('blocks plan approval and allocation after cancellation, but allows withdrawing a proposed plan', async () => {
    const { bookingId } = await createAssignedBookingFixture();
    const plan = await proposePaymentPlan(tcActor, {
      bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
      ],
    });
    const installment = await prisma!.installment.findFirstOrThrow({
      where: { paymentPlanId: plan.id },
      select: { id: true },
    });
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'received',
      idempotencyKey: randomUUID(),
    });
    await prisma!.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });
    await expect(
      approvePaymentPlan(financeActor, { paymentPlanId: plan.id }),
    ).rejects.toMatchObject({ code: 'BOOKING_STATUS_NOT_PERMITTED' });
    await expect(
      createAllocation(financeActor, {
        paymentId: payment.id,
        installmentId: installment.id,
        amount: '50.00',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_STATUS_NOT_PERMITTED' });
    await expect(
      withdrawPaymentPlan(tcActor, { paymentPlanId: plan.id, reason: 'Cancelled Booking' }),
    ).resolves.toMatchObject({ status: 'WITHDRAWN' });
  });

  it.each([
    'proposePaymentPlan',
    'approvePaymentPlan',
    'createAllocation',
    'recordPayment',
    'confirmPayment',
    'setBookingFinancials',
  ] as const)(
    'serializes a cancellation racing %s without a raw database error',
    async (operation) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { bookingId } = await createAssignedBookingFixture();
        let planId: string | undefined;
        let installmentId: string | undefined;
        let paymentId: string | undefined;
        if (operation === 'approvePaymentPlan' || operation === 'createAllocation') {
          const plan = await proposePaymentPlan(tcActor, {
            bookingId,
            installments: [
              { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
            ],
          });
          planId = plan.id;
          if (operation === 'createAllocation') {
            await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
            const installment = await prisma!.installment.findFirstOrThrow({
              where: { paymentPlanId: plan.id },
              select: { id: true },
            });
            installmentId = installment.id;
          }
        }
        if (operation === 'confirmPayment' || operation === 'createAllocation') {
          const payment = await recordPayment(financeActor, {
            bookingId,
            amount: '100.00',
            idempotencyKey: randomUUID(),
          });
          paymentId = payment.id;
          if (operation === 'createAllocation') {
            await confirmPayment(financeActor, {
              paymentId: payment.id,
              reason: 'received',
              idempotencyKey: randomUUID(),
            });
          }
        }
        const write = () => {
          switch (operation) {
            case 'proposePaymentPlan':
              return proposePaymentPlan(tcActor, {
                bookingId,
                installments: [
                  { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
                ],
              });
            case 'approvePaymentPlan':
              return approvePaymentPlan(financeActor, { paymentPlanId: planId! });
            case 'createAllocation':
              return createAllocation(financeActor, {
                paymentId: paymentId!,
                installmentId: installmentId!,
                amount: '25.00',
                idempotencyKey: randomUUID(),
              });
            case 'recordPayment':
              return recordPayment(financeActor, {
                bookingId,
                amount: '25.00',
                idempotencyKey: randomUUID(),
              });
            case 'confirmPayment':
              return confirmPayment(financeActor, {
                paymentId: paymentId!,
                reason: 'received',
                idempotencyKey: randomUUID(),
              });
            case 'setBookingFinancials':
              return setBookingFinancials(financeActor, {
                bookingId,
                totalAmount: '600.00',
                currencyCode: 'PHP',
                reason: 'New agreed quote',
              });
          }
        };
        const [cancelled, written] = await Promise.allSettled([
          updateBookingStatus(adminActor, bookingId, {
            expectedStatus: 'DRAFT',
            newStatus: 'CANCELLED',
          }),
          write(),
        ]);
        expect(cancelled.status).toBe('fulfilled');
        if (written.status === 'rejected') {
          expect(written.reason).toBeInstanceOf(PaymentError);
          expect([
            'BOOKING_STATUS_NOT_PERMITTED',
            operation === 'setBookingFinancials'
              ? 'PAYMENT_CONFLICT'
              : operation === 'proposePaymentPlan' || operation === 'approvePaymentPlan'
                ? 'PAYMENT_PLAN_CONFLICT'
                : operation === 'createAllocation'
                  ? 'ALLOCATION_NOT_PERMITTED'
                  : 'PAYMENT_CONFLICT',
          ]).toContain(written.reason.code);
        }
        const row = await prisma!.booking.findUniqueOrThrow({ where: { id: bookingId } });
        expect(row.status).toBe('CANCELLED');
      }
    },
    30000,
  );

  it('rechecks CANCELLED after a controlled financials status-read/cancellation interleaving', async () => {
    const { bookingId } = await createAssignedBookingFixture();
    const paymentRepository = await import('./repository');
    const original = paymentRepository.findBookingFinancialsForActor;
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const statusRead = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const resumeWrite = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const spy = vi
      .spyOn(paymentRepository, 'findBookingFinancialsForActor')
      .mockImplementation(async (db, actor, id) => {
        const result = await original(db, actor, id);
        if (id === bookingId) {
          signalRead();
          await resumeWrite;
        }
        return result;
      });
    const write = Promise.allSettled([
      setBookingFinancials(financeActor, {
        bookingId,
        totalAmount: '600.00',
        currencyCode: 'PHP',
        reason: 'Changed quote',
      }),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        statusRead,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out before the financials status read')),
            5000,
          );
        }),
      ]);
      await updateBookingStatus(adminActor, bookingId, {
        expectedStatus: 'DRAFT',
        newStatus: 'CANCELLED',
      });
      releaseRead();
      const result = await write;
      expect(result[0]!.status).toBe('rejected');
      if (result[0]!.status === 'rejected') {
        expect(result[0]!.reason).toBeInstanceOf(PaymentError);
        expect(['BOOKING_STATUS_NOT_PERMITTED', 'PAYMENT_CONFLICT']).toContain(
          result[0]!.reason.code,
        );
      }
      const booking = await prisma!.booking.findUniqueOrThrow({ where: { id: bookingId } });
      expect(booking.status).toBe('CANCELLED');
      expect(booking.totalAmount?.toFixed(2)).toBe('500.00');
    } finally {
      if (timer) clearTimeout(timer);
      releaseRead();
      await write;
      spy.mockRestore();
    }
  }, 20000);

  it.each(['proposePaymentPlan', 'recordPayment'] as const)(
    'keeps financials consistent when setBookingFinancials races %s',
    async (operation) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const { bookingId } = await createAssignedBookingFixture();
        const [financials, writer] = await Promise.allSettled([
          setBookingFinancials(financeActor, {
            bookingId,
            totalAmount: '600.00',
            currencyCode: 'PHP',
            reason: 'Requoted before lock',
          }),
          operation === 'proposePaymentPlan'
            ? proposePaymentPlan(tcActor, {
                bookingId,
                installments: [
                  { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
                ],
              })
            : recordPayment(financeActor, {
                bookingId,
                amount: '25.00',
                idempotencyKey: randomUUID(),
              }),
        ]);
        if (financials.status === 'rejected') {
          expect(financials.reason).toBeInstanceOf(PaymentError);
          expect(['BOOKING_FINANCIALS_LOCKED', 'PAYMENT_CONFLICT']).toContain(
            financials.reason.code,
          );
        }
        if (writer.status === 'rejected') {
          expect(writer.reason).toBeInstanceOf(PaymentError);
          expect(
            operation === 'proposePaymentPlan' ? 'PAYMENT_PLAN_CONFLICT' : 'PAYMENT_CONFLICT',
          ).toBe(writer.reason.code);
        }
        const booking = await prisma!.booking.findUniqueOrThrow({ where: { id: bookingId } });
        expect(booking.totalAmount?.toFixed(2)).toBe(
          financials.status === 'fulfilled' ? '600.00' : '500.00',
        );
        if (writer.status === 'fulfilled') {
          expect(
            (await prisma!.paymentPlan.count({ where: { bookingId } })) +
              (await prisma!.payment.count({ where: { bookingId } })),
          ).toBe(1);
        }
      }
    },
    30000,
  );

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
    expect(plan.status).toBe('PROPOSED');

    const approved = await approvePaymentPlan(financeActor, { paymentPlanId: plan.id });
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.status).toBe('APPROVED');

    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '200.00',
      idempotencyKey: randomUUID(),
    });
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '150.00',
      idempotencyKey: randomUUID(),
    });
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
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
    const first = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
    const second = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount,
      idempotencyKey: randomUUID(),
    });
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
      recordPayment(financeActor, { bookingId, amount: '100.00', idempotencyKey: randomUUID() }),
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
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
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

  it("returns a client only their own bookings' payment summaries and refuses another client's (ownership and isolation)", async () => {
    const own = await createPaidBookingFixture('120.00');
    const other = await createPaidBookingFixture('80.00');
    const ownUser = await createUserFixture('CLIENT');
    const otherUser = await createUserFixture('CLIENT');
    await prisma!.clientProfile.create({
      data: { id: randomUUID(), userId: ownUser.id, clientId: own.clientId },
    });
    await prisma!.clientProfile.create({
      data: { id: randomUUID(), userId: otherUser.id, clientId: other.clientId },
    });

    const summaries = await getClientPaymentSummaries(ownUser, own.clientId);
    expect(summaries.map((s) => s.bookingId)).toEqual([own.bookingId]);
    expect(summaries[0]!.confirmedAmountPaid.toFixed(2)).toBe('120.00');
    expect(summaries[0]!.remainingBalance?.toFixed(2)).toBe('380.00');
    expect(summaries[0]!.payments.map((p) => p.id)).toEqual([own.paymentId]);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(other.bookingId);
    expect(serialized).not.toContain(other.paymentId);

    await expect(getClientPaymentSummaries(ownUser, other.clientId)).rejects.toMatchObject({
      code: 'BOOKING_FORBIDDEN',
    });
    await expect(getClientPaymentSummaries(otherUser, own.clientId)).rejects.toMatchObject({
      code: 'BOOKING_FORBIDDEN',
    });

    const otherSummaries = await getClientPaymentSummaries(otherUser, other.clientId);
    expect(otherSummaries.map((s) => s.bookingId)).toEqual([other.bookingId]);
    expect(otherSummaries[0]!.payments.map((p) => p.id)).toEqual([other.paymentId]);
  });

  it('denies a Finance/Accounting user whose only booking assignment is a stale Travel Consultant row or an ended Finance row (D-054 §16)', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const pending = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });

    // Stale role: assigned to this booking as a Travel Consultant, and a
    // Finance/Accounting user now. The booking's active Travel Consultant
    // slot is ended first, since only one may be active per booking and role.
    const staleFinance = await createUserFixture('FINANCE_ACCOUNTING');
    await prisma!.staffAssignment.updateMany({
      where: { bookingId, role: 'TRAVEL_CONSULTANT', endedAt: null },
      data: { endedAt: new Date() },
    });
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: staleFinance.id,
        assignedByUserId: adminActor.id,
        role: 'TRAVEL_CONSULTANT',
        bookingId,
      },
    });

    // Ended: a Finance/Accounting assignment to this booking that has ended.
    const endedFinance = await createUserFixture('FINANCE_ACCOUNTING');
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: endedFinance.id,
        assignedByUserId: adminActor.id,
        role: 'FINANCE_ACCOUNTING',
        bookingId,
        endedAt: new Date(),
      },
    });

    for (const actor of [staleFinance, endedFinance]) {
      await expect(
        confirmPayment(actor, {
          paymentId: pending.id,
          reason: 'Verified',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_FORBIDDEN' });
      await expect(
        recordPayment(actor, { bookingId, amount: '10.00', idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({
        code: 'BOOKING_FORBIDDEN',
      });
      await expect(getBookingPaymentSummaryForStaff(actor, bookingId)).rejects.toMatchObject({
        code: 'BOOKING_FORBIDDEN',
      });
    }
    const unchanged = await prisma!.payment.findUniqueOrThrow({ where: { id: pending.id } });
    expect(unchanged.status).toBe('PENDING');
    expect(await prisma!.payment.count({ where: { bookingId } })).toBe(1);

    // Control: the currently assigned Finance/Accounting user still can.
    const confirmed = await confirmPayment(financeActor, {
      paymentId: pending.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });
    expect(confirmed.status).toBe('CONFIRMED');
  });

  it('answers a retried refund with its own prior result without applying it twice, and rejects its key for a different refund (D-054 §8)', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const payment = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
    await confirmPayment(financeActor, {
      paymentId: payment.id,
      reason: 'Verified',
      idempotencyKey: randomUUID(),
    });
    const refundInput = {
      paymentId: payment.id,
      amount: '40.00',
      reason: 'Partial cancellation',
      idempotencyKey: randomUUID(),
    };

    const first = await refundPayment(financeActor, refundInput);
    const retry = await refundPayment(financeActor, refundInput);
    expect(retry.refund.id).toBe(first.refund.id);

    await expect(
      refundPayment(financeActor, { ...refundInput, amount: '10.00' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });

    expect(await prisma!.paymentRefund.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(
      await prisma!.auditLog.count({ where: { entityId: payment.id, action: 'PAYMENT_REFUNDED' } }),
    ).toBe(1);
    const summary = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
    expect(summary.confirmedAmountPaid.toFixed(2)).toBe('60.00');
  });

  it('audits the reason and before/after values of confirmations, reversals, and refunds (blueprint §11.7)', async () => {
    const { bookingId } = await createAssignedBookingFixture('500.00');
    const refunded = await recordPayment(financeActor, {
      bookingId,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });
    await confirmPayment(financeActor, {
      paymentId: refunded.id,
      reason: 'Verified bank transfer',
      idempotencyKey: randomUUID(),
    });
    await refundPayment(financeActor, {
      paymentId: refunded.id,
      amount: '40.00',
      reason: 'Partial cancellation',
      idempotencyKey: randomUUID(),
    });
    await refundPayment(financeActor, {
      paymentId: refunded.id,
      amount: '60.00',
      reason: 'Remainder cancelled',
      idempotencyKey: randomUUID(),
    });

    const reversed = await recordPayment(financeActor, {
      bookingId,
      amount: '50.00',
      idempotencyKey: randomUUID(),
    });
    await confirmPayment(financeActor, {
      paymentId: reversed.id,
      reason: 'Verified deposit slip',
      idempotencyKey: randomUUID(),
    });
    await reversePayment(financeActor, {
      paymentId: reversed.id,
      reason: 'Duplicate entry',
      idempotencyKey: randomUUID(),
    });

    const entries = await prisma!.auditLog.findMany({
      where: { entityId: { in: [refunded.id, reversed.id] } },
      orderBy: { createdAt: 'asc' },
      select: {
        entityId: true,
        action: true,
        actorId: true,
        createdAt: true,
        beforeState: true,
        afterState: true,
      },
    });
    // Acting user and timestamp (blueprint §11.7) on every entry: two
    // PAYMENT_RECORDED, four status changes, and two refunds.
    expect(entries).toHaveLength(8);
    for (const entry of entries) {
      expect(entry.actorId).toBe(financeActor.id);
      expect(entry.createdAt).toBeInstanceOf(Date);
    }
    const statusChanges = (paymentId: string) =>
      entries
        .filter((e) => e.entityId === paymentId && e.action === 'PAYMENT_STATUS_CHANGED')
        .map((e) => [e.beforeState, e.afterState]);

    expect(statusChanges(refunded.id)).toEqual([
      [{ status: 'PENDING' }, { status: 'CONFIRMED', reason: 'Verified bank transfer' }],
      [{ status: 'CONFIRMED' }, { status: 'REFUNDED', reason: 'Remainder cancelled' }],
    ]);
    expect(statusChanges(reversed.id)).toEqual([
      [{ status: 'PENDING' }, { status: 'CONFIRMED', reason: 'Verified deposit slip' }],
      [{ status: 'CONFIRMED' }, { status: 'REVERSED', reason: 'Duplicate entry' }],
    ]);
    expect(
      entries
        .filter((e) => e.action === 'PAYMENT_REFUNDED')
        .map((e) => [e.beforeState, e.afterState]),
    ).toEqual([
      [
        { status: 'CONFIRMED', refundedTotal: '0.00' },
        {
          paymentId: refunded.id,
          amount: '40.00',
          reason: 'Partial cancellation',
          allocationId: null,
          status: 'CONFIRMED',
          refundedTotal: '40.00',
        },
      ],
      [
        { status: 'CONFIRMED', refundedTotal: '40.00' },
        {
          paymentId: refunded.id,
          amount: '60.00',
          reason: 'Remainder cancelled',
          allocationId: null,
          status: 'REFUNDED',
          refundedTotal: '100.00',
        },
      ],
    ]);
  });

  it('audits the allocation a linked refund reduces', async () => {
    const { bookingId, paymentId } = await createPaidBookingFixture('100.00');
    const [installment] = await prisma!.installment.findMany({
      where: { paymentPlan: { bookingId } },
    });
    const allocation = await createAllocation(financeActor, {
      paymentId,
      installmentId: installment!.id,
      amount: '100.00',
      idempotencyKey: randomUUID(),
    });

    await refundPayment(financeActor, {
      paymentId,
      amount: '30.00',
      reason: 'Excursion cancelled',
      idempotencyKey: randomUUID(),
      allocationId: allocation.id,
    });

    const entry = await prisma!.auditLog.findFirstOrThrow({
      where: { entityId: paymentId, action: 'PAYMENT_REFUNDED' },
    });
    expect(entry.actorId).toBe(financeActor.id);
    expect(entry.beforeState).toEqual({ status: 'CONFIRMED', refundedTotal: '0.00' });
    expect(entry.afterState).toEqual({
      paymentId,
      amount: '30.00',
      reason: 'Excursion cancelled',
      allocationId: allocation.id,
      status: 'CONFIRMED',
      refundedTotal: '30.00',
    });
  });

  describe('recordPayment idempotency (D-054 §17 Rule 6)', () => {
    async function recordedRowCounts(bookingId: string) {
      const paymentIds = (
        await prisma!.payment.findMany({ where: { bookingId }, select: { id: true } })
      ).map((p) => p.id);
      return {
        payments: paymentIds.length,
        history: await prisma!.paymentStatusHistory.count({
          where: { paymentId: { in: paymentIds } },
        }),
        recordedAudits: await prisma!.auditLog.count({
          where: { entityId: { in: paymentIds }, action: 'PAYMENT_RECORDED' },
        }),
      };
    }

    it('returns the original payment for an identical retry and writes nothing more', async () => {
      const { bookingId } = await createAssignedBookingFixture('500.00');
      const input = { bookingId, amount: '200.00', idempotencyKey: randomUUID() };

      const first = await recordPayment(financeActor, input);
      const retry = await recordPayment(financeActor, input);

      expect(retry).toEqual(first);
      expect(await recordedRowCounts(bookingId)).toEqual({
        payments: 1,
        history: 1,
        recordedAudits: 1,
      });
      const history = await prisma!.paymentStatusHistory.findFirstOrThrow({
        where: { paymentId: first.id },
      });
      expect(history).toMatchObject({
        previousStatus: null,
        newStatus: 'PENDING',
        idempotencyKey: input.idempotencyKey,
      });
    });

    it('rejects the key for a different amount or booking, and refuses an unassigned user before revealing it', async () => {
      const { bookingId } = await createAssignedBookingFixture('500.00');
      const { bookingId: otherBookingId } = await createAssignedBookingFixture('500.00');
      const idempotencyKey = randomUUID();
      await recordPayment(financeActor, { bookingId, amount: '200.00', idempotencyKey });

      for (const amount of ['250.00', '200.01', '199.99']) {
        await expect(
          recordPayment(financeActor, { bookingId, amount, idempotencyKey }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      }
      await expect(
        recordPayment(financeActor, {
          bookingId: otherBookingId,
          amount: '200.00',
          idempotencyKey,
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });

      const unassignedFinance = await createUserFixture('FINANCE_ACCOUNTING');
      await expect(
        recordPayment(unassignedFinance, { bookingId, amount: '200.00', idempotencyKey }),
      ).rejects.toMatchObject({ code: 'BOOKING_FORBIDDEN' });

      expect(await recordedRowCounts(bookingId)).toEqual({
        payments: 1,
        history: 1,
        recordedAudits: 1,
      });
      expect(await recordedRowCounts(otherBookingId)).toEqual({
        payments: 0,
        history: 0,
        recordedAudits: 0,
      });
    });

    it('answers a retry after the payment was fully refunded with it in REFUNDED status, creating nothing', async () => {
      const { bookingId } = await createAssignedBookingFixture('500.00');
      const input = { bookingId, amount: '100.00', idempotencyKey: randomUUID() };
      const original = await recordPayment(financeActor, input);
      await confirmPayment(financeActor, {
        paymentId: original.id,
        reason: 'Verified',
        idempotencyKey: randomUUID(),
      });
      await refundPayment(financeActor, {
        paymentId: original.id,
        amount: '100.00',
        reason: 'Trip cancelled',
        idempotencyKey: randomUUID(),
      });

      const retry = await recordPayment(financeActor, input);
      expect(retry.id).toBe(original.id);
      expect(retry.status).toBe('REFUNDED');
      expect(await recordedRowCounts(bookingId)).toEqual({
        payments: 1,
        history: 3,
        recordedAudits: 1,
      });
    });

    it('returns the same payment when another Finance user now assigned to the booking retries the key (the acting user is not part of the request)', async () => {
      const { bookingId } = await createAssignedBookingFixture('500.00');
      const input = { bookingId, amount: '100.00', idempotencyKey: randomUUID() };
      const original = await recordPayment(financeActor, input);

      const nextFinance = await createUserFixture('FINANCE_ACCOUNTING');
      await prisma!.staffAssignment.updateMany({
        where: { bookingId, role: 'FINANCE_ACCOUNTING', endedAt: null },
        data: { endedAt: new Date() },
      });
      await prisma!.staffAssignment.create({
        data: {
          id: randomUUID(),
          assignedStaffId: nextFinance.id,
          assignedByUserId: adminActor.id,
          role: 'FINANCE_ACCOUNTING',
          bookingId,
        },
      });

      await expect(recordPayment(nextFinance, input)).resolves.toEqual(original);
      // The previous user's assignment has ended, so it may no longer replay.
      await expect(recordPayment(financeActor, input)).rejects.toMatchObject({
        code: 'BOOKING_FORBIDDEN',
      });
      expect(await recordedRowCounts(bookingId)).toEqual({
        payments: 1,
        history: 1,
        recordedAudits: 1,
      });
    });

    it('resolves concurrent identical requests to one PENDING payment, never a second payment or a raw error', async () => {
      const { bookingId } = await createAssignedBookingFixture('500.00');
      const input = { bookingId, amount: '200.00', idempotencyKey: randomUUID() };

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => recordPayment(financeActor, input)),
      );

      expect(await recordedRowCounts(bookingId)).toEqual({
        payments: 1,
        history: 1,
        recordedAudits: 1,
      });
      const [payment] = await prisma!.payment.findMany({ where: { bookingId } });
      expect(payment!.status).toBe('PENDING');
      for (const result of results) {
        if (result.status === 'fulfilled') {
          expect(result.value.id).toBe(payment!.id);
        } else {
          expect(result.reason).toBeInstanceOf(PaymentError);
          expect(result.reason).toMatchObject({ code: 'PAYMENT_CONFLICT' });
        }
      }
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('never turns a key used by confirmPayment or reversePayment into a new payment, and the reverse', async () => {
      const { bookingId } = await createAssignedBookingFixture('500.00');
      const payment = await recordPayment(financeActor, {
        bookingId,
        amount: '100.00',
        idempotencyKey: randomUUID(),
      });
      const confirmKey = randomUUID();
      const reverseKey = randomUUID();
      await confirmPayment(financeActor, {
        paymentId: payment.id,
        reason: 'Verified',
        idempotencyKey: confirmKey,
      });
      await reversePayment(financeActor, {
        paymentId: payment.id,
        reason: 'Duplicate entry',
        idempotencyKey: reverseKey,
      });

      for (const idempotencyKey of [confirmKey, reverseKey]) {
        await expect(
          recordPayment(financeActor, { bookingId, amount: '100.00', idempotencyKey }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      }

      const recordKey = randomUUID();
      const second = await recordPayment(financeActor, {
        bookingId,
        amount: '100.00',
        idempotencyKey: recordKey,
      });
      await expect(
        confirmPayment(financeActor, {
          paymentId: second.id,
          reason: 'Verified',
          idempotencyKey: recordKey,
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });

      expect((await recordedRowCounts(bookingId)).payments).toBe(2);
      const secondNow = await prisma!.payment.findUniqueOrThrow({ where: { id: second.id } });
      expect(secondNow.status).toBe('PENDING');
    });

    it('records two genuine payments of equal amount when their keys differ', async () => {
      const { bookingId } = await createAssignedBookingFixture('500.00');
      const first = await recordPayment(financeActor, {
        bookingId,
        amount: '100.00',
        idempotencyKey: randomUUID(),
      });
      const second = await recordPayment(financeActor, {
        bookingId,
        amount: '100.00',
        idempotencyKey: randomUUID(),
      });

      expect(second.id).not.toBe(first.id);
      expect(await recordedRowCounts(bookingId)).toEqual({
        payments: 2,
        history: 2,
        recordedAudits: 2,
      });
    });

    it('answers a retry after the payment changed status with the payment in its current status, creating nothing', async () => {
      const { bookingId } = await createAssignedBookingFixture('500.00');
      const input = { bookingId, amount: '100.00', idempotencyKey: randomUUID() };
      const original = await recordPayment(financeActor, input);

      await confirmPayment(financeActor, {
        paymentId: original.id,
        reason: 'Verified',
        idempotencyKey: randomUUID(),
      });
      const afterConfirm = await recordPayment(financeActor, input);
      expect(afterConfirm.id).toBe(original.id);
      expect(afterConfirm.status).toBe('CONFIRMED');

      await reversePayment(financeActor, {
        paymentId: original.id,
        reason: 'Wrong booking',
        idempotencyKey: randomUUID(),
      });
      const afterReverse = await recordPayment(financeActor, input);
      expect(afterReverse.id).toBe(original.id);
      expect(afterReverse.status).toBe('REVERSED');

      expect(await recordedRowCounts(bookingId)).toEqual({
        payments: 1,
        history: 3,
        recordedAudits: 1,
      });
    });

    it('reports a duplicate status-history key from a nested insert against the parent Payment model', async () => {
      const repository = await import('./repository');
      const { isUniqueViolationOn } = await import('@/lib/prisma-errors');
      const { bookingId, clientId } = await createAssignedBookingFixture('500.00');
      const recordKey = randomUUID();
      await recordPayment(financeActor, { bookingId, amount: '100.00', idempotencyKey: recordKey });

      // recordPayment's insert: a Payment with a nested initial history row.
      const recordError = await repository
        .createPendingPayment(prisma!, {
          id: randomUUID(),
          bookingId,
          clientId,
          amount: '100.00',
          changedByUserId: financeActor.id,
          idempotencyKey: recordKey,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isUniqueViolationOn(recordError, 'Payment', ['idempotencyKey'])).toBe(true);
      expect(JSON.stringify((recordError as { meta?: unknown }).meta)).toContain(
        'payment_status_history_idempotencyKey_key',
      );

      // confirmPayment's insert: a Payment update with a nested history row.
      const second = await recordPayment(financeActor, {
        bookingId,
        amount: '100.00',
        idempotencyKey: randomUUID(),
      });
      const transitionError = await repository
        .transitionPaymentStatus(prisma!, {
          paymentId: second.id,
          previousStatus: 'PENDING',
          newStatus: 'CONFIRMED',
          changedByUserId: financeActor.id,
          reason: 'Verified',
          idempotencyKey: recordKey,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isUniqueViolationOn(transitionError, 'Payment', ['idempotencyKey'])).toBe(true);
      expect(JSON.stringify((transitionError as { meta?: unknown }).meta)).toContain(
        'payment_status_history_idempotencyKey_key',
      );

      expect((await recordedRowCounts(bookingId)).payments).toBe(2);
      const secondNow = await prisma!.payment.findUniqueOrThrow({ where: { id: second.id } });
      expect(secondNow.status).toBe('PENDING');

      // An unrelated unique violation under the same parent model — a
      // duplicate Payment id with a fresh key — is not classified as a key race.
      const { uniqueViolation } = await import('@/lib/prisma-errors');
      const idError = await repository
        .createPendingPayment(prisma!, {
          id: second.id,
          bookingId,
          clientId,
          amount: '100.00',
          changedByUserId: financeActor.id,
          idempotencyKey: randomUUID(),
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(uniqueViolation(idError)).toEqual({ modelName: 'Payment', fields: ['id'] });
      expect(isUniqueViolationOn(idError, 'Payment', ['idempotencyKey'])).toBe(false);
      expect((await recordedRowCounts(bookingId)).payments).toBe(2);
    });
  });

  describe('plan withdrawal and state-aware plan reads (D-057)', () => {
    const ONE_INSTALLMENT = [
      { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-01' },
    ];

    async function proposedPlanFixture(): Promise<{
      bookingId: string;
      clientId: string;
      planId: string;
    }> {
      const { bookingId, clientId } = await createAssignedBookingFixture('500.00');
      const plan = await proposePaymentPlan(tcActor, { bookingId, installments: ONE_INSTALLMENT });
      return { bookingId, clientId, planId: plan.id };
    }

    async function planAudits(planId: string, action: string) {
      return prisma!.auditLog.findMany({ where: { entityId: planId, action } });
    }

    function actorWithRole(role: AuthenticatedUser['role']): AuthenticatedUser {
      return {
        id: randomUUID(),
        name: `Integration ${role}`,
        email: `${randomUUID()}@example.test`,
        role,
      };
    }

    it('lets the assigned Travel Consultant and the assigned Finance/Accounting user each withdraw a PROPOSED plan, retaining it and its installments', async () => {
      for (const actor of [tcActor, financeActor]) {
        const { bookingId, planId } = await proposedPlanFixture();
        const withdrawn = await withdrawPaymentPlan(actor, {
          paymentPlanId: planId,
          reason: 'Wrong installment structure',
        });
        expect(withdrawn).toMatchObject({
          id: planId,
          status: 'WITHDRAWN',
          withdrawnByStaffUserId: actor.id,
          withdrawalReason: 'Wrong installment structure',
          approvedAt: null,
        });
        expect(withdrawn.withdrawnAt).toBeInstanceOf(Date);
        expect(await prisma!.paymentPlan.count({ where: { bookingId } })).toBe(1);
        expect(await prisma!.installment.count({ where: { paymentPlanId: planId } })).toBe(1);
      }
    });

    it('refuses Admin/Manager, Visa Documentation, Client, and System Administrator before any read, and an unassigned Travel Consultant without revealing the plan', async () => {
      const { planId } = await proposedPlanFixture();
      for (const role of [
        'ADMIN_MANAGER',
        'VISA_DOCUMENTATION',
        'CLIENT',
        'SYSTEM_ADMINISTRATOR',
      ] as const) {
        await expect(
          withdrawPaymentPlan(role === 'ADMIN_MANAGER' ? adminActor : actorWithRole(role), {
            paymentPlanId: planId,
            reason: 'Not allowed',
          }),
        ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED' });
      }
      await expect(
        withdrawPaymentPlan(unassignedTcActor, { paymentPlanId: planId, reason: 'Not allowed' }),
      ).rejects.toMatchObject({ code: 'PAYMENT_PLAN_FORBIDDEN' });
      await expect(
        withdrawPaymentPlan(unassignedTcActor, { paymentPlanId: randomUUID(), reason: 'Missing' }),
      ).rejects.toMatchObject({ code: 'PAYMENT_PLAN_FORBIDDEN' });

      const unchanged = await prisma!.paymentPlan.findUniqueOrThrow({ where: { id: planId } });
      expect(unchanged.status).toBe('PROPOSED');
      expect(await planAudits(planId, 'PAYMENT_PLAN_WITHDRAWN')).toHaveLength(0);
    });

    it('never withdraws an APPROVED plan, even when the request smuggles status or approval fields, leaving the row and audit unchanged', async () => {
      const { planId } = await proposedPlanFixture();
      const approved = await approvePaymentPlan(financeActor, { paymentPlanId: planId });

      const smuggled = {
        paymentPlanId: planId,
        reason: 'Try to withdraw',
        status: 'WITHDRAWN',
        approvedAt: null,
        approvedByStaffUserId: null,
      } as unknown as { paymentPlanId: string; reason: string };
      for (const actor of [tcActor, financeActor]) {
        await expect(
          withdrawPaymentPlan(actor, { paymentPlanId: planId, reason: 'Try to withdraw' }),
        ).rejects.toMatchObject({ code: 'PAYMENT_PLAN_CONFLICT', status: 409 });
        await expect(withdrawPaymentPlan(actor, smuggled)).rejects.toMatchObject({
          code: 'PAYMENT_PLAN_CONFLICT',
        });
      }

      // The repository write itself never matches an APPROVED row.
      const repository = await import('./repository');
      await expect(
        repository.withdrawPaymentPlanRow(prisma!, {
          id: planId,
          withdrawnByStaffUserId: financeActor.id,
          withdrawnAt: new Date(),
          withdrawalReason: 'Direct write',
        }),
      ).resolves.toBeNull();

      const row = await prisma!.paymentPlan.findUniqueOrThrow({ where: { id: planId } });
      expect(row).toMatchObject({
        status: 'APPROVED',
        approvedAt: approved.approvedAt,
        approvedByStaffUserId: financeActor.id,
        withdrawnAt: null,
        withdrawnByStaffUserId: null,
        withdrawalReason: null,
      });
      expect(await planAudits(planId, 'PAYMENT_PLAN_WITHDRAWN')).toHaveLength(0);
    });

    it('withdraws a PROPOSED plan on a CANCELLED booking', async () => {
      const { bookingId, planId } = await proposedPlanFixture();
      await prisma!.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });
      await expect(
        withdrawPaymentPlan(financeActor, { paymentPlanId: planId, reason: 'Booking cancelled' }),
      ).resolves.toMatchObject({ status: 'WITHDRAWN' });
    });

    it('returns an already withdrawn plan unchanged to any authorized repeat, whatever its reason, writing nothing', async () => {
      const { planId } = await proposedPlanFixture();
      const first = await withdrawPaymentPlan(tcActor, {
        paymentPlanId: planId,
        reason: 'Original reason',
      });
      const updatedAt = (await prisma!.paymentPlan.findUniqueOrThrow({ where: { id: planId } }))
        .updatedAt;

      const repeat = await withdrawPaymentPlan(financeActor, {
        paymentPlanId: planId,
        reason: 'A different reason',
      });
      expect(repeat).toEqual(first);
      const row = await prisma!.paymentPlan.findUniqueOrThrow({ where: { id: planId } });
      expect(row.updatedAt).toEqual(updatedAt);
      expect(row.withdrawalReason).toBe('Original reason');
      expect(row.withdrawnByStaffUserId).toBe(tcActor.id);
      expect(await planAudits(planId, 'PAYMENT_PLAN_WITHDRAWN')).toHaveLength(1);

      // A repeat still requires access: an unassigned caller learns nothing.
      await expect(
        withdrawPaymentPlan(unassignedTcActor, { paymentPlanId: planId, reason: 'Repeat' }),
      ).rejects.toMatchObject({ code: 'PAYMENT_PLAN_FORBIDDEN' });
    });

    it('records one PAYMENT_PLAN_WITHDRAWN entry with the complete snapshot', async () => {
      const { bookingId, clientId } = await createAssignedBookingFixture('500.00');
      const plan = await proposePaymentPlan(tcActor, {
        bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '150.00', dueDate: '2026-10-01' },
          { sequenceNumber: 2, isDeposit: false, amount: '350.00', dueDate: '2026-11-15' },
        ],
      });
      const withdrawn = await withdrawPaymentPlan(financeActor, {
        paymentPlanId: plan.id,
        reason: 'Total should be 450.00',
      });

      const [entry, ...rest] = await planAudits(plan.id, 'PAYMENT_PLAN_WITHDRAWN');
      expect(rest).toHaveLength(0);
      expect(entry).toMatchObject({
        actorId: financeActor.id,
        entityType: 'PaymentPlan',
        entityId: plan.id,
        beforeState: {
          id: plan.id,
          bookingId,
          clientId,
          approvedByStaffUserId: null,
          approvedAt: null,
          status: 'PROPOSED',
          installments: [
            { sequenceNumber: 1, isDeposit: true, amount: '150.00', dueDate: '2026-10-01' },
            { sequenceNumber: 2, isDeposit: false, amount: '350.00', dueDate: '2026-11-15' },
          ],
        },
        afterState: {
          status: 'WITHDRAWN',
          withdrawnAt: withdrawn.withdrawnAt!.toISOString(),
          withdrawnByStaffUserId: financeActor.id,
          reason: 'Total should be 450.00',
        },
      });
      const proposed = await planAudits(plan.id, 'PAYMENT_PLAN_PROPOSED');
      expect(proposed[0]?.afterState).toMatchObject({ status: 'PROPOSED' });
    });

    it('refuses to approve a withdrawn plan, and accepts a corrected new plan for the same booking', async () => {
      const { bookingId, planId } = await proposedPlanFixture();
      await withdrawPaymentPlan(tcActor, { paymentPlanId: planId, reason: 'Wrong structure' });
      await expect(
        approvePaymentPlan(financeActor, { paymentPlanId: planId }),
      ).rejects.toMatchObject({ code: 'PAYMENT_PLAN_CONFLICT' });

      const replacement = await proposePaymentPlan(tcActor, {
        bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '200.00', dueDate: '2026-10-01' },
          { sequenceNumber: 2, isDeposit: false, amount: '300.00', dueDate: '2026-11-01' },
        ],
      });
      expect(replacement.id).not.toBe(planId);
      const approved = await approvePaymentPlan(financeActor, { paymentPlanId: replacement.id });
      expect(approved.status).toBe('APPROVED');
      const [approvalAudit, ...otherApprovals] = await planAudits(
        replacement.id,
        'PAYMENT_PLAN_APPROVED',
      );
      expect(otherApprovals).toHaveLength(0);
      expect(approvalAudit?.beforeState).toEqual({ status: 'PROPOSED', approvedAt: null });
      expect(approvalAudit?.afterState).toMatchObject({
        status: 'APPROVED',
        approvedAt: approved.approvedAt!.toISOString(),
        approvedByStaffUserId: financeActor.id,
      });

      const withdrawnRow = await prisma!.paymentPlan.findUniqueOrThrow({ where: { id: planId } });
      expect(withdrawnRow.status).toBe('WITHDRAWN');
      expect(withdrawnRow.approvedAt).toBeNull();
      expect(
        await prisma!.paymentPlan.count({ where: { bookingId, status: { not: 'WITHDRAWN' } } }),
      ).toBe(1);
    });

    it('reports a second active plan as a P2002 on PaymentPlan.bookingId from payment_plan_active_booking_key, and allows one after a withdrawal', async () => {
      const repository = await import('./repository');
      const { isUniqueViolationOn, uniqueViolation } = await import('@/lib/prisma-errors');
      const { bookingId, clientId, planId } = await proposedPlanFixture();

      const insert = () =>
        repository
          .createPaymentPlanWithInstallments(prisma!, {
            id: randomUUID(),
            bookingId,
            clientId,
            proposedByStaffUserId: tcActor.id,
            installments: [
              {
                id: randomUUID(),
                sequenceNumber: 1,
                isDeposit: true,
                amount: '500.00',
                dueDate: new Date('2026-10-01T00:00:00.000Z'),
              },
            ],
          })
          .then(
            () => null,
            (error: unknown) => error,
          );

      const duplicate = await insert();
      expect(uniqueViolation(duplicate)).toEqual({
        modelName: 'PaymentPlan',
        fields: ['bookingId'],
      });
      expect(isUniqueViolationOn(duplicate, 'PaymentPlan', ['bookingId'])).toBe(true);
      expect(JSON.stringify((duplicate as { meta?: unknown }).meta)).toContain(
        'payment_plan_active_booking_key',
      );

      await withdrawPaymentPlan(tcActor, { paymentPlanId: planId, reason: 'Superseded' });
      expect(await insert()).toBeNull();
      expect(await prisma!.paymentPlan.count({ where: { bookingId } })).toBe(2);
    });

    it('enforces the D-057 §2 CHECK constraints in the database', async () => {
      const { planId } = await proposedPlanFixture();
      const attempts: [string, () => Promise<unknown>][] = [
        [
          'payment_plan_status_approval',
          () =>
            prisma!.paymentPlan.update({
              where: { id: planId },
              data: { approvedAt: new Date(), approvedByStaffUserId: financeActor.id },
            }),
        ],
        [
          'payment_plan_status_withdrawal',
          () =>
            prisma!.paymentPlan.update({ where: { id: planId }, data: { status: 'WITHDRAWN' } }),
        ],
        [
          'payment_plan_withdrawal_pairing',
          () =>
            prisma!.paymentPlan.update({
              where: { id: planId },
              data: {
                status: 'WITHDRAWN',
                withdrawnAt: new Date(),
                withdrawnByStaffUserId: tcActor.id,
              },
            }),
        ],
        [
          'payment_plan_withdrawal_reason_required',
          () =>
            prisma!.paymentPlan.update({
              where: { id: planId },
              data: {
                status: 'WITHDRAWN',
                withdrawnAt: new Date(),
                withdrawnByStaffUserId: tcActor.id,
                withdrawalReason: '   ',
              },
            }),
        ],
      ];
      for (const [constraint, attempt] of attempts) {
        const error = await attempt().then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error, constraint).not.toBeNull();
        expect(String((error as Error).message) + JSON.stringify(error), constraint).toContain(
          constraint,
        );
      }
      const row = await prisma!.paymentPlan.findUniqueOrThrow({ where: { id: planId } });
      expect(row).toMatchObject({ status: 'PROPOSED', approvedAt: null, withdrawnAt: null });
    });

    it('resolves concurrent approval and withdrawal of one plan to exactly one outcome, never both', async () => {
      for (let run = 0; run < 4; run += 1) {
        const { planId } = await proposedPlanFixture();
        const [approval, withdrawal] = await Promise.allSettled([
          approvePaymentPlan(financeActor, { paymentPlanId: planId }),
          withdrawPaymentPlan(tcActor, { paymentPlanId: planId, reason: 'Race' }),
        ]);
        const fulfilled = [approval, withdrawal].filter((r) => r.status === 'fulfilled');
        expect(fulfilled).toHaveLength(1);
        for (const result of [approval, withdrawal]) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(PaymentError);
            expect(result.reason).toMatchObject({ code: 'PAYMENT_PLAN_CONFLICT' });
          }
        }
        const row = await prisma!.paymentPlan.findUniqueOrThrow({ where: { id: planId } });
        expect(row.status).toBe(approval.status === 'fulfilled' ? 'APPROVED' : 'WITHDRAWN');
        expect(
          (await planAudits(planId, 'PAYMENT_PLAN_APPROVED')).length +
            (await planAudits(planId, 'PAYMENT_PLAN_WITHDRAWN')).length,
        ).toBe(1);
      }
    }, 60000);

    it('never leaves two active plans when a new proposal races a withdrawal', async () => {
      for (let run = 0; run < 4; run += 1) {
        const { bookingId, planId } = await proposedPlanFixture();
        const [withdrawal, proposal] = await Promise.allSettled([
          withdrawPaymentPlan(financeActor, { paymentPlanId: planId, reason: 'Race' }),
          proposePaymentPlan(tcActor, { bookingId, installments: ONE_INSTALLMENT }),
        ]);
        expect(withdrawal.status).toBe('fulfilled');
        if (proposal.status === 'rejected') {
          expect(proposal.reason).toBeInstanceOf(PaymentError);
          expect(proposal.reason).toMatchObject({ code: 'PAYMENT_PLAN_CONFLICT' });
        }
        expect(
          await prisma!.paymentPlan.count({ where: { bookingId, status: { not: 'WITHDRAWN' } } }),
        ).toBe(proposal.status === 'fulfilled' ? 1 : 0);
      }
    }, 60000);

    it("ignores a withdrawn plan's installments for allocation, and never shows a withdrawn plan to the client", async () => {
      const { bookingId, clientId, planId } = await proposedPlanFixture();
      const payment = await recordPayment(financeActor, {
        bookingId,
        amount: '100.00',
        idempotencyKey: randomUUID(),
      });
      await confirmPayment(financeActor, {
        paymentId: payment.id,
        reason: 'Verified',
        idempotencyKey: randomUUID(),
      });
      const withdrawnInstallment = await prisma!.installment.findFirstOrThrow({
        where: { paymentPlanId: planId },
      });
      await withdrawPaymentPlan(tcActor, { paymentPlanId: planId, reason: 'Wrong structure' });

      await expect(
        createAllocation(financeActor, {
          paymentId: payment.id,
          installmentId: withdrawnInstallment.id,
          amount: '50.00',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'ALLOCATION_NOT_PERMITTED' });

      const clientUser = await createUserFixture('CLIENT');
      await prisma!.clientProfile.create({
        data: { id: randomUUID(), userId: clientUser.id, clientId },
      });
      expect(await getClientPaymentSummaries(clientUser, clientId)).toEqual([]);
      const staffWithoutPlan = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
      expect(staffWithoutPlan.planApproved).toBe(false);
      expect(staffWithoutPlan.installments).toEqual([]);
      expect(staffWithoutPlan.confirmedAmountPaid.toFixed(2)).toBe('100.00');

      // The replacement plan is the one every read now uses.
      const replacement = await proposePaymentPlan(tcActor, {
        bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '400.00', dueDate: '2026-10-01' },
          { sequenceNumber: 2, isDeposit: false, amount: '100.00', dueDate: '2026-11-01' },
        ],
      });
      expect(await getClientPaymentSummaries(clientUser, clientId)).toEqual([]);
      await approvePaymentPlan(financeActor, { paymentPlanId: replacement.id });
      const replacementInstallments = await prisma!.installment.findMany({
        where: { paymentPlanId: replacement.id },
        orderBy: { sequenceNumber: 'asc' },
      });
      await createAllocation(financeActor, {
        paymentId: payment.id,
        installmentId: replacementInstallments[0]!.id,
        amount: '100.00',
        idempotencyKey: randomUUID(),
      });

      const staff = await getBookingPaymentSummaryForStaff(financeActor, bookingId);
      expect(staff.planApproved).toBe(true);
      expect(staff.installments.map((i) => i.id)).toEqual(replacementInstallments.map((i) => i.id));
      const [clientSummary, ...others] = await getClientPaymentSummaries(clientUser, clientId);
      expect(others).toHaveLength(0);
      expect(clientSummary?.installments.map((i) => i.id)).toEqual(
        replacementInstallments.map((i) => i.id),
      );
      expect(JSON.stringify(clientSummary)).not.toContain(withdrawnInstallment.id);
      expect(JSON.stringify(clientSummary)).not.toContain(planId);
    });
  });
});
