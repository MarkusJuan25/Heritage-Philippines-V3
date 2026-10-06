import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Real-PostgreSQL coverage for D-061 Stage 3: `POST /api/payments/exports`
// run against the real export service and a real database, so that what
// the route returns can be checked against what was actually written —
// one audit entry for a file, none for any refusal. Only the session lookup
// is replaced; the role guard, the cross-site policy (D-063), the service,
// its transaction, and the audit insert are the real ones.
//
// IMPORT SAFETY / SKIP-FAIL SEMANTICS: identical discipline to
// features/payments/export.integration.test.ts — nothing that touches the
// database is imported until `TEST_DATABASE_URL` has been validated, and the
// suite is skipped entirely when it is unset. Synthetic data only, in
// `heritage_v3_test` only.

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

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
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the export route integration suite.',
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

/** A minimal RFC 4180 reader, independent of the encoder. */
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

type Role = 'ADMIN_MANAGER' | 'TRAVEL_CONSULTANT' | 'FINANCE_ACCOUNTING' | 'VISA_DOCUMENTATION';
type Actor = { id: string; name: string; email: string; role: Role };

const rawTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasTestDatabaseUrl = typeof rawTestDatabaseUrl === 'string' && rawTestDatabaseUrl.length > 0;

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
const originalRateLimitSecret = process.env.ACTIVATION_RATE_LIMIT_HMAC_SECRET;

