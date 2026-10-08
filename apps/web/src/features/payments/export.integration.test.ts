import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { AuthenticatedUser } from '@/lib/auth/guards';

import type { FinanceExportResult } from './export-service';

// Real-PostgreSQL integration coverage for D-061 Stage 2 (basic finance
// exports), as clarified by D-062: D-061 §10's verification criteria that
// cannot be shown with a mocked database — scoping inside the query, the
// in-transaction actor recheck, one snapshot per file, the audit entry
// committed with the read, and the row limit.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/payments/service.integration.test.ts — no static `@/lib/db` or
// service import; everything real is imported dynamically inside
// `beforeAll` only after `TEST_DATABASE_URL` has been validated; the suite
// is skipped entirely when `TEST_DATABASE_URL` is unset. Synthetic data
// only, in `heritage_v3_test` only.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

/** A self-contained copy of the guard every integration suite in this repository carries. */
function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the finance export integration suite.',
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

/** The same database under a connection label of this run's own, so its backends can be told apart. */
function withApplicationName(rawUrl: string, applicationName: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

/** A minimal RFC 4180 reader, independent of the encoder under test. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else {
      field += character;
    }
  }
  return rows;
}

type ParsedExport = { header: string[]; rows: Record<string, string>[] };

function parseExport(result: FinanceExportResult): ParsedExport {
  const [header, ...body] = parseCsv(
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.content).slice(1),
  );
  return {
    header: header ?? [],
    rows: body.map((cells) => {
      expect(cells).toHaveLength((header ?? []).length);
      return Object.fromEntries((header ?? []).map((column, index) => [column, cells[index]!]));
    }),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const TIMESTAMP_CELL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/;
const AMOUNT_CELL = /^\d+\.\d{2}$/;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** The Philippine calendar day of an instant, shifted by `offsetDays`. */
function manilaDay(instant: Date, offsetDays = 0): string {
  return new Date(instant.getTime() + 8 * 60 * 60 * 1000 + offsetDays * MILLISECONDS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

const BLANKABLE_COLUMNS: Record<string, readonly string[]> = {
  bookings: ['derivedNextDueDate', 'derivedNextDueOutstandingAmount', 'paymentPlanStatus'],
  payments: ['confirmedAt', 'reversedAt', 'fullyRefundedAt', 'receiptNumber', 'receiptIssuedAt'],
  refunds: [],
  allocations: ['reversedAt'],
  installments: [],
};

const rawTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasTestDatabaseUrl = typeof rawTestDatabaseUrl === 'string' && rawTestDatabaseUrl.length > 0;

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
const originalRateLimitSecret = process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;

describe.skipIf(!hasTestDatabaseUrl)('finance export integration (real database)', () => {
  // Three separate connection pools, each under its own label for this run:
  // the application's (which the export uses), an observer that also makes
  // the concurrent changes, and a control for the snapshot observable.
  const runId = randomUUID().slice(0, 8);
  const APP_TAG = `fin-export-app-${runId}`;
  const OBSERVER_TAG = `fin-export-observer-${runId}`;
  const CONTROL_TAG = `fin-export-control-${runId}`;

  let prisma: PrismaClient | undefined;
  let observer: PrismaClient | undefined;
  let control: PrismaClient | undefined;
  let Decimal: typeof Prisma.Decimal;
  let RepeatableRead: Prisma.TransactionIsolationLevel;

  let generateFinanceExport: (typeof import('./export-service'))['generateFinanceExport'];
  let FINANCE_EXPORT_TRANSACTION_OPTIONS: (typeof import('./export-service'))['FINANCE_EXPORT_TRANSACTION_OPTIONS'];
  let FinanceExportRequestError: (typeof import('./export-schemas'))['FinanceExportRequestError'];
  let FINANCE_EXPORT_COLUMNS: (typeof import('./export-rows'))['FINANCE_EXPORT_COLUMNS'];
  let PaymentError: (typeof import('./errors'))['PaymentError'];
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
  let createProposal: (typeof import('@/features/proposals/service'))['createProposal'];
  let publishProposalVersion: (typeof import('@/features/proposals/service'))['publishProposalVersion'];
  let recordProposalResponse: (typeof import('@/features/proposals/service'))['recordProposalResponse'];
  let createBooking: (typeof import('@/features/bookings/service'))['createBooking'];

  // Set by the './export-csv' mock below: makes the post-commit encode fail.
  let failEncoding = false;

  let adminActor: AuthenticatedUser;
  let tcActor: AuthenticatedUser;
  let financeActor: AuthenticatedUser;
  let otherFinanceActor: AuthenticatedUser;
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;
  const actorUserIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdBookingIds: string[] = [];
  // Every Booking this suite has assigned to `financeActor`, whenever created.
  const referencesAssignedToFinanceActor = new Set<string>();

  type BookingFixture = { bookingId: string; clientId: string; reference: string };

  // The reconciliation fixture (D-061 §10), built once.
  const SPECIAL_CLIENT_NAME = '=Dela Cruz, "Jun" Niño';
  let bookingA: BookingFixture; // every payment state
  let bookingB: BookingFixture; // proposed plan only
  let bookingC: BookingFixture; // withdrawn plan, then an approved one
  let bookingD: BookingFixture; // no financials
  let bookingE: BookingFixture; // not assigned to `financeActor`
  let payments: Record<
    | 'allocated'
    | 'partlyRefunded'
    | 'fullyRefunded'
    | 'allocationReversed'
    | 'reversed'
    | 'pending'
    | 'old',
    string
  >;
  let refundOfOldPaymentId: string;
  let oldPaymentRecordedAt: Date;

  async function createStaff(role: AuthenticatedUser['role']): Promise<AuthenticatedUser> {
    const id = randomUUID();
    const email = `finance-export-it-${role.toLowerCase()}-${randomUUID()}@example.test`;
    const name = `Export Integration ${role}`;
    await prisma!.user.create({ data: { id, name, email, role, isActive: true } });
    actorUserIds.push(id);
    return { id, name, email, role };
  }

  async function assignBooking(
    bookingId: string,
    staff: AuthenticatedUser,
    role: 'TRAVEL_CONSULTANT' | 'FINANCE_ACCOUNTING',
  ): Promise<string> {
    const id = randomUUID();
    await prisma!.staffAssignment.create({
      data: { id, assignedStaffId: staff.id, assignedByUserId: adminActor.id, role, bookingId },
    });
    return id;
  }

  /**
   * A real Booking through the real proposal → acceptance → booking chain,
   * mirroring service.integration.test.ts's `createAssignedBookingFixture`.
   * `finance: null` leaves it without a Finance/Accounting assignment;
   * `totalAmount: null` leaves its financials unset.
   */
  async function createBookingFixture(options: {
    totalAmount?: string | null;
    finance?: AuthenticatedUser | null;
    clientFullName?: string;
  }): Promise<BookingFixture> {
    const clientId = randomUUID();
    await prisma!.client.create({
      data: {
        id: clientId,
        fullName: options.clientFullName ?? `Export Fixture Client ${randomUUID()}`,
        email: `finance-export-it-${randomUUID()}@example.test`,
      },
    });
    createdClientIds.push(clientId);
    await prisma!.staffAssignment.create({
      data: {
        id: randomUUID(),
        assignedStaffId: tcActor.id,
        assignedByUserId: adminActor.id,
        role: 'TRAVEL_CONSULTANT',
        clientId,
      },
    });

    const { version } = await createProposal(tcActor, {
      clientId,
      content: `Finance export fixture proposal ${randomUUID()}.`,
    });
    await publishProposalVersion(tcActor, version.id, { expectedCurrentVersionId: null });
    await recordProposalResponse(adminActor, version.id, {
      responseType: 'ACCEPT',
      respondedAt: new Date().toISOString(),
      responseMethod: 'phone',
      evidenceReference: `Finance export fixture evidence ${randomUUID()}`,
    });
    const { booking } = await createBooking(tcActor, { proposalVersionId: version.id });
    createdBookingIds.push(booking.id);

    const totalAmount = options.totalAmount === undefined ? '500.00' : options.totalAmount;
    if (totalAmount !== null) {
      await prisma!.booking.update({
        where: { id: booking.id },
        data: { totalAmount, currencyCode: 'PHP' },
      });
    }
    await assignBooking(booking.id, tcActor, 'TRAVEL_CONSULTANT');
    const finance = options.finance === undefined ? financeActor : options.finance;
    if (finance) await assignBooking(booking.id, finance, 'FINANCE_ACCOUNTING');

    const stored = await prisma!.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { bookingReference: true },
    });
    if (finance?.id === financeActor.id)
      referencesAssignedToFinanceActor.add(stored.bookingReference);
    return { bookingId: booking.id, clientId, reference: stored.bookingReference };
  }

  async function confirmedPayment(
    finance: AuthenticatedUser,
    bookingId: string,
    amount: string,
  ): Promise<string> {
    const payment = await recordPayment(finance, {
      bookingId,
      amount,
      idempotencyKey: randomUUID(),
    });
    await confirmPayment(finance, {
      paymentId: payment.id,
      reason: 'Verified against the fixture',
      idempotencyKey: randomUUID(),
    });
    return payment.id;
  }

  /** The service validates its own input, so requests are passed to it as received. */
  async function runExport(actor: AuthenticatedUser, input: unknown): Promise<FinanceExportResult> {
    return generateFinanceExport(actor, input);
  }

  async function exportEntries(actorId: string) {
    return prisma!.auditLog.findMany({
      where: { actorId, action: 'FINANCE_EXPORT_GENERATED' },
      orderBy: { createdAt: 'asc' },
    });
  }

  beforeAll(async () => {
    validateTestDatabaseUrl(rawTestDatabaseUrl!);

    process.env.DATABASE_URL = withApplicationName(rawTestDatabaseUrl!, APP_TAG);
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

    // The real encoder, except that a test can make the one post-commit
    // step fail (D-062 clause 2). The formatters are untouched.
    vi.doMock('./export-csv', async () => {
      const actual = await vi.importActual<typeof import('./export-csv')>('./export-csv');
      return {
        ...actual,
        encodeCsv: (...args: Parameters<typeof actual.encodeCsv>) => {
          if (failEncoding) throw new Error('synthetic encoding failure');
          return actual.encodeCsv(...args);
        },
      };
    });

    ({ prisma } = await import('@/lib/db'));
    const generated = await import('@/generated/prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    Decimal = generated.Prisma.Decimal;
    RepeatableRead = generated.Prisma.TransactionIsolationLevel.RepeatableRead;
    observer = new generated.PrismaClient({
      adapter: new PrismaPg({
        connectionString: withApplicationName(rawTestDatabaseUrl!, OBSERVER_TAG),
      }),
    });
    control = new generated.PrismaClient({
      adapter: new PrismaPg({
        connectionString: withApplicationName(rawTestDatabaseUrl!, CONTROL_TAG),
      }),
    });

    ({ generateFinanceExport, FINANCE_EXPORT_TRANSACTION_OPTIONS } =
      await import('./export-service'));
    ({ FinanceExportRequestError } = await import('./export-schemas'));
    ({ FINANCE_EXPORT_COLUMNS } = await import('./export-rows'));
    ({ PaymentError } = await import('./errors'));
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
    } = await import('./service'));
    ({ createProposal, publishProposalVersion, recordProposalResponse } =
      await import('@/features/proposals/service'));
    ({ createBooking } = await import('@/features/bookings/service'));

    for (const client of [prisma, observer, control]) {
      const rows = await client.$queryRaw<
        { current_database: string }[]
      >`SELECT current_database()`;
      if (rows[0]?.current_database !== REQUIRED_TEST_DATABASE_NAME) {
        throw new Error(
          `Refusing to proceed: a connection reports current_database() = "${rows[0]?.current_database}", not "${REQUIRED_TEST_DATABASE_NAME}".`,
        );
      }
    }

    adminActor = await createStaff('ADMIN_MANAGER');
    tcActor = await createStaff('TRAVEL_CONSULTANT');
    financeActor = await createStaff('FINANCE_ACCOUNTING');
    otherFinanceActor = await createStaff('FINANCE_ACCOUNTING');

    // --- Booking A: every payment state D-061 §10 names ---
    bookingA = await createBookingFixture({
      totalAmount: '1000.00',
      clientFullName: SPECIAL_CLIENT_NAME,
    });
    const planA = await proposePaymentPlan(tcActor, {
      bookingId: bookingA.bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '400.00', dueDate: '2026-11-01' },
        { sequenceNumber: 2, isDeposit: false, amount: '600.00', dueDate: '2026-12-01' },
      ],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: planA.id });
    const installmentsA = await prisma.installment.findMany({
      where: { paymentPlanId: planA.id },
      orderBy: { sequenceNumber: 'asc' },
      select: { id: true },
    });
    const [deposit, balance] = [installmentsA[0]!.id, installmentsA[1]!.id];
    const allocate = async (paymentId: string, installmentId: string, amount: string) =>
      createAllocation(financeActor, {
        paymentId,
        installmentId,
        amount,
        idempotencyKey: randomUUID(),
      });
    const refund = async (paymentId: string, amount: string, allocationId?: string) =>
      refundPayment(financeActor, {
        paymentId,
        amount,
        reason: 'Fixture refund',
        idempotencyKey: randomUUID(),
        ...(allocationId ? { allocationId } : {}),
      });

    // A confirmed payment, fully allocated, with a receipt.
    const allocated = await confirmedPayment(financeActor, bookingA.bookingId, '300.00');
    await allocate(allocated, deposit, '300.00');
    await issueReceipt(financeActor, { paymentId: allocated });

    // A partly refunded payment: one refund through an allocation, one not.
    const partlyRefunded = await confirmedPayment(financeActor, bookingA.bookingId, '200.00');
    const refundedThrough = await allocate(partlyRefunded, deposit, '100.00');
    await refund(partlyRefunded, '50.00', refundedThrough.id);
    await refund(partlyRefunded, '30.00');

    // A fully refunded payment.
    const fullyRefunded = await confirmedPayment(financeActor, bookingA.bookingId, '150.00');
    await refund(fullyRefunded, '150.00');

    // A reversed allocation.
    const allocationReversed = await confirmedPayment(financeActor, bookingA.bookingId, '120.00');
    const toReverse = await allocate(allocationReversed, balance, '120.00');
    await reverseAllocation(financeActor, {
      allocationId: toReverse.id,
      reason: 'Allocated to the wrong installment',
      idempotencyKey: randomUUID(),
    });

    // An allocation whose payment was later reversed.
    const reversed = await confirmedPayment(financeActor, bookingA.bookingId, '80.00');
    await allocate(reversed, balance, '80.00');
    await reversePayment(financeActor, {
      paymentId: reversed,
      reason: 'Recorded in error',
      idempotencyKey: randomUUID(),
    });

    // A payment that was recorded and never confirmed.
    const pending = (
      await recordPayment(financeActor, {
        bookingId: bookingA.bookingId,
        amount: '60.00',
        idempotencyKey: randomUUID(),
      })
    ).id;

    // A payment and a refund dated more than 366 days apart: the payment is
    // moved 400 days into the past, the refund is made now.
    const old = await confirmedPayment(financeActor, bookingA.bookingId, '70.00');
    oldPaymentRecordedAt = new Date(Date.now() - 400 * MILLISECONDS_PER_DAY);
    await prisma.payment.update({ where: { id: old }, data: { createdAt: oldPaymentRecordedAt } });
    await prisma.paymentStatusHistory.updateMany({
      where: { paymentId: old },
      data: { createdAt: oldPaymentRecordedAt },
    });
    refundOfOldPaymentId = (await refund(old, '20.00')).refund.id;

    payments = {
      allocated,
      partlyRefunded,
      fullyRefunded,
      allocationReversed,
      reversed,
      pending,
      old,
    };

    // --- Booking B: a proposed plan only ---
    bookingB = await createBookingFixture({ totalAmount: '500.00' });
    await proposePaymentPlan(tcActor, {
      bookingId: bookingB.bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-11-10' },
      ],
    });

    // --- Booking C: a withdrawn plan and a later approved one ---
    bookingC = await createBookingFixture({ totalAmount: '500.00' });
    const withdrawn = await proposePaymentPlan(tcActor, {
      bookingId: bookingC.bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-10-20' },
      ],
    });
    await withdrawPaymentPlan(tcActor, { paymentPlanId: withdrawn.id, reason: 'Terms changed' });
    const approved = await proposePaymentPlan(tcActor, {
      bookingId: bookingC.bookingId,
      installments: [
        { sequenceNumber: 1, isDeposit: true, amount: '200.00', dueDate: '2026-11-15' },
        { sequenceNumber: 2, isDeposit: false, amount: '300.00', dueDate: '2026-12-15' },
      ],
    });
    await approvePaymentPlan(financeActor, { paymentPlanId: approved.id });

    // --- Booking D: no financials ---
    bookingD = await createBookingFixture({ totalAmount: null });

    // --- Booking E: assigned to another Finance/Accounting user only ---
    bookingE = await createBookingFixture({ totalAmount: '500.00', finance: otherFinanceActor });
    await confirmedPayment(otherFinanceActor, bookingE.bookingId, '90.00');
  }, 180_000);

  afterEach(() => {
    failEncoding = false;
    vi.restoreAllMocks();
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
          await observer?.$disconnect();
          await control?.$disconnect();
        }
      }
    } finally {
      vi.doUnmock('./export-csv');
      process.env.DATABASE_URL = originalDatabaseUrl;
      if (didSetBetterAuthSecret) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
      if (didSetBetterAuthUrl) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
      if (didSetRateLimitSecret) delete process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;
      else process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET = originalRateLimitSecret;
    }
  }, 120_000);

  // --- Shared assertions ---

  /** D-061 §3's within-row identities, which hold on every row under every filter. */
  function expectWithinRowIdentities(dataset: string, rows: Record<string, string>[]): void {
    const money = (value: string) => new Decimal(value);
    const counts = (status: string) => status === 'CONFIRMED' || status === 'REFUNDED';
    for (const row of rows) {
      if (dataset === 'payments') {
        const expectedNet = counts(row.status!)
          ? money(row.amount!).minus(money(row.derivedRefundedTotal!))
          : money('0');
        expect(row.derivedNetContribution).toBe(expectedNet.toFixed(2));
        expect(row.derivedUnallocated).toBe(
          money(row.derivedNetContribution!).minus(money(row.derivedNetAllocated!)).toFixed(2),
        );
      }
      if (dataset === 'allocations') {
        const expectedNet =
          row.reversed === 'false' && counts(row.paymentStatus!)
            ? money(row.amount!).minus(money(row.derivedRefundedThroughAllocation!))
            : money('0');
        expect(row.derivedNetActive).toBe(expectedNet.toFixed(2));
        expect(row.reversedAt === '').toBe(row.reversed === 'false');
      }
      if (dataset === 'installments') {
        const outstanding = money(row.amount!).minus(money(row.derivedNetActiveAllocation!));
        expect(row.derivedOutstandingAmount).toBe(
          (outstanding.isNegative() ? money('0') : outstanding).toFixed(2),
        );
      }
    }
  }

  /** Format rules that hold for every cell of every file (D-061 §4, D-062 clause 4). */
  function expectCellFormats(dataset: string, parsed: ParsedExport, asOf: string): void {
    const blankable = BLANKABLE_COLUMNS[dataset]!;
    for (const row of parsed.rows) {
      expect(row.asOf).toBe(asOf);
      for (const [column, value] of Object.entries(row)) {
        if (value === '') {
          // Only the listed columns may be blank.
          expect(blankable, `${dataset}.${column} must never be blank`).toContain(column);
          continue;
        }
        if (/At$|^asOf$/.test(column)) {
          expect(value, `${dataset}.${column}`).toMatch(TIMESTAMP_CELL);
        } else if (/amount$|^derived(?!NextDueDate)/i.test(column)) {
          expect(value, `${dataset}.${column}`).toMatch(AMOUNT_CELL);
        } else if (/dueDate$/i.test(column)) {
          expect(value, `${dataset}.${column}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
      if ('currencyCode' in row) expect(row.currencyCode).toBe('PHP');
    }
  }

  const sum = (rows: Record<string, string>[], column: string): string =>
    rows.reduce((total, row) => total.plus(new Decimal(row[column]!)), new Decimal(0)).toFixed(2);

  // --- Request validation at the service boundary ---

  describe('request validation at the boundary', () => {
    const reference = () => bookingA.reference;
    const cases: [string, () => unknown][] = [
      ['null', () => null],
      ['a string', () => 'bookings'],
      ['an array', () => [{ dataset: 'bookings' }]],
      ['an empty object', () => ({})],
      ['an unknown dataset', () => ({ dataset: 'ledger' })],
      ['a dataset of the wrong type', () => ({ dataset: 42 })],
      [
        'payments with neither a date range nor a booking reference',
        () => ({ dataset: 'payments' }),
      ],
      ['refunds with neither', () => ({ dataset: 'refunds' })],
      ['allocations with neither', () => ({ dataset: 'allocations' })],
      ['installments with neither', () => ({ dataset: 'installments' })],
      [
        'payments with a status but no range or reference',
        () => ({ dataset: 'payments', status: 'CONFIRMED' }),
      ],
      ['a range with only its start', () => ({ dataset: 'payments', from: '2026-01-01' })],
      ['a range with only its end', () => ({ dataset: 'refunds', to: '2026-01-31' })],
      [
        'a range whose start is after its end',
        () => ({ dataset: 'payments', from: '2026-02-01', to: '2026-01-31' }),
      ],
      [
        'a range of 367 days',
        () => ({ dataset: 'payments', from: '2024-01-01', to: '2025-01-01' }),
      ],
      [
        'a date that is not a calendar day',
        () => ({ dataset: 'payments', from: '2026-02-30', to: '2026-03-01' }),
      ],
      [
        'bookings with a date range',
        () => ({ dataset: 'bookings', from: '2026-01-01', to: '2026-01-31' }),
      ],
      ['bookings with a payment status', () => ({ dataset: 'bookings', status: 'CONFIRMED' })],
      [
        'refunds with a payment status',
        () => ({ dataset: 'refunds', bookingReference: reference(), status: 'CONFIRMED' }),
      ],
      [
        'an unknown payment status',
        () => ({ dataset: 'payments', bookingReference: reference(), status: 'PAID' }),
      ],
      [
        'a malformed booking reference',
        () => ({ dataset: 'payments', bookingReference: 'HPB-123' }),
      ],
      [
        'a booking id in place of a reference',
        () => ({ dataset: 'payments', bookingId: bookingA.bookingId }),
      ],
      [
        'an unknown field',
        () => ({ dataset: 'payments', bookingReference: reference(), columns: ['amount'] }),
      ],
    ];

    it.each(cases)('refuses %s before any transaction, with no entry', async (_label, build) => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      const transaction = vi.spyOn(prisma!, '$transaction');

      const refusal = await generateFinanceExport(finance, build()).catch(
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(FinanceExportRequestError);
      expect(
        (refusal as InstanceType<typeof FinanceExportRequestError>).issues.length,
      ).toBeGreaterThan(0);
      expect(refusal).not.toHaveProperty('content');
      // No transaction was opened, so nothing was read and nothing recorded.
      expect(transaction).not.toHaveBeenCalled();
      expect(await exportEntries(finance.id)).toEqual([]);
    });

    it('does not repeat the rejected input in the error', async () => {
      const marker = `HPB-${'Z'.repeat(20)}-secret-marker`;
      const refusal = (await generateFinanceExport(financeActor, {
        dataset: 'payments',
        bookingReference: marker,
      }).catch((error: unknown) => error)) as InstanceType<typeof FinanceExportRequestError>;
      expect(refusal).toBeInstanceOf(FinanceExportRequestError);
      expect(JSON.stringify({ message: refusal.message, issues: refusal.issues })).not.toContain(
        'secret-marker',
      );
    });

    it('checks the role before the input', async () => {
      const consultant = await createStaff('TRAVEL_CONSULTANT');
      await expect(generateFinanceExport(consultant, { dataset: 'ledger' })).rejects.toMatchObject({
        code: 'ROLE_NOT_PERMITTED',
      });
    });

    it('still serves a valid request through the same path', async () => {
      const result = await generateFinanceExport(financeActor, {
        dataset: 'installments',
        bookingReference: bookingA.reference,
      });
      expect(result.rowCount).toBe(2);
    });
  });

  // --- Format ---

  describe('format', () => {
    it('writes the exact header row, a byte-order mark, and conforming cells for every dataset', async () => {
      for (const dataset of [
        'bookings',
        'payments',
        'refunds',
        'allocations',
        'installments',
      ] as const) {
        const result = await runExport(financeActor, {
          dataset,
          bookingReference: bookingA.reference,
        });
        expect([...result.content.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        const parsed = parseExport(result);
        expect(parsed.header).toEqual([...FINANCE_EXPORT_COLUMNS[dataset]]);
        expect(parsed.rows.length).toBeGreaterThan(0);
        expect(parsed.rows).toHaveLength(result.rowCount);
        const asOf = parsed.rows[0]!.asOf!;
        expect(asOf).toMatch(TIMESTAMP_CELL);
        expectCellFormats(dataset, parsed, asOf);
        expect(result.filename).toMatch(
          new RegExp(`^heritage-finance-${dataset}-v1-all-dates-\\d{8}T\\d{6}\\+0800\\.csv$`),
        );
        // The filename's time is asOf in whole seconds with the fraction dropped.
        expect(result.filename).toContain(`${asOf.slice(0, 19).replaceAll(/[-:]/g, '')}+0800`);
      }
    });

    it('uses the dated filename form, and no name or reference, when a range is given', async () => {
      const from = manilaDay(new Date(), -1);
      const to = manilaDay(new Date(), 1);
      const result = await runExport(financeActor, { dataset: 'payments', from, to });
      expect(result.filename).toMatch(
        new RegExp(
          `^heritage-finance-payments-v1-${from.replaceAll('-', '')}_${to.replaceAll('-', '')}-\\d{8}T\\d{6}\\+0800\\.csv$`,
        ),
      );
      expect(result.filename).not.toContain('HPB-');
    });

    it('prefixes a client name that begins with a formula character and keeps the rest intact', async () => {
      for (const dataset of ['bookings', 'payments'] as const) {
        const parsed = parseExport(
          await runExport(financeActor, { dataset, bookingReference: bookingA.reference }),
        );
        for (const row of parsed.rows) {
          expect(row.clientFullName).toBe(`'${SPECIAL_CLIENT_NAME}`);
        }
      }
    });

    it('carries a client name only in bookings and payments', async () => {
      for (const dataset of ['refunds', 'allocations', 'installments'] as const) {
        const result = await runExport(financeActor, {
          dataset,
          bookingReference: bookingA.reference,
        });
        expect(new TextDecoder().decode(result.content)).not.toContain('Dela Cruz');
      }
    });
  });

  // --- Reconciliation ---

  describe('reconciliation', () => {
    it('holds every within-row identity under every filter', async () => {
      const from = manilaDay(new Date(), -1);
      const to = manilaDay(new Date(), 1);
      const requests: unknown[] = [
        { dataset: 'payments', bookingReference: bookingA.reference },
        { dataset: 'payments', from, to },
        { dataset: 'payments', from, to, bookingReference: bookingA.reference },
        ...(['PENDING', 'CONFIRMED', 'REFUNDED', 'REVERSED'] as const).map((status) => ({
          dataset: 'payments',
          bookingReference: bookingA.reference,
          status,
        })),
        { dataset: 'allocations', bookingReference: bookingA.reference },
        { dataset: 'allocations', from, to },
        { dataset: 'installments', bookingReference: bookingA.reference },
        { dataset: 'installments', from: '2026-11-01', to: '2026-12-31' },
        { dataset: 'installments', from: '2026-11-01', to: '2026-11-30' },
      ];
      for (const request of requests) {
        const result = await runExport(financeActor, request);
        const parsed = parseExport(result);
        expectWithinRowIdentities(result.dataset, parsed.rows);
        if (parsed.rows.length > 0) {
          expectCellFormats(result.dataset, parsed, parsed.rows[0]!.asOf!);
        }
      }
    });

    it('represents each payment state as one positive row with state, never a negative row', async () => {
      const parsed = parseExport(
        await runExport(financeActor, {
          dataset: 'payments',
          bookingReference: bookingA.reference,
        }),
      );
      const byId = new Map(parsed.rows.map((row) => [row.paymentId!, row]));
      expect(parsed.rows).toHaveLength(7);

      expect(byId.get(payments.allocated)).toMatchObject({
        amount: '300.00',
        status: 'CONFIRMED',
        derivedRefundedTotal: '0.00',
        derivedNetContribution: '300.00',
        derivedNetAllocated: '300.00',
        derivedUnallocated: '0.00',
      });
      expect(byId.get(payments.allocated)!.receiptNumber).not.toBe('');
      expect(byId.get(payments.allocated)!.receiptIssuedAt).toMatch(TIMESTAMP_CELL);

      expect(byId.get(payments.partlyRefunded)).toMatchObject({
        amount: '200.00',
        status: 'CONFIRMED',
        derivedRefundedTotal: '80.00',
        derivedNetContribution: '120.00',
        derivedNetAllocated: '50.00',
        derivedUnallocated: '70.00',
        fullyRefundedAt: '',
      });

      expect(byId.get(payments.fullyRefunded)).toMatchObject({
        amount: '150.00',
        status: 'REFUNDED',
        derivedRefundedTotal: '150.00',
        derivedNetContribution: '0.00',
      });
      expect(byId.get(payments.fullyRefunded)!.fullyRefundedAt).toMatch(TIMESTAMP_CELL);

      expect(byId.get(payments.allocationReversed)).toMatchObject({
        amount: '120.00',
        derivedNetContribution: '120.00',
        derivedNetAllocated: '0.00',
        derivedUnallocated: '120.00',
      });

      expect(byId.get(payments.reversed)).toMatchObject({
        amount: '80.00',
        status: 'REVERSED',
        derivedNetContribution: '0.00',
        derivedNetAllocated: '0.00',
      });
      expect(byId.get(payments.reversed)!.reversedAt).toMatch(TIMESTAMP_CELL);
      expect(byId.get(payments.reversed)!.confirmedAt).toMatch(TIMESTAMP_CELL);

      expect(byId.get(payments.pending)).toMatchObject({
        amount: '60.00',
        status: 'PENDING',
        confirmedAt: '',
        reversedAt: '',
        fullyRefundedAt: '',
        receiptNumber: '',
        receiptIssuedAt: '',
        derivedNetContribution: '0.00',
      });
    });

    it('agrees across files for one Booking exported whole', async () => {
      const exportA = async (dataset: string) =>
        parseExport(
          await runExport(financeActor, { dataset, bookingReference: bookingA.reference }),
        ).rows;
      const [bookingRows, paymentRows, refundRows, allocationRows, installmentRows] = [
        await exportA('bookings'),
        await exportA('payments'),
        await exportA('refunds'),
        await exportA('allocations'),
        await exportA('installments'),
      ];
      expect(bookingRows).toHaveLength(1);

      // Payments' net contributions add up to the Booking's net confirmed paid.
      expect(sum(paymentRows, 'derivedNetContribution')).toBe(
        bookingRows[0]!.derivedNetConfirmedPaid,
      );
      expect(bookingRows[0]!.derivedNetConfirmedPaid).toBe('590.00');

      // One payment's refunds add up to its refunded total.
      for (const payment of paymentRows) {
        expect(
          sum(
            refundRows.filter((refund) => refund.paymentId === payment.paymentId),
            'amount',
          ),
        ).toBe(payment.derivedRefundedTotal);
        // One payment's allocations' net active values add up to its net allocated.
        expect(
          sum(
            allocationRows.filter((allocation) => allocation.paymentId === payment.paymentId),
            'derivedNetActive',
          ),
        ).toBe(payment.derivedNetAllocated);
      }

      // One installment's allocations' net active values add up to its net active allocation.
      for (const installment of installmentRows) {
        expect(
          sum(
            allocationRows.filter(
              (allocation) => allocation.installmentSequenceNumber === installment.sequenceNumber,
            ),
            'derivedNetActive',
          ),
        ).toBe(installment.derivedNetActiveAllocation);
      }

      // A refund's allocated portion: 50.00 through an allocation, 0.00 otherwise.
      expect(refundRows.map((refund) => refund.derivedAllocatedPortion).sort()).toEqual([
        '0.00',
        '0.00',
        '0.00',
        '50.00',
      ]);
    });

    it('does not agree across files once a filter removes rows, as documented', async () => {
      // A date range that holds the old payment but not its refund.
      const from = manilaDay(oldPaymentRecordedAt, -1);
      const to = manilaDay(oldPaymentRecordedAt, 1);
      const oldPayments = parseExport(
        await runExport(financeActor, {
          dataset: 'payments',
          from,
          to,
          bookingReference: bookingA.reference,
        }),
      ).rows;
      const oldRefunds = parseExport(
        await runExport(financeActor, {
          dataset: 'refunds',
          from,
          to,
          bookingReference: bookingA.reference,
        }),
      ).rows;
      expect(oldPayments.map((row) => row.paymentId)).toEqual([payments.old]);
      // The derived value still counts the refund the refunds file omits.
      expect(oldPayments[0]!.derivedRefundedTotal).toBe('20.00');
      expect(oldRefunds).toEqual([]);

      // A payment-status filter: the remaining rows no longer add up.
      const bookingRow = parseExport(
        await runExport(financeActor, {
          dataset: 'bookings',
          bookingReference: bookingA.reference,
        }),
      ).rows[0]!;
      const refundedOnly = parseExport(
        await runExport(financeActor, {
          dataset: 'payments',
          bookingReference: bookingA.reference,
          status: 'REFUNDED',
        }),
      ).rows;
      expect(refundedOnly.map((row) => row.paymentId)).toEqual([payments.fullyRefunded]);
      expect(sum(refundedOnly, 'derivedNetContribution')).not.toBe(
        bookingRow.derivedNetConfirmedPaid,
      );
    });

    it("holds a Booking's rows older than 366 days when exported by reference alone", async () => {
      const paymentRows = parseExport(
        await runExport(financeActor, {
          dataset: 'payments',
          bookingReference: bookingA.reference,
        }),
      ).rows;
      const old = paymentRows.find((row) => row.paymentId === payments.old)!;
      // recordedAt is Payment.createdAt (D-062 clause 5).
      expect(old.recordedAt).toBe(
        `${new Date(oldPaymentRecordedAt.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 23)}+08:00`,
      );
      const refundRows = parseExport(
        await runExport(financeActor, { dataset: 'refunds', bookingReference: bookingA.reference }),
      ).rows;
      expect(refundRows.map((row) => row.refundId)).toContain(refundOfOldPaymentId);
    });

    it('equals the existing service calculation for the same data', async () => {
      for (const fixture of [bookingA, bookingB, bookingC]) {
        const summary = await getBookingPaymentSummaryForStaff(financeActor, fixture.bookingId);
        const bookingRow = parseExport(
          await runExport(financeActor, {
            dataset: 'bookings',
            bookingReference: fixture.reference,
          }),
        ).rows[0]!;
        expect(bookingRow.bookingTotalAmount).toBe(summary.totalAmount!.toFixed(2));
        expect(bookingRow.derivedNetConfirmedPaid).toBe(summary.confirmedAmountPaid.toFixed(2));
        expect(bookingRow.derivedRemainingBalance).toBe(summary.remainingBalance!.toFixed(2));
        expect(bookingRow.derivedOverpayment).toBe(summary.overpayment!.toFixed(2));
        expect(bookingRow.derivedUnappliedCredit).toBe(summary.unappliedCredit.toFixed(2));
        expect(bookingRow.paymentPlanStatus).toBe(summary.activePlan?.status ?? '');
        if (summary.planApproved) {
          expect(bookingRow.derivedNextDueDate).toBe(
            summary.nextPaymentDue?.toISOString().slice(0, 10) ?? '',
          );
          expect(bookingRow.derivedNextDueOutstandingAmount).toBe(
            summary.nextPaymentDueAmount?.toFixed(2) ?? '',
          );
          const installmentRows = parseExport(
            await runExport(financeActor, {
              dataset: 'installments',
              bookingReference: fixture.reference,
            }),
          ).rows;
          expect(installmentRows.map((row) => row.derivedOutstandingAmount)).toEqual(
            summary.installments.map((installment) => installment.outstandingAmount.toFixed(2)),
          );
        }
      }
    });
  });

  // --- Blank values and plan selection ---

  describe('blank values and plan selection', () => {
    it('leaves a Booking with no financials out of bookings', async () => {
      const result = await runExport(financeActor, {
        dataset: 'bookings',
        bookingReference: bookingD.reference,
      });
      expect(result.rowCount).toBe(0);
      const all = parseExport(await runExport(financeActor, { dataset: 'bookings' })).rows;
      expect(all.map((row) => row.bookingReference)).not.toContain(bookingD.reference);
    });

    it('reports a proposed plan with blank next-due columns, never zero', async () => {
      const row = parseExport(
        await runExport(financeActor, {
          dataset: 'bookings',
          bookingReference: bookingB.reference,
        }),
      ).rows[0]!;
      expect(row.paymentPlanStatus).toBe('PROPOSED');
      expect(row.derivedNextDueDate).toBe('');
      expect(row.derivedNextDueOutstandingAmount).toBe('');
      expect(row.derivedNetConfirmedPaid).toBe('0.00');
    });

    it('reports the active plan and never the withdrawn one', async () => {
      const row = parseExport(
        await runExport(financeActor, {
          dataset: 'bookings',
          bookingReference: bookingC.reference,
        }),
      ).rows[0]!;
      expect(row.paymentPlanStatus).toBe('APPROVED');
      expect(row.derivedNextDueDate).toBe('2026-11-15');
      expect(row.derivedNextDueOutstandingAmount).toBe('200.00');
    });

    it('exports installments of the approved plan only', async () => {
      const proposedOnly = await runExport(financeActor, {
        dataset: 'installments',
        bookingReference: bookingB.reference,
      });
      expect(proposedOnly.rowCount).toBe(0);

      const afterWithdrawal = parseExport(
        await runExport(financeActor, {
          dataset: 'installments',
          bookingReference: bookingC.reference,
        }),
      ).rows;
      // The withdrawn plan's single 500.00 installment due 2026-10-20 is absent.
      expect(afterWithdrawal.map((row) => [row.sequenceNumber, row.amount, row.dueDate])).toEqual([
        ['1', '200.00', '2026-11-15'],
        ['2', '300.00', '2026-12-15'],
      ]);
    });

    it('filters installments by due date as a calendar date, both ends inclusive', async () => {
      const rows = parseExport(
        await runExport(financeActor, {
          dataset: 'installments',
          from: '2026-11-15',
          to: '2026-12-01',
        }),
      ).rows;
      const mine = rows
        .filter((row) => [bookingA.reference, bookingC.reference].includes(row.bookingReference!))
        .map((row) => row.dueDate)
        .sort();
      expect(mine).toEqual(['2026-11-15', '2026-12-01']);
    });
  });

  // --- Authorization ---

  describe('authorization', () => {
    it('gives a Finance user only assigned Bookings', async () => {
      const result = await runExport(financeActor, { dataset: 'bookings' });
      expect(result.scope).toBe('ASSIGNED_BOOKINGS');
      const references = parseExport(result).rows.map((row) => row.bookingReference!);
      expect(references).toEqual([...references].sort());
      for (const fixture of [bookingA, bookingB, bookingC]) {
        expect(references).toContain(fixture.reference);
      }
      // Nothing outside this user's own assignments: not another Finance
      // user's Booking, and not the assigned Booking that has no financials.
      for (const reference of references) {
        expect(referencesAssignedToFinanceActor).toContain(reference);
      }
      expect(references).not.toContain(bookingE.reference);
      expect(references).not.toContain(bookingD.reference);
    });

    it('gives an empty file for a booking reference the Finance user is not assigned to', async () => {
      for (const dataset of ['bookings', 'payments'] as const) {
        const result = await runExport(financeActor, {
          dataset,
          bookingReference: bookingE.reference,
        });
        expect(result.rowCount).toBe(0);
        expect(parseExport(result)).toEqual({
          header: [...FINANCE_EXPORT_COLUMNS[dataset]],
          rows: [],
        });
      }
      // The assigned Finance user does see it, so the empty file is scope, not absence.
      const own = await runExport(otherFinanceActor, {
        dataset: 'payments',
        bookingReference: bookingE.reference,
      });
      expect(own.rowCount).toBe(1);
    });

    it('never lets a date range reach an unassigned Booking', async () => {
      const rows = parseExport(
        await runExport(financeActor, {
          dataset: 'payments',
          from: manilaDay(new Date(), -1),
          to: manilaDay(new Date(), 1),
        }),
      ).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.bookingReference)).not.toContain(bookingE.reference);
    });

    it('gives Admin / Manager every Booking', async () => {
      const result = await runExport(adminActor, { dataset: 'bookings' });
      expect(result.scope).toBe('ALL_BOOKINGS');
      const references = parseExport(result).rows.map((row) => row.bookingReference);
      for (const fixture of [bookingA, bookingB, bookingC, bookingE]) {
        expect(references).toContain(fixture.reference);
      }
      expect(references).not.toContain(bookingD.reference);
    });

    it('takes a Booking away when the assignment is ended', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      const fixture = await createBookingFixture({ finance: null });
      const assignmentId = await assignBooking(fixture.bookingId, finance, 'FINANCE_ACCOUNTING');
      const request = { dataset: 'bookings', bookingReference: fixture.reference };

      expect((await runExport(finance, request)).rowCount).toBe(1);
      await prisma!.staffAssignment.update({
        where: { id: assignmentId },
        data: { endedAt: new Date() },
      });
      expect((await runExport(finance, request)).rowCount).toBe(0);
    });

    it('refuses an actor deactivated after the session was issued, with no file and no entry', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      await prisma!.user.update({ where: { id: finance.id }, data: { isActive: false } });
      // `finance` still carries the role its session was issued with.
      await expect(runExport(finance, { dataset: 'bookings' })).rejects.toMatchObject({
        code: 'ROLE_NOT_PERMITTED',
        status: 403,
      });
      expect(await exportEntries(finance.id)).toEqual([]);
    });

    it('refuses an actor whose stored role no longer permits export, with no file and no entry', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      await prisma!.user.update({ where: { id: finance.id }, data: { role: 'TRAVEL_CONSULTANT' } });
      await expect(runExport(finance, { dataset: 'bookings' })).rejects.toMatchObject({
        code: 'ROLE_NOT_PERMITTED',
      });
      expect(await exportEntries(finance.id)).toEqual([]);
    });

    it('scopes by the stored role, not the session role', async () => {
      const demoted = await createStaff('ADMIN_MANAGER');
      const fixture = await createBookingFixture({ finance: null });
      await assignBooking(fixture.bookingId, demoted, 'FINANCE_ACCOUNTING');
      await prisma!.user.update({
        where: { id: demoted.id },
        data: { role: 'FINANCE_ACCOUNTING' },
      });

      // The session still says ADMIN_MANAGER.
      expect(demoted.role).toBe('ADMIN_MANAGER');
      const result = await runExport(demoted, { dataset: 'bookings' });
      expect(result.scope).toBe('ASSIGNED_BOOKINGS');
      expect(parseExport(result).rows.map((row) => row.bookingReference)).toEqual([
        fixture.reference,
      ]);
      const entries = await exportEntries(demoted.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.afterState).toMatchObject({
        scope: 'ASSIGNED_BOOKINGS',
        actorRole: 'FINANCE_ACCOUNTING',
      });
    });

    it.each(['TRAVEL_CONSULTANT', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'] as const)(
      'refuses %s',
      async (role) => {
        const actor = await createStaff(role);
        await expect(
          runExport(actor, { dataset: 'payments', bookingReference: bookingA.reference }),
        ).rejects.toBeInstanceOf(PaymentError);
        await expect(
          runExport(actor, { dataset: 'payments', bookingReference: bookingA.reference }),
        ).rejects.toMatchObject({ code: 'ROLE_NOT_PERMITTED', status: 403 });
        expect(await exportEntries(actor.id)).toEqual([]);
      },
    );

    it('refuses an actor whose account does not exist', async () => {
      const ghost: AuthenticatedUser = {
        id: randomUUID(),
        name: 'No Such Account',
        email: 'no-such-account@example.test',
        role: 'FINANCE_ACCOUNTING',
      };
      await expect(runExport(ghost, { dataset: 'bookings' })).rejects.toMatchObject({
        code: 'ROLE_NOT_PERMITTED',
      });
    });
  });

  // --- Audit ---

  describe('audit', () => {
    it('writes exactly one entry per export, with the metadata and no row data', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      const fixture = await createBookingFixture({ finance, clientFullName: 'Maria Santos' });
      await confirmedPayment(finance, fixture.bookingId, '125.00');
      const from = manilaDay(new Date(), -1);
      const to = manilaDay(new Date(), 1);

      const result = await runExport(finance, {
        dataset: 'payments',
        from,
        to,
        bookingReference: fixture.reference,
        status: 'CONFIRMED',
      });
      const parsed = parseExport(result);
      const entries = await exportEntries(finance.id);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry).toMatchObject({
        actorKind: 'USER',
        actorId: finance.id,
        action: 'FINANCE_EXPORT_GENERATED',
        entityType: 'FinanceExport',
        entityId: result.exportId,
        beforeState: null,
      });
      expect(entry.afterState).toEqual({
        dataset: 'payments',
        formatVersion: 'v1',
        from,
        to,
        bookingReference: fixture.reference,
        status: 'CONFIRMED',
        scope: 'ASSIGNED_BOOKINGS',
        actorRole: 'FINANCE_ACCOUNTING',
        rowCount: 1,
        bookingCount: 1,
        // Every row carries the same asOf, equal to the entry's.
        asOf: parsed.rows[0]!.asOf,
      });
      const stored = JSON.stringify(entry.afterState);
      expect(stored).not.toContain('Maria');
      expect(stored).not.toContain('125.00');
      expect(stored).not.toContain(parsed.rows[0]!.paymentId!);
    });

    it('records a filter only when it was given, and an empty export all the same', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      const result = await runExport(finance, { dataset: 'bookings' });
      expect(result.rowCount).toBe(0);
      const entries = await exportEntries(finance.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.afterState).toEqual({
        dataset: 'bookings',
        formatVersion: 'v1',
        scope: 'ASSIGNED_BOOKINGS',
        actorRole: 'FINANCE_ACCOUNTING',
        rowCount: 0,
        bookingCount: 0,
        asOf: expect.stringMatching(TIMESTAMP_CELL),
      });
    });

    it('records the same request sent twice as two exports', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      const first = await runExport(finance, { dataset: 'bookings' });
      const second = await runExport(finance, { dataset: 'bookings' });
      expect(second.exportId).not.toBe(first.exportId);
      const entries = await exportEntries(finance.id);
      expect(entries.map((entry) => entry.entityId)).toEqual([first.exportId, second.exportId]);
    });

    it('counts distinct Bookings', async () => {
      const result = await runExport(financeActor, {
        dataset: 'installments',
        from: '2026-11-01',
        to: '2026-12-31',
      });
      const rows = parseExport(result).rows;
      expect(result.bookingCount).toBe(new Set(rows.map((row) => row.bookingReference)).size);
      expect(result.bookingCount).toBe(2);
      expect(result.rowCount).toBe(4);
    });
  });

  // --- Transaction, snapshot, and failure paths ---

  type BackendObservation = {
    pid: number;
    state: string | null;
    backendXmin: string | null;
    query: string;
  };

  /** The backends of one labelled pool that are inside a transaction, as the server reports them. */
  async function openBackends(tag: string): Promise<BackendObservation[]> {
    return observer!.$queryRaw<BackendObservation[]>`
      SELECT pid::int AS "pid", state AS "state", backend_xmin::text AS "backendXmin", query AS "query"
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${tag} AND xact_start IS NOT NULL
    `;
  }

  /** Polls until the one open backend of `tag` is idle in its transaction; `state` is reported with a small lag. */
  async function idleBackend(tag: string): Promise<BackendObservation> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const backends = await openBackends(tag);
      if (backends.length === 1 && backends[0]!.state === 'idle in transaction') {
        return backends[0]!;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Expected exactly one idle-in-transaction backend for ${tag}; saw ${JSON.stringify(backends)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function expectNoOpenBackend(tag: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const backends = await openBackends(tag);
      if (backends.length === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`A transaction is still open for ${tag}: ${JSON.stringify(backends)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  type TransactionHooks = {
    /** Runs after the transaction is open and before the service issues any statement. */
    beforeFirstStatement?: () => Promise<void>;
    /** Runs once the service's first statement has returned, before its second is issued. */
    afterFirstStatement?: (tx: Prisma.TransactionClient) => Promise<void>;
    /** Runs inside the transaction after the service's own work, before commit. */
    beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
    options?: (options: Record<string, unknown>) => Record<string, unknown>;
  };

  /**
   * Wraps the application client's `$transaction` — no seam exists in the
   * service for this. Records the options the service passed and what the
   * service touched on the transaction client before its first raw
   * statement returned.
   */
  function interceptExportTransaction(hooks: TransactionHooks) {
    const app = prisma!;
    const original = app.$transaction.bind(app) as (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    const seen = {
      options: [] as unknown[],
      rawStatements: 0,
      touchedBeforeFirstStatementReturned: [] as string[],
    };
    vi.spyOn(app, '$transaction').mockImplementation(((
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options: Record<string, unknown>,
    ) => {
      seen.options.push(options);
      return original(
        async (tx) => {
          if (hooks.beforeFirstStatement) await hooks.beforeFirstStatement();
          let firstReturned = false;
          const proxied = new Proxy(tx, {
            get(target, property) {
              if (property === '$queryRaw') {
                return (...args: unknown[]) => {
                  const call = (
                    target.$queryRaw as unknown as (...inner: unknown[]) => Promise<unknown>
                  )(...args);
                  seen.rawStatements += 1;
                  if (seen.rawStatements > 1) return call;
                  return (async () => {
                    const rows = await call;
                    firstReturned = true;
                    if (hooks.afterFirstStatement) await hooks.afterFirstStatement(target);
                    return rows;
                  })();
                };
              }
              if (!firstReturned && typeof property === 'string') {
                seen.touchedBeforeFirstStatementReturned.push(property);
              }
              return Reflect.get(target, property);
            },
          });
          const result = await fn(proxied);
          if (hooks.beforeCommit) await hooks.beforeCommit(tx);
          return result;
        },
        hooks.options ? hooks.options(options) : options,
      );
    }) as unknown as typeof app.$transaction);
    return seen;
  }

  async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS "pid"`;
    return rows[0]!.pid;
  }

  /** A confirmed payment written by the observer connection: a concurrent, committed change. */
  async function commitConcurrentPayment(fixture: BookingFixture, amount: string): Promise<string> {
    const id = randomUUID();
    await observer!.payment.create({
      data: {
        id,
        bookingId: fixture.bookingId,
        clientId: fixture.clientId,
        amount,
        status: 'CONFIRMED',
      },
    });
    return id;
  }

  describe('one statement at a time', () => {
    it('never issues a statement while another is in flight on the export connection', async () => {
      // pg 8 deprecates, and pg 9 removes, calling query() on a client that
      // is still executing one. Inside a transaction every statement shares
      // one client, so the export must issue them strictly one at a time.
      const pg = (await import('pg')).default;
      type QueryableClient = {
        _queryQueue?: unknown[];
        _activeQuery?: unknown;
      };
      const original = pg.Client.prototype.query;
      const overlapping: string[] = [];
      let statements = 0;
      let statementsWithBothFields = 0;
      const patched = function (this: QueryableClient, ...args: unknown[]) {
        statements += 1;
        if (Array.isArray(this._queryQueue) && '_activeQuery' in this)
          statementsWithBothFields += 1;
        const busy = (this._queryQueue?.length ?? 0) > 0 || Boolean(this._activeQuery);
        if (busy) {
          const first = args[0] as string | { text?: string } | undefined;
          const text = typeof first === 'string' ? first : (first?.text ?? '');
          overlapping.push(text.replace(/\s+/g, ' ').slice(0, 120));
        }
        return (original as (...inner: unknown[]) => unknown).apply(this, args);
      };
      pg.Client.prototype.query = patched as unknown as typeof original;
      try {
        for (const actor of [financeActor, adminActor]) {
          for (const dataset of [
            'bookings',
            'payments',
            'refunds',
            'allocations',
            'installments',
          ]) {
            const result = await runExport(actor, {
              dataset,
              bookingReference: bookingA.reference,
            });
            expect(result.rowCount).toBeGreaterThan(0);
          }
        }
        await runExport(financeActor, {
          dataset: 'payments',
          from: manilaDay(new Date(), -1),
          to: manilaDay(new Date(), 1),
        });
      } finally {
        pg.Client.prototype.query = original;
      }
      // The interception saw the export's statements, and on every one of
      // them the two private pg fields the detector reads were present — so
      // an empty list means none overlapped, not that the detector is blind.
      expect(statements).toBeGreaterThan(50);
      expect(statementsWithBothFields).toBe(statements);
      expect(overlapping).toEqual([]);
    });
  });

  describe('transaction and snapshot', () => {
    it('passes Repeatable Read and the provisional bounds to the transaction', async () => {
      const seen = interceptExportTransaction({});
      await runExport(financeActor, { dataset: 'bookings', bookingReference: bookingA.reference });
      expect(seen.options).toEqual([FINANCE_EXPORT_TRANSACTION_OPTIONS]);
      expect(FINANCE_EXPORT_TRANSACTION_OPTIONS).toEqual({
        isolationLevel: 'RepeatableRead',
        maxWait: 2_000,
        timeout: 20_000,
      });
      // The actor recheck is the first thing the service does in the transaction.
      expect(seen.touchedBeforeFirstStatementReturned).toEqual([]);
    });

    it('control: backend_xmin is NULL before a first query and set after it, on this server', async () => {
      // Validates the observable the next tests rely on, on a transaction
      // this test fully controls, before it is trusted for the export's.
      await control!.$transaction(
        async (tx) => {
          const before = await idleBackend(CONTROL_TAG);
          expect(before.backendXmin).toBeNull();
          expect(before.query).toMatch(/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/i);

          await tx.$queryRaw`SELECT 1`;
          const after = await idleBackend(CONTROL_TAG);
          expect(after.pid).toBe(before.pid);
          expect(after.backendXmin).not.toBeNull();
          expect(after.pid).toBe(await ownPid(tx));
        },
        { isolationLevel: RepeatableRead },
      );
    });

    it('includes a change committed after the transaction opened but before its first statement', async () => {
      const fixture = await createBookingFixture({});
      const reached = deferred();
      const release = deferred();
      let pidAfterFirstStatement: number | undefined;
      const seen = interceptExportTransaction({
        beforeFirstStatement: async () => {
          reached.resolve();
          await release.promise;
        },
        afterFirstStatement: async (tx) => {
          pidAfterFirstStatement = await ownPid(tx);
        },
      });

      const pending = runExport(financeActor, {
        dataset: 'payments',
        bookingReference: fixture.reference,
      });
      await reached.promise;

      // The export's transaction is open and holds no snapshot: the last
      // thing its backend ran is the adapter's isolation-level statement.
      const before = await idleBackend(APP_TAG);
      expect(before.backendXmin).toBeNull();
      expect(before.query).toMatch(/SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/i);
      expect(seen.rawStatements).toBe(0);

      const committedPaymentId = await commitConcurrentPayment(fixture, '11.00');
      release.resolve();

      const result = await pending;
      // The backend observed above was the export's own.
      expect(pidAfterFirstStatement).toBe(before.pid);
      expect(parseExport(result).rows.map((row) => row.paymentId)).toEqual([committedPaymentId]);
    });

    it.each(['payments', 'bookings'] as const)(
      'excludes from %s a change committed after the first statement returned',
      async (dataset) => {
        const fixture = await createBookingFixture({});
        const existing = await confirmedPayment(financeActor, fixture.bookingId, '40.00');
        const actor = await createStaff('ADMIN_MANAGER');
        const reached = deferred();
        const release = deferred();
        let observed: BackendObservation | undefined;
        let pid: number | undefined;
        const seen = interceptExportTransaction({
          afterFirstStatement: async (tx) => {
            // Observed before anything else runs on the export's backend,
            // so `query` is still the service's own first statement.
            observed = await idleBackend(APP_TAG);
            pid = await ownPid(tx);
            reached.resolve();
            await release.promise;
          },
        });

        const pending = runExport(actor, { dataset, bookingReference: fixture.reference });
        await reached.promise;

        // Exactly one statement has run, it was the recheck that reads the
        // clock, and the export's own backend now holds a snapshot.
        expect(seen.rawStatements).toBe(1);
        expect(seen.touchedBeforeFirstStatementReturned).toEqual([]);
        expect(observed!.pid).toBe(pid);
        expect(observed!.backendXmin).not.toBeNull();
        expect(observed!.query).toMatch(/clock_timestamp\(\)/);

        const lateId = await commitConcurrentPayment(fixture, '25.00');
        release.resolve();
        const result = await pending;
        const rows = parseExport(result).rows;

        if (dataset === 'payments') {
          expect(rows.map((row) => row.paymentId)).toEqual([existing]);
        } else {
          expect(rows).toHaveLength(1);
          expect(rows[0]!.derivedNetConfirmedPaid).toBe('40.00');
          expect(rows[0]!.derivedRemainingBalance).toBe('460.00');
        }
        // The entry's counts describe the rows returned.
        const entries = await exportEntries(actor.id);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.afterState).toMatchObject({ rowCount: rows.length, bookingCount: 1 });

        // An export started afterwards sees the change.
        vi.restoreAllMocks();
        const later = parseExport(
          await runExport(actor, { dataset, bookingReference: fixture.reference }),
        ).rows;
        if (dataset === 'payments') {
          expect(later.map((row) => row.paymentId).sort()).toEqual([existing, lateId].sort());
        } else {
          expect(later[0]!.derivedNetConfirmedPaid).toBe('65.00');
        }
      },
    );

    it('writes no entry and returns no file when the transaction fails after the audit insert', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      let entriesInsideTransaction = -1;
      interceptExportTransaction({
        beforeCommit: async (tx) => {
          entriesInsideTransaction = await tx.auditLog.count({
            where: { actorId: finance.id, action: 'FINANCE_EXPORT_GENERATED' },
          });
          throw new Error('synthetic failure before commit');
        },
      });

      await expect(runExport(finance, { dataset: 'bookings' })).rejects.toThrow(
        'synthetic failure before commit',
      );
      // The insert had happened inside the transaction and was rolled back with it.
      expect(entriesInsideTransaction).toBe(1);
      expect(await exportEntries(finance.id)).toEqual([]);
      await expectNoOpenBackend(APP_TAG);
    });

    it('writes no entry and returns no file when the transaction outlives its timeout', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      const seen = interceptExportTransaction({
        // The service's own bound is asserted above; a short one is
        // substituted here only so the expiry path can be exercised quickly.
        options: (options) => ({ ...options, timeout: 300 }),
        afterFirstStatement: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        },
      });

      await expect(runExport(finance, { dataset: 'bookings' })).rejects.toThrow();
      expect(seen.options).toEqual([FINANCE_EXPORT_TRANSACTION_OPTIONS]);
      expect(await exportEntries(finance.id)).toEqual([]);
      await expectNoOpenBackend(APP_TAG);
    });

    it('leaves the committed entry and returns no file when encoding fails after the commit', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      failEncoding = true;
      await expect(runExport(finance, { dataset: 'bookings' })).rejects.toThrow(
        'synthetic encoding failure',
      );
      // D-062 clause 2: the entry records a committed read for export, not a
      // delivered file.
      const entries = await exportEntries(finance.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.afterState).toMatchObject({ dataset: 'bookings', rowCount: 0 });
    });
  });

  // --- Integrity refusal (D-062 clause 7) ---

  describe('integrity refusal', () => {
    const INTEGRITY = (column: string) =>
      `Finance export refused: stored data failed the integrity check for ${column}.`;

    /**
     * Each case builds its own Booking under its own Finance user, breaks
     * one invariant with a direct write that every database constraint
     * accepts (the payments service would refuse it), and removes the
     * broken state before it ends, so no other test or suite ever reads it.
     */
    async function isolatedFixture(clientFullName: string) {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      const fixture = await createBookingFixture({ finance, clientFullName });
      const plan = await proposePaymentPlan(tcActor, {
        bookingId: fixture.bookingId,
        installments: [
          { sequenceNumber: 1, isDeposit: true, amount: '500.00', dueDate: '2026-11-20' },
        ],
      });
      await approvePaymentPlan(finance, { paymentPlanId: plan.id });
      const installment = await prisma!.installment.findFirstOrThrow({
        where: { paymentPlanId: plan.id },
        select: { id: true },
      });
      const paymentId = await confirmedPayment(finance, fixture.bookingId, '100.00');
      return { finance, fixture, installmentId: installment.id, paymentId };
    }

    async function expectRefused(
      actor: AuthenticatedUser,
      request: unknown,
      column: string,
      secrets: string[],
    ): Promise<void> {
      const refusal = await runExport(actor, request).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      // An integrity failure, not a domain error and not a request error.
      expect(refusal).not.toBeInstanceOf(PaymentError);
      expect(refusal).not.toBeInstanceOf(FinanceExportRequestError);
      expect(refusal).not.toHaveProperty('content');
      const message = (refusal as Error).message;
      expect(message).toBe(INTEGRITY(column));
      for (const secret of secrets) expect(message).not.toContain(secret);
      expect(await exportEntries(actor.id)).toEqual([]);
      await expectNoOpenBackend(APP_TAG);
    }

    it('refuses every dataset that needs a currency the Booking no longer has', async () => {
      const { finance, fixture, installmentId, paymentId } = await isolatedFixture(
        'Integrity Currency Client',
      );
      const allocation = await createAllocation(finance, {
        paymentId,
        installmentId,
        amount: '60.00',
        idempotencyKey: randomUUID(),
      });
      await refundPayment(finance, {
        paymentId,
        amount: '10.00',
        reason: 'Fixture refund',
        idempotencyKey: randomUUID(),
        allocationId: allocation.id,
      });
      const request = (dataset: string) => ({ dataset, bookingReference: fixture.reference });
      const secrets = [fixture.reference, 'Integrity Currency Client', paymentId, '100.00'];

      // Both financial fields cleared together: `booking_financials_pairing`
      // accepts it; the payments service never would once a Payment exists.
      await prisma!.booking.update({
        where: { id: fixture.bookingId },
        data: { totalAmount: null, currencyCode: null },
      });
      try {
        for (const dataset of ['payments', 'refunds', 'allocations', 'installments']) {
          await expectRefused(finance, request(dataset), `${dataset}.currencyCode`, secrets);
        }
        // Nothing stored was changed by the refusals.
        expect(
          await prisma!.booking.findUniqueOrThrow({
            where: { id: fixture.bookingId },
            select: { totalAmount: true, currencyCode: true },
          }),
        ).toEqual({ totalAmount: null, currencyCode: null });
      } finally {
        await prisma!.booking.update({
          where: { id: fixture.bookingId },
          data: { totalAmount: '500.00', currencyCode: 'PHP' },
        });
      }

      // With the invariant restored the same requests are served, complete.
      for (const dataset of ['payments', 'refunds', 'allocations', 'installments']) {
        expect((await runExport(finance, request(dataset))).rowCount).toBe(1);
      }
      expect(await exportEntries(finance.id)).toHaveLength(4);
    });

    it('refuses a payment whose allocations exceed its contribution, and its Booking', async () => {
      const { finance, fixture, installmentId, paymentId } = await isolatedFixture(
        'Integrity Allocation Client',
      );
      const request = (dataset: string) => ({ dataset, bookingReference: fixture.reference });
      const secrets = [fixture.reference, 'Integrity Allocation Client', paymentId, '150.00'];

      // 150.00 allocated from a 100.00 payment: positive, so the amount
      // constraint accepts it; `createAllocation` refuses it.
      const brokenId = randomUUID();
      await prisma!.paymentAllocation.create({
        data: {
          id: brokenId,
          paymentId,
          installmentId,
          amount: '150.00',
          allocatedByStaffUserId: finance.id,
          idempotencyKey: randomUUID(),
        },
      });
      try {
        await expectRefused(finance, request('payments'), 'payments.derivedUnallocated', secrets);
        await expectRefused(
          finance,
          request('bookings'),
          'bookings.derivedUnappliedCredit',
          secrets,
        );
        expect(await prisma!.paymentAllocation.count({ where: { id: brokenId } })).toBe(1);
      } finally {
        await prisma!.paymentAllocation.delete({ where: { id: brokenId } });
      }

      const served = parseExport(await runExport(finance, request('payments'))).rows;
      expect(served.map((row) => row.derivedUnallocated)).toEqual(['100.00']);
    });

    it('refuses an allocation refunded through for more than its amount, wherever it is counted', async () => {
      const { finance, fixture, installmentId, paymentId } =
        await isolatedFixture('Integrity Refund Client');
      const allocation = await createAllocation(finance, {
        paymentId,
        installmentId,
        amount: '50.00',
        idempotencyKey: randomUUID(),
      });
      const { refund } = await refundPayment(finance, {
        paymentId,
        amount: '20.00',
        reason: 'Fixture refund',
        idempotencyKey: randomUUID(),
      });
      const request = (dataset: string) => ({ dataset, bookingReference: fixture.reference });
      const secrets = [
        fixture.reference,
        'Integrity Refund Client',
        paymentId,
        allocation.id,
        '80.00',
      ];

      // 80.00 of refund recorded against a 50.00 allocation: positive, so
      // the amount constraint accepts it; `refundPayment` refuses it.
      const brokenId = randomUUID();
      await prisma!.paymentRefundAllocation.create({
        data: {
          id: brokenId,
          paymentRefundId: refund.id,
          paymentAllocationId: allocation.id,
          amount: '80.00',
        },
      });
      try {
        await expectRefused(
          finance,
          request('allocations'),
          'allocations.derivedNetActive',
          secrets,
        );
        await expectRefused(
          finance,
          request('installments'),
          'installments.derivedNetActiveAllocation',
          secrets,
        );
        await expectRefused(finance, request('payments'), 'payments.derivedNetAllocated', secrets);
      } finally {
        await prisma!.paymentRefundAllocation.delete({ where: { id: brokenId } });
      }

      const served = parseExport(await runExport(finance, request('allocations'))).rows;
      expect(served.map((row) => row.derivedNetActive)).toEqual(['50.00']);
    });

    it('refuses a payment whose stored refunds exceed its amount, and its Booking (D-067)', async () => {
      const { finance, fixture, paymentId } = await isolatedFixture(
        'Integrity Excess Refund Client',
      );
      const request = (dataset: string) => ({ dataset, bookingReference: fixture.reference });
      const secrets = [
        fixture.reference,
        'Integrity Excess Refund Client',
        paymentId,
        '100.00',
        '120.00',
        '70.00',
        '50.00',
      ];
      // 70.00 refunded through the service, which accepts it.
      await refundPayment(finance, {
        paymentId,
        amount: '70.00',
        reason: 'Fixture refund',
        idempotencyKey: randomUUID(),
      });

      // A further 50.00 written directly: positive, so the amount constraint
      // accepts it; `refundPayment` refuses it. Refunds are now 120.00
      // against a 100.00 payment.
      const brokenId = randomUUID();
      await prisma!.paymentRefund.create({
        data: {
          id: brokenId,
          paymentId,
          amount: '50.00',
          reason: 'Direct write for the integrity test',
          performedByStaffUserId: finance.id,
          idempotencyKey: randomUUID(),
        },
      });
      try {
        // No successful export, and so no audit entry, for either dataset
        // that uses the payment's contribution.
        await expectRefused(finance, request('payments'), 'payments.derivedRefundedTotal', secrets);
        await expectRefused(
          finance,
          request('bookings'),
          'bookings.derivedNetConfirmedPaid',
          secrets,
        );
        // Nothing stored is changed by a refusal.
        expect(await prisma!.paymentRefund.count({ where: { paymentId } })).toBe(2);
        expect((await prisma!.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
          'CONFIRMED',
        );
      } finally {
        await prisma!.paymentRefund.delete({ where: { id: brokenId } });
      }

      // With the direct write removed the same requests are served, and the
      // within-row identity holds on the row.
      const payments = parseExport(await runExport(finance, request('payments'))).rows;
      expect(payments).toHaveLength(1);
      expect(payments[0]!.amount).toBe('100.00');
      expect(payments[0]!.derivedRefundedTotal).toBe('70.00');
      expect(payments[0]!.derivedNetContribution).toBe('30.00');
      const bookings = parseExport(await runExport(finance, request('bookings'))).rows;
      expect(bookings.map((row) => row.derivedNetConfirmedPaid)).toEqual(['30.00']);
      expect(await exportEntries(finance.id)).toHaveLength(2);
    });

    it('serves a payment refunded for exactly its amount (D-067)', async () => {
      const { finance, fixture, paymentId } = await isolatedFixture('Integrity Full Refund Client');
      const request = (dataset: string) => ({ dataset, bookingReference: fixture.reference });
      await refundPayment(finance, {
        paymentId,
        amount: '60.00',
        reason: 'Fixture refund',
        idempotencyKey: randomUUID(),
      });
      await refundPayment(finance, {
        paymentId,
        amount: '40.00',
        reason: 'Fixture refund',
        idempotencyKey: randomUUID(),
      });

      const payments = parseExport(await runExport(finance, request('payments'))).rows;
      expect(payments).toHaveLength(1);
      expect(payments[0]!.status).toBe('REFUNDED');
      expect(payments[0]!.amount).toBe('100.00');
      expect(payments[0]!.derivedRefundedTotal).toBe('100.00');
      expect(payments[0]!.derivedNetContribution).toBe('0.00');
      const bookings = parseExport(await runExport(finance, request('bookings'))).rows;
      expect(bookings.map((row) => row.derivedNetConfirmedPaid)).toEqual(['0.00']);
      expect(parseExport(await runExport(finance, request('refunds'))).rows).toHaveLength(2);
      // Three served exports, three entries.
      expect(await exportEntries(finance.id)).toHaveLength(3);
    });

    it('refuses the whole export, not only the affected row', async () => {
      const { finance, fixture, installmentId, paymentId } = await isolatedFixture(
        'Integrity Whole Export Client',
      );
      // A second, sound Booking for the same Finance user.
      const sound = await createBookingFixture({ finance });
      await confirmedPayment(finance, sound.bookingId, '75.00');
      const range = {
        dataset: 'payments',
        from: manilaDay(new Date(), -1),
        to: manilaDay(new Date(), 1),
      };
      expect((await runExport(finance, range)).rowCount).toBe(2);
      const entriesBefore = (await exportEntries(finance.id)).length;

      const brokenId = randomUUID();
      await prisma!.paymentAllocation.create({
        data: {
          id: brokenId,
          paymentId,
          installmentId,
          amount: '150.00',
          allocatedByStaffUserId: finance.id,
          idempotencyKey: randomUUID(),
        },
      });
      try {
        const refusal = await runExport(finance, range).catch((error: unknown) => error);
        expect((refusal as Error).message).toBe(INTEGRITY('payments.derivedUnallocated'));
        // The sound Booking's row is not returned on its own.
        expect(refusal).not.toHaveProperty('content');
        expect(await exportEntries(finance.id)).toHaveLength(entriesBefore);
        // An export that does not reach the broken record is unaffected.
        expect(
          (await runExport(finance, { dataset: 'payments', bookingReference: sound.reference }))
            .rowCount,
        ).toBe(1);
      } finally {
        await prisma!.paymentAllocation.delete({ where: { id: brokenId } });
      }
      expect(fixture.reference).not.toBe(sound.reference);
    });
  });

  // --- Row limit ---

  describe('row limit', () => {
    it('exports exactly 10,000 rows and refuses 10,001 with no partial file and no entry', async () => {
      const finance = await createStaff('FINANCE_ACCOUNTING');
      const fixture = await createBookingFixture({ finance });
      const bulk = Array.from({ length: 10_000 }, () => ({
        id: randomUUID(),
        bookingId: fixture.bookingId,
        clientId: fixture.clientId,
        amount: '1.00',
      }));
      for (let offset = 0; offset < bulk.length; offset += 2_000) {
        await prisma!.payment.createMany({ data: bulk.slice(offset, offset + 2_000) });
      }
      const request = { dataset: 'payments', bookingReference: fixture.reference };

      const startedAt = performance.now();
      const result = await runExport(finance, request);
      const elapsedMs = Math.round(performance.now() - startedAt);
      // An observation for the record, not an assertion: the bound in
      // FINANCE_EXPORT_TRANSACTION_OPTIONS guarantees nothing about speed.
      console.info(
        `[finance export] 10,000-row payments export: ${elapsedMs} ms end to end, ${result.content.byteLength} bytes`,
      );
      expect(result.rowCount).toBe(10_000);
      expect(parseExport(result).rows).toHaveLength(10_000);
      expect(await exportEntries(finance.id)).toHaveLength(1);

      await prisma!.payment.create({
        data: {
          id: randomUUID(),
          bookingId: fixture.bookingId,
          clientId: fixture.clientId,
          amount: '1.00',
        },
      });
      const refusal = await runExport(finance, request).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PaymentError);
      expect(refusal).toMatchObject({ code: 'EXPORT_ROW_LIMIT_EXCEEDED', status: 422 });
      expect(refusal).not.toHaveProperty('content');
      // Still only the one entry from the successful export.
      expect(await exportEntries(finance.id)).toHaveLength(1);
      await expectNoOpenBackend(APP_TAG);

      // A narrower request for the same Booking is still served.
      const narrowed = await runExport(finance, { ...request, status: 'CONFIRMED' });
      expect(narrowed.rowCount).toBe(0);
    }, 180_000);
  });
});