describe.skipIf(!hasTestDatabaseUrl)('finance export route integration (real database)', () => {
  let prisma: (typeof import('@/lib/db'))['prisma'];
  let POST: (typeof import('@/app/api/payments/exports/route'))['POST'];
  let trustedOrigin: string;

  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;
  let didSetRateLimitSecret = false;
  const userIds: string[] = [];
  const clientIds: string[] = [];
  const bookingIds: string[] = [];

  let finance: Actor;
  let admin: Actor;
  let consultant: Actor;
  type BookingFixture = {
    bookingId: string;
    clientId: string;
    reference: string;
    installmentId: string;
    paymentId: string;
  };
  let booking: BookingFixture; // assigned to `finance`
  let otherBooking: BookingFixture; // assigned to nobody `finance` knows

  async function createUser(role: Role): Promise<Actor> {
    const id = randomUUID();
    const actor = {
      id,
      name: `Export Route ${role}`,
      email: `finance-export-route-${randomUUID()}@example.test`,
      role,
    };
    await prisma.user.create({ data: { ...actor, isActive: true } });
    userIds.push(id);
    return actor;
  }

  /**
   * A Booking with financials, an approved one-installment plan, and one
   * confirmed 100.00 payment, written directly: this suite is about the
   * route, and the service-built fixtures are exercised in
   * export.integration.test.ts.
   */
  async function createBooking(assignedFinance: Actor | null): Promise<BookingFixture> {
    const clientId = randomUUID();
    const proposalId = randomUUID();
    const versionId = randomUUID();
    const bookingId = randomUUID();
    const planId = randomUUID();
    const installmentId = randomUUID();
    const paymentId = randomUUID();
    const reference = `HPB-${randomBytes(10).toString('hex').toUpperCase()}`;
    const author = admin.id;

    await prisma.client.create({
      data: {
        id: clientId,
        fullName: 'Export Route Fixture Client',
        email: `finance-export-route-${randomUUID()}@example.test`,
      },
    });
    clientIds.push(clientId);
    await prisma.proposal.create({ data: { id: proposalId, clientId } });
    await prisma.proposalVersion.create({
      data: {
        id: versionId,
        proposalId,
        versionNumber: 1,
        content: 'Synthetic export route fixture.',
        createdByUserId: author,
      },
    });
    await prisma.booking.create({
      data: {
        id: bookingId,
        bookingReference: reference,
        clientId,
        proposalVersionId: versionId,
        totalAmount: '500.00',
        currencyCode: 'PHP',
      },
    });
    bookingIds.push(bookingId);
    if (assignedFinance) {
      await prisma.staffAssignment.create({
        data: {
          id: randomUUID(),
          assignedStaffId: assignedFinance.id,
          assignedByUserId: author,
          role: 'FINANCE_ACCOUNTING',
          bookingId,
        },
      });
    }
    await prisma.paymentPlan.create({
      data: {
        id: planId,
        bookingId,
        clientId,
        proposedByStaffUserId: author,
        approvedByStaffUserId: author,
        approvedAt: new Date(),
        status: 'APPROVED',
      },
    });
    await prisma.installment.create({
      data: {
        id: installmentId,
        paymentPlanId: planId,
        sequenceNumber: 1,
        isDeposit: true,
        amount: '500.00',
        dueDate: new Date('2026-11-20T00:00:00.000Z'),
      },
    });
    await prisma.payment.create({
      data: { id: paymentId, bookingId, clientId, amount: '100.00', status: 'CONFIRMED' },
    });
    return { bookingId, clientId, reference, installmentId, paymentId };
  }

  type RequestOptions = {
    origin?: string | null;
    contentType?: string | null;
    body?: unknown;
  };

  function request(options: RequestOptions = {}): Request {
    const headers = new Headers();
    const origin = options.origin === undefined ? trustedOrigin : options.origin;
    if (origin !== null) headers.set('Origin', origin);
    const raw =
      options.body === undefined
        ? { dataset: 'payments', bookingReference: booking.reference }
        : options.body;
    const built = new Request(`${trustedOrigin}/api/payments/exports`, {
      method: 'POST',
      headers,
      body: typeof raw === 'string' ? raw : JSON.stringify(raw),
    });
    const contentType =
      options.contentType === undefined ? 'application/json' : options.contentType;
    if (contentType === null) built.headers.delete('Content-Type');
    else built.headers.set('Content-Type', contentType);
    return built;
  }

  async function call(actor: Actor | null, options: RequestOptions = {}): Promise<Response> {
    getSessionMock.mockResolvedValue(actor ? { user: actor } : null);
    return POST(request(options), { params: Promise.resolve({}) });
  }

  async function exportEntries(actorId: string) {
    return prisma.auditLog.findMany({
      where: { actorId, action: 'FINANCE_EXPORT_GENERATED' },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function totalExportEntries(): Promise<number> {
    return prisma.auditLog.count({
      where: { actorId: { in: userIds }, action: 'FINANCE_EXPORT_GENERATED' },
    });
  }

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
    // The route trusts exactly the origin of the configured base URL.
    trustedOrigin = new URL(process.env.BETTER_AUTH_URL).origin;

    ({ prisma } = await import('@/lib/db'));
    ({ POST } = await import('@/app/api/payments/exports/route'));

    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    if (rows[0]?.current_database !== REQUIRED_TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to proceed: the connected database reports current_database() = "${rows[0]?.current_database}", not "${REQUIRED_TEST_DATABASE_NAME}".`,
      );
    }

    admin = await createUser('ADMIN_MANAGER');
    finance = await createUser('FINANCE_ACCOUNTING');
    consultant = await createUser('TRAVEL_CONSULTANT');
    booking = await createBooking(finance);
    otherBooking = await createBooking(null);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    getSessionMock.mockReset();
  });

  afterAll(async () => {
    try {
      if (prisma) {
        try {
          const byBooking = { bookingId: { in: bookingIds } };
          const byPayment = { payment: byBooking };
          await prisma.paymentAllocation.deleteMany({ where: byPayment });
          await prisma.payment.deleteMany({ where: byBooking });
          await prisma.installment.deleteMany({ where: { paymentPlan: byBooking } });
          await prisma.paymentPlan.deleteMany({ where: byBooking });
          await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
          await prisma.staffAssignment.deleteMany({ where: byBooking });
          await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
          await prisma.proposalVersion.deleteMany({
            where: { proposal: { clientId: { in: clientIds } } },
          });
          await prisma.proposal.deleteMany({ where: { clientId: { in: clientIds } } });
          await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
          await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
  }, 120_000);

  describe('a file', () => {
    it('returns the CSV with its download headers and writes exactly one audit entry', async () => {
      const before = await exportEntries(finance.id);
      const response = await call(finance);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Content-Disposition')).toMatch(
        /^attachment; filename="heritage-finance-payments-v1-all-dates-\d{8}T\d{6}\+0800\.csv"$/,
      );

      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const [header, ...rows] = parseCsv(
        new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1),
      );
      expect(header![0]).toBe('paymentId');
      expect(rows).toHaveLength(1);
      expect(rows[0]![0]).toBe(booking.paymentId);
      expect(rows[0]![header!.indexOf('amount')]).toBe('100.00');
      const asOf = rows[0]![header!.indexOf('asOf')];

      const entries = await exportEntries(finance.id);
      expect(entries).toHaveLength(before.length + 1);
      const entry = entries.at(-1)!;
      expect(entry).toMatchObject({ entityType: 'FinanceExport', beforeState: null });
      expect(entry.afterState).toEqual({
        dataset: 'payments',
        formatVersion: 'v1',
        bookingReference: booking.reference,
        scope: 'ASSIGNED_BOOKINGS',
        actorRole: 'FINANCE_ACCOUNTING',
        rowCount: 1,
        bookingCount: 1,
        asOf,
      });
    });

    it('returns an empty file, and still one entry, for a Booking outside the Finance user scope', async () => {
      const actor = await createUser('FINANCE_ACCOUNTING');
      const response = await call(actor, {
        body: { dataset: 'payments', bookingReference: otherBooking.reference },
      });
      expect(response.status).toBe(200);
      const rows = parseCsv(
        new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer()).slice(1),
      );
      expect(rows).toHaveLength(1);
      const entries = await exportEntries(actor.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.afterState).toMatchObject({ rowCount: 0, scope: 'ASSIGNED_BOOKINGS' });
    });

    it('gives Admin / Manager the Booking no Finance user is assigned to', async () => {
      const actor = await createUser('ADMIN_MANAGER');
      const response = await call(actor, {
        body: { dataset: 'payments', bookingReference: otherBooking.reference },
      });
      expect(response.status).toBe(200);
      const rows = parseCsv(
        new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer()).slice(1),
      );
      expect(rows).toHaveLength(2);
      const entries = await exportEntries(actor.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.afterState).toMatchObject({
        rowCount: 1,
        scope: 'ALL_BOOKINGS',
        actorRole: 'ADMIN_MANAGER',
      });
    });
  });

  describe('refusals before the service', () => {
    it.each<[string, () => Actor | null, RequestOptions, number]>([
      ['no session', () => null, {}, 401],
      ['a Travel Consultant', () => consultant, {}, 403],
      ['another origin', () => finance, { origin: 'https://evil.example' }, 403],
      ['a missing Origin', () => finance, { origin: null }, 403],
      ['a null Origin', () => finance, { origin: 'null' }, 403],
      ['the trusted origin with a path', () => finance, { origin: 'TRUSTED/admin' }, 403],
      [
        'a form content type',
        () => finance,
        { contentType: 'application/x-www-form-urlencoded' },
        415,
      ],
      ['a missing content type', () => finance, { contentType: null }, 415],
      ['malformed JSON', () => finance, { body: '{"dataset":' }, 400],
    ])(
      'refuses %s without opening a transaction or writing an entry',
      async (_label, who, options, status) => {
        const before = await totalExportEntries();
        const transaction = vi.spyOn(prisma, '$transaction');
        const resolved =
          options.origin === 'TRUSTED/admin'
            ? { ...options, origin: `${trustedOrigin}/admin` }
            : options;

        const response = await call(who(), resolved);

        expect(response.status).toBe(status);
        expect(response.headers.get('Content-Disposition')).toBeNull();
        expect(transaction).not.toHaveBeenCalled();
        expect(await totalExportEntries()).toBe(before);
      },
    );
  });

  describe('refusals by the service', () => {
    it.each<[string, unknown]>([
      ['payments with no date range and no booking reference', { dataset: 'payments' }],
      ['bookings with a date range', { dataset: 'bookings', from: '2026-01-01', to: '2026-01-31' }],
      ['an unknown dataset', { dataset: 'ledger' }],
      ['a JSON null', null],
    ])('maps %s to the 400 validation envelope with no entry', async (_label, body) => {
      const before = await totalExportEntries();
      const transaction = vi.spyOn(prisma, '$transaction');
      const response = await call(finance, { body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
      expect(json.error.details.length).toBeGreaterThan(0);
      expect(transaction).not.toHaveBeenCalled();
      expect(await totalExportEntries()).toBe(before);
    });

    it('returns 403 when the stored role no longer permits export, though the session still does', async () => {
      const actor = await createUser('FINANCE_ACCOUNTING');
      await prisma.user.update({ where: { id: actor.id }, data: { role: 'TRAVEL_CONSULTANT' } });
      const response = await call(actor);
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('ROLE_NOT_PERMITTED');
      expect(await exportEntries(actor.id)).toEqual([]);
    });

    it('returns 403 for an account deactivated after its session was issued', async () => {
      const actor = await createUser('ADMIN_MANAGER');
      await prisma.user.update({ where: { id: actor.id }, data: { isActive: false } });
      const response = await call(actor);
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('ROLE_NOT_PERMITTED');
      expect(await exportEntries(actor.id)).toEqual([]);
    });

    it('returns 422 over the row limit, with no file and no entry', async () => {
      const actor = await createUser('FINANCE_ACCOUNTING');
      const large = await createBooking(actor);
      const rows = Array.from({ length: 10_000 }, () => ({
        id: randomUUID(),
        bookingId: large.bookingId,
        clientId: large.clientId,
        amount: '1.00',
      }));
      for (let offset = 0; offset < rows.length; offset += 2_000) {
        await prisma.payment.createMany({ data: rows.slice(offset, offset + 2_000) });
      }
      // 10,000 pending payments plus the fixture's confirmed one: 10,001.
      const response = await call(actor, {
        body: { dataset: 'payments', bookingReference: large.reference },
      });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe('EXPORT_ROW_LIMIT_EXCEEDED');
      expect(response.headers.get('Content-Disposition')).toBeNull();
      expect(await exportEntries(actor.id)).toEqual([]);
    }, 120_000);

    it('returns the generic 500 for an integrity refusal: no detail, no file, no entry', async () => {
      const actor = await createUser('ADMIN_MANAGER');
      // 150.00 allocated from a 100.00 payment: every constraint accepts it,
      // the payments service would not (D-062 clause 7).
      const brokenId = randomUUID();
      await prisma.paymentAllocation.create({
        data: {
          id: brokenId,
          paymentId: booking.paymentId,
          installmentId: booking.installmentId,
          amount: '150.00',
          allocatedByStaffUserId: admin.id,
          idempotencyKey: randomUUID(),
        },
      });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const response = await call(actor);

        expect(response.status).toBe(500);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
        });
        for (const leaked of ['integrity', 'derived', booking.reference, 'Fixture', '150.00']) {
          expect(text).not.toContain(leaked);
        }
        expect(response.headers.get('Content-Disposition')).toBeNull();
        expect(await exportEntries(actor.id)).toEqual([]);
        // The server's own log names the column and nothing from the data.
        const loggedError = logged.mock.calls[0]![1] as Error;
        expect(loggedError.message).toBe(
          'Finance export refused: stored data failed the integrity check for payments.derivedUnallocated.',
        );
      } finally {
        await prisma.paymentAllocation.delete({ where: { id: brokenId } });
      }

      // With the invariant restored the same request is served.
      const served = await call(actor);
      expect(served.status).toBe(200);
      expect(await exportEntries(actor.id)).toHaveLength(1);
    });
  });
});
