import { createHash, randomUUID } from 'node:crypto';

import type { Browser, BrowserContext, Page } from '@playwright/test';
import { generateRandomString, hashPassword } from 'better-auth/crypto';

import { e2eIdentityHeaders, newIdentifiedContext } from './support/browser-identity';
import { closeContextsAndVerify } from './support/context-closure';
import { expect, test } from './support/fixtures';
import { createE2EPrismaRpcClient, type E2EPrismaRpcClient } from './support/test-database';

// D-061 Stage 4 — the real-browser check of the basic finance export:
// "a real-browser check of the download for each permitted role and a
// refusal for each other role" (D-061 §10). The admin form is driven in
// Chromium against the isolated E2E server, and the file the browser
// actually downloads is read and checked.
//
// D-064 (downloaded-file artifact policy), as amended by D-065, governs
// every line here:
//   - The download is read from Playwright's own temporary file, in memory.
//     It is never copied, never saved, and deleted as soon as it has been
//     read, before any check is made on it; every browser context of the
//     worker's browser is asked to close at the end, and that they closed
//     is verified (D-065 §6).
//   - Only byte length, SHA-256, the header row (when it is exactly the
//     expected one), row count, and named pass/fail results are printed.
//   - No CSV row, client name, booking reference, amount, or response body
//     is printed, and none can reach a failure message: file contents are
//     checked as named true/false results, and every browser, setup, and
//     database step of the test body runs inside `guarded`, which replaces
//     any error with its fixed step name. Closing contexts and the cleanup
//     and residue steps run outside it: the text of a close error is
//     discarded, and whether closing succeeded is reported by a fixed name
//     (D-065 §6); a cleanup or residue failure reports an error class name
//     and record ids only (D-033 §9).
//   - Trace, screenshot, and video are off.
//   - No locator matcher (`expect(locator)…`) is used anywhere in this
//     file, and none may be added: when one fails, Playwright attaches its
//     own snapshot of the page to the error, and nothing here can stop it.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.use({ extraHTTPHeaders: e2eIdentityHeaders('finance-export', 0) });
// Playwright sets no navigation limit by default, so a navigation that
// never finishes would hold the test until its own time limit. Bounded
// here for every page of this file, the contexts it creates included.
test.use({ navigationTimeout: 60_000 });

// D-064 clause 5. When a test fails, Playwright 1.62.1 writes
// `error-context.md` under test-results and, unless
// PLAYWRIGHT_NO_COPY_PROMPT is set, puts an accessibility snapshot of an
// open page in it — text that includes client names and booking
// references. Playwright looks for an open page more than once: when a
// context closes, when the test's fixtures are torn down, and again after
// this file's `afterAll`. Two independent safeguards cover all of them,
// after a thrown failure and after a time-out alike:
//   - the variable is set for this file's tests only. It is restored only
//     when the test passed and recorded no error; after a failure it stays
//     set, and Playwright then stops this worker process, so no other spec
//     file ever runs with it;
//   - no page is left open anywhere in this worker's browser. Every page
//     is closed before its context is (Playwright takes its look when a
//     context is asked to close, and by then a time-out has already
//     recorded an error), and then every context — by the test itself,
//     and again by `afterEach`, which Playwright also runs after a
//     time-out, when the test's own `finally` has not run and may never
//     run. "Every context" means every context of the browser, not only
//     this file's: the browser is shared by the spec files that run in
//     the same worker before this one, Playwright's last look takes the
//     first context still open in it, and a context an earlier, finished
//     spec file left open would otherwise be the one it reads.
// The file Playwright still writes on failure then holds the error (a
// fixed step name, see `guarded`) and this spec's own source, and nothing
// from a page.
let previousNoCopyPrompt: string | undefined;
let everyTestPassed = true;

// D-065 §6(c): the fixed names under which a closure that could not be
// established is reported. Neither carries anything from a page or an error.
const CLOSURE_CHECK = "Cleanup: every browser context of this worker's browser is closed";
const CLOSURE_FAILURE = 'Stage 4 teardown failed: browser contexts could not be confirmed closed.';

/** Every browser context this file opens, so `afterEach` can close them. */
const openContexts: BrowserContext[] = [];

/** What the running test has created, so `afterEach` and `afterAll` can find it. */
type Recorded = {
  tcUserId: string | null;
  staffUserIds: string[];
  leadIds: string[];
  clientIds: string[];
  proposalIds: string[];
  bookingIds: string[];
  databaseCleaned: boolean;
};
const recorded: Recorded = {
  tcUserId: null,
  staffUserIds: [],
  leadIds: [],
  clientIds: [],
  proposalIds: [],
  bookingIds: [],
  databaseCleaned: false,
};

/** Record ids only (D-033 §9 permits them; they are not D-064 data). */
function recordedIds(): string {
  return JSON.stringify({
    tcUserId: recorded.tcUserId,
    staffUserIds: recorded.staffUserIds,
    leadIds: recorded.leadIds,
    clientIds: recorded.clientIds,
    proposalIds: recorded.proposalIds,
    bookingIds: recorded.bookingIds,
  });
}

/**
 * Removes what this run added beyond the fixture's own chain: payments and
 * their dependants, plan rows, assignments, and the staff and client
 * accounts created here. Scoped to this run's recorded ids only. The
 * fixture then removes the Travel Consultant and the lead, client,
 * proposal, and booking chain.
 */
async function removeRunData(prisma: E2EPrismaRpcClient): Promise<void> {
  const bookings = { in: recorded.bookingIds };
  if (recorded.bookingIds.length > 0) {
    await prisma.receipt.deleteMany({ where: { payment: { bookingId: bookings } } });
    await prisma.paymentAllocation.deleteMany({ where: { payment: { bookingId: bookings } } });
    await prisma.paymentStatusHistory.deleteMany({ where: { payment: { bookingId: bookings } } });
    await prisma.payment.deleteMany({ where: { bookingId: bookings } });
    await prisma.installment.deleteMany({ where: { paymentPlan: { bookingId: bookings } } });
    await prisma.paymentPlan.deleteMany({ where: { bookingId: bookings } });
    await prisma.staffAssignment.deleteMany({ where: { bookingId: bookings } });
  }
  if (recorded.staffUserIds.length > 0) {
    const staff = { in: recorded.staffUserIds };
    await prisma.auditLog.deleteMany({ where: { actorId: staff } });
    await prisma.staffAssignment.deleteMany({ where: { assignedStaffId: staff } });
    await prisma.user.deleteMany({ where: { id: staff } });
  }
}

/**
 * Asks every page first, then its context, to close, for every context of
 * the browser — this file's own and any an earlier spec file in the same
 * worker left open — and reports whether they are all closed afterwards
 * (D-065 §4, §6). The text of a close error is discarded; the outcome is
 * not. It never throws, so the database cleanup after it always runs.
 */
function closeEveryContext(browser: Browser, fixtureContext: BrowserContext): Promise<boolean> {
  return closeContextsAndVerify(browser, [...openContexts, fixtureContext]);
}

test.beforeAll(() => {
  previousNoCopyPrompt = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
});

// Runs after the test body whether it passed, threw, or timed out, and
// before the fixtures are torn down.
test.afterEach(async ({ page, browser }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) everyTestPassed = false;
  // D-065 §6: a closure that cannot be established fails the run, keeps
  // the variable set, and does not stop the database cleanup below.
  const contextsClosed = await closeEveryContext(browser, page.context());
  if (!contextsClosed) everyTestPassed = false;
  const failures: string[] = contextsClosed ? [] : [CLOSURE_FAILURE];
  // Only reached with work to do when the test body did not get as far as
  // its own cleanup (a time-out) or that cleanup failed. It must run
  // before the fixture's, which cannot delete a Booking that still has
  // payments.
  if (!recorded.databaseCleaned) {
    const prisma = createE2EPrismaRpcClient();
    try {
      await removeRunData(prisma);
      recorded.databaseCleaned = true;
      console.log('[stage4] CLEANUP completed by afterEach.');
    } catch (error) {
      const kind = error instanceof Error ? error.constructor.name : typeof error;
      failures.push(
        `Stage 4 cleanup failed in afterEach (${kind}). Manual removal may be needed for: ${recordedIds()}.`,
      );
    } finally {
      await prisma.$disconnect();
    }
  }
  // Added to the test's own error, never in place of it (D-065 §6(d)).
  if (failures.length > 0) throw new Error(failures.join(' '));
});

// After the fixture's own teardown: nothing this run created may remain.
// Read-only, scoped to the recorded ids, and reported as ids only.
test.afterAll(async () => {
  const prisma = createE2EPrismaRpcClient();
  const remaining: string[] = [];
  let checked = 0;
  let failure: string | null = null;
  try {
    const count = async (label: string, skip: boolean, run: () => Promise<unknown>) => {
      if (skip) return;
      checked += 1;
      const rows = await run();
      if (!Array.isArray(rows) || rows.length > 0) remaining.push(label);
    };
    const bookings = { in: recorded.bookingIds };
    const noBookings = recorded.bookingIds.length === 0;
    const userIds = [...(recorded.tcUserId ? [recorded.tcUserId] : []), ...recorded.staffUserIds];
    await count('Lead', recorded.leadIds.length === 0, () =>
      prisma.lead.findMany({ where: { id: { in: recorded.leadIds } }, select: { id: true } }),
    );
    await count('Client', recorded.clientIds.length === 0, () =>
      prisma.client.findMany({ where: { id: { in: recorded.clientIds } }, select: { id: true } }),
    );
    await count('Proposal', recorded.proposalIds.length === 0, () =>
      prisma.proposal.findMany({
        where: { id: { in: recorded.proposalIds } },
        select: { id: true },
      }),
    );
    await count('Booking', noBookings, () =>
      prisma.booking.findMany({ where: { id: bookings }, select: { id: true } }),
    );
    await count('PaymentPlan', noBookings, () =>
      prisma.paymentPlan.findMany({ where: { bookingId: bookings }, select: { id: true } }),
    );
    await count('Payment', noBookings, () =>
      prisma.payment.findMany({ where: { bookingId: bookings }, select: { id: true } }),
    );
    await count('User', userIds.length === 0, () =>
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } }),
    );
    await count('AuditLog', userIds.length === 0, () =>
      prisma.auditLog.findMany({ where: { actorId: { in: userIds } }, select: { id: true } }),
    );
    if (remaining.length > 0) failure = `rows remain in: ${remaining.join(', ')}`;
  } catch (error) {
    failure = `not completed (${error instanceof Error ? error.constructor.name : typeof error})`;
  } finally {
    await prisma.$disconnect();
  }
  if (failure !== null) {
    throw new Error(
      `Stage 4 residue check after fixture teardown: ${failure}. Recorded ids: ${recordedIds()}.`,
    );
  }
  console.log(
    checked === 0
      ? '[stage4] RESIDUE not checked: no record ids were recorded for this run.'
      : '[stage4] RESIDUE none: nothing recorded for this run remains after fixture teardown.',
  );
  // `afterAll` runs against the last test's own record, so an error first
  // recorded after `afterEach` (in fixture teardown) is seen here too.
  const info = test.info();
  if (!everyTestPassed || info.errors.length > 0 || info.status !== info.expectedStatus) return;
  if (previousNoCopyPrompt === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
  else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previousNoCopyPrompt;
});

const SLOW = { timeout: 45_000 } as const;
const EXPORT_PATH = '/api/payments/exports';

// D-061 §3's exact header rows for the two datasets downloaded here.
const EXPECTED_HEADER = {
  bookings: [
    'bookingReference',
    'clientFullName',
    'currencyCode',
    'bookingTotalAmount',
    'derivedNetConfirmedPaid',
    'derivedRemainingBalance',
    'derivedOverpayment',
    'derivedUnappliedCredit',
    'derivedNextDueDate',
    'derivedNextDueOutstandingAmount',
    'paymentPlanStatus',
    'asOf',
  ],
  payments: [
    'paymentId',
    'bookingReference',
    'clientFullName',
    'currencyCode',
    'amount',
    'status',
    'recordedAt',
    'confirmedAt',
    'reversedAt',
    'fullyRefundedAt',
    'derivedRefundedTotal',
    'derivedNetContribution',
    'derivedNetAllocated',
    'derivedUnallocated',
    'receiptNumber',
    'receiptIssuedAt',
    'asOf',
  ],
} as const;
type Dataset = keyof typeof EXPECTED_HEADER;

const FILENAME_PATTERN = (dataset: Dataset) =>
  new RegExp(`^heritage-finance-${dataset}-v1-all-dates-\\d{8}T\\d{6}\\+0800\\.csv$`);
const TIMESTAMP_CELL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/;

type Role =
  'ADMIN_MANAGER' | 'FINANCE_ACCOUNTING' | 'VISA_DOCUMENTATION' | 'SYSTEM_ADMINISTRATOR' | 'CLIENT';
type Account = { userId: string; email: string; password: string; name: string };

// --- Reporting: fixed names and booleans only (D-064 clauses 2 and 3) ---

const results: { name: string; pass: boolean }[] = [];

function check(name: string, pass: boolean): void {
  results.push({ name, pass });
  console.log(`[stage4] ${pass ? 'PASS' : 'FAIL'}  ${name}`);
}

/**
 * Runs one browser or setup step. Any error is replaced by one carrying the
 * step's fixed name and the error's class name only, so nothing a locator,
 * a filled value, or a page held can reach the reporter.
 */
async function guarded<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const kind = error instanceof Error ? error.constructor.name : typeof error;
    throw new Error(`Stage 4 step failed: ${step} (${kind}).`);
  }
}

/**
 * The export section of /admin/payments. Every form locator is scoped to
 * it: the page's own search form also has a "Booking reference" field, and
 * Next's route announcer is a second `role="alert"` on every page.
 */
function exportSection(page: Page) {
  return page.locator('section[aria-labelledby="finance-export-heading"]');
}

/** A minimal RFC 4180 reader, independent of the application's encoder. */
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

type Downloaded = {
  filename: string;
  status: number;
  headers: Record<string, string>;
  rows: Record<string, string>[];
};

/**
 * Fills the export form, clicks "Download CSV", and reads the file the
 * browser really downloads — from Playwright's temporary download, into
 * memory, then deletes it. Format checks that need the raw bytes are made
 * here; the parsed rows are returned for the caller's own named checks and
 * are never printed.
 */
async function downloadThroughForm(
  page: Page,
  who: string,
  dataset: Dataset,
  bookingReference: string | null,
): Promise<Downloaded> {
  const label = `${who} ${dataset}${bookingReference ? ' by reference' : ' unfiltered'}`;
  return guarded(`download ${label}`, async () => {
    await page.goto('/admin/payments');
    await page.getByRole('heading', { name: 'Export finance records' }).waitFor(SLOW);
    const section = exportSection(page);
    await section.getByLabel('Records to export').selectOption(dataset);
    if (bookingReference !== null) {
      await section.getByLabel(/^Booking reference/).fill(bookingReference);
    }

    const [download, response] = await Promise.all([
      page.waitForEvent('download', SLOW),
      page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          new URL(candidate.url()).pathname === EXPORT_PATH,
        SLOW,
      ),
      section.getByRole('button', { name: 'Download CSV' }).click(),
    ]);

    // The bytes, read from Playwright's own temporary download. Never
    // `saveAs`; deleted as soon as they are in memory.
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    await download.delete();

    const filename = download.suggestedFilename();
    const headers = response.headers();
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    const body = text.slice(1);
    const [header, ...records] = parseCsv(body);
    const expectedHeader: readonly string[] = EXPECTED_HEADER[dataset];
    const headerMatches =
      header !== undefined &&
      header.length === expectedHeader.length &&
      header.every((cell, index) => cell === expectedHeader[index]);
    const lines = body.split('\r\n');

    console.log(
      `[stage4] DOWNLOAD ${label}: ${JSON.stringify({
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        header: headerMatches ? expectedHeader.join(',') : 'header mismatch',
        rowCount: records.length,
      })}`,
    );

    // The request and the response as the browser saw them (D-061 §4).
    check(`${label}: the form's request returned 200`, response.status() === 200);
    check(
      `${label}: Content-Type is text/csv; charset=utf-8`,
      headers['content-type'] === 'text/csv; charset=utf-8',
    );
    check(`${label}: Cache-Control is no-store`, headers['cache-control'] === 'no-store');
    check(
      `${label}: X-Content-Type-Options is nosniff`,
      headers['x-content-type-options'] === 'nosniff',
    );
    check(
      `${label}: Content-Disposition is an attachment naming the downloaded file`,
      headers['content-disposition'] === `attachment; filename="${filename}"`,
    );
    check(
      `${label}: the downloaded filename has the all-dates form with no name or reference in it`,
      FILENAME_PATTERN(dataset).test(filename) && !filename.includes('HPB-'),
    );

    // The file itself (D-061 §3 and §4; D-062 clause 4).
    check(
      `${label}: the file starts with a UTF-8 byte-order mark`,
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    );
    check(`${label}: the header row is exactly the expected one`, headerMatches);
    check(
      `${label}: every row ends with CRLF and the file has no bare line feed`,
      body.endsWith('\r\n') && !body.replaceAll('\r\n', '').includes('\n'),
    );
    check(
      `${label}: every field of every row is enclosed in double quotes`,
      lines.slice(0, -1).every((line) => /^"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/.test(line)),
    );
    check(
      `${label}: every row has as many cells as the header`,
      records.every((cells) => cells.length === expectedHeader.length),
    );

    const rows = records.map((cells) =>
      Object.fromEntries(expectedHeader.map((column, index) => [column, cells[index] ?? ''])),
    );
    check(
      `${label}: every row carries one asOf in the three-fraction-digit +08:00 form`,
      rows.every((row) => TIMESTAMP_CELL.test(row.asOf ?? '') && row.asOf === rows[0]?.asOf),
    );

    // The page reports the same file.
    await section.getByRole('status').filter({ hasText: 'Export downloaded:' }).waitFor(SLOW);
    check(
      `${label}: the form reports the download and shows no error`,
      (await section.getByRole('status').filter({ hasText: filename }).count()) === 1 &&
        (await section.getByRole('alert').count()) === 0,
    );

    return { filename, status: response.status(), headers, rows };
  });
}

/** The export request, sent from inside a signed-in page: status and headers only. */
async function requestFromPage(
  page: Page,
  step: string,
): Promise<{ status: number; disposition: string | null; errorCode: string | null }> {
  return guarded(step, () =>
    page.evaluate(async (path) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset: 'bookings' }),
      });
      let errorCode: string | null = null;
      if (!response.ok) {
        const parsed = (await response.json().catch(() => null)) as {
          error?: { code?: unknown };
        } | null;
        errorCode = typeof parsed?.error?.code === 'string' ? parsed.error.code : null;
      }
      return {
        status: response.status,
        disposition: response.headers.get('content-disposition'),
        errorCode,
      };
    }, EXPORT_PATH),
  );
}

function extractTrailingId(url: string): string {
  const id = /\/([0-9a-fA-F-]{36})\/?$/.exec(new URL(url).pathname)?.[1];
  if (!id) throw new Error('No record id in the current URL.');
  return id;
}

function formatDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test('D-061 Stage 4: the finance export downloads in a real browser for each permitted role and is refused for each other role', async ({
  tcAccount,
  browser,
  page,
}) => {
  test.setTimeout(900_000);
  const prisma: E2EPrismaRpcClient = createE2EPrismaRpcClient();
  recorded.tcUserId = tcAccount.userId;

  async function createAccount(role: Role, tag: string): Promise<Account> {
    const userId = randomUUID();
    const email = `e2e-fx-${tag}-${randomUUID()}@example.test`;
    const name = `E2E Export ${tag} ${randomUUID().slice(0, 8)}`;
    const password = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');
    recorded.staffUserIds.push(userId);
    await guarded(`create ${tag} account`, async () => {
      await prisma.user.create({
        data: {
          id: userId,
          name,
          email,
          emailVerified: true,
          role,
          isActive: true,
          accounts: {
            create: {
              id: randomUUID(),
              accountId: userId,
              providerId: 'credential',
              password: await hashPassword(password),
            },
          },
        },
      });
    });
    return { userId, email, password, name };
  }

  async function signIn(
    activeBrowser: Browser,
    identityIndex: number,
    account: Account,
    tag: string,
  ): Promise<Page> {
    return guarded(`sign in as ${tag}`, async () => {
      const context = await newIdentifiedContext(activeBrowser, 'finance-export', identityIndex);
      openContexts.push(context);
      const signedIn = await context.newPage();
      await signedIn.goto('/login');
      await signedIn.getByLabel('Email').fill(account.email);
      await signedIn.getByLabel('Password').fill(account.password);
      await signedIn.getByRole('button', { name: 'Sign in' }).click();
      await signedIn.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
      return signedIn;
    });
  }

  /** Lead -> Client -> Proposal -> Accept -> Booking, through the staff UI. Returns ids only. */
  async function provisionBooking(tag: string): Promise<{ bookingId: string; clientName: string }> {
    const clientName = `E2E Export Client ${tag} ${randomUUID()}`;
    const bookingId = await guarded(`provision booking ${tag}`, async () => {
      await page.goto('/admin/leads/new');
      await page.getByLabel('Full name').fill(clientName);
      await page.getByLabel('Source').fill('E2E finance export check');
      await page.getByLabel('Email').fill(`e2e-fx-client-${randomUUID()}@example.test`);
      await page.getByRole('button', { name: 'Create Lead' }).click();
      await page.getByRole('link', { name: 'View Lead' }).click(SLOW);
      await page.waitForURL((url) => /^\/admin\/leads\/[0-9a-fA-F-]{36}$/.test(url.pathname), SLOW);
      const leadId = extractTrailingId(page.url());
      recorded.leadIds.push(leadId);
      await page.getByText('Assigned Consultant:').waitFor(SLOW);

      await page.getByLabel('Change status to').selectOption({ label: 'Qualified' });
      await page.getByRole('button', { name: 'Change Status' }).click();
      await page.getByText('Status updated.').waitFor(SLOW);
      await page.getByRole('heading', { name: 'Convert to Client' }).waitFor(SLOW);
      await page.getByLabel('Create a new Client').check();
      await page.getByRole('button', { name: 'Continue' }).click();
      const [conversion] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.request().method() === 'POST' &&
            new URL(candidate.url()).pathname === `/api/leads/${leadId}/conversion`,
          SLOW,
        ),
        page.getByRole('button', { name: 'Confirm' }).click(),
      ]);
      const converted = (await conversion.json()) as { client?: { id?: unknown } };
      const clientId = converted.client?.id;
      if (!conversion.ok() || typeof clientId !== 'string') {
        throw new Error('Lead conversion did not return a client id.');
      }
      recorded.clientIds.push(clientId);

      await page.goto(`/admin/clients/${clientId}`);
      await page.getByLabel('Proposal content').waitFor(SLOW);
      await page.getByLabel('Proposal content').fill(`E2E finance export ${randomUUID()}`);
      await page.getByRole('button', { name: 'Create Proposal / ROS' }).click();
      await page.waitForURL(
        (url) => /^\/admin\/proposals\/[0-9a-fA-F-]{36}$/.test(url.pathname),
        SLOW,
      );
      recorded.proposalIds.push(extractTrailingId(page.url()));
      await page.getByRole('button', { name: 'Publish Version 1' }).click();
      await page.getByRole('heading', { name: 'Record Client Response' }).waitFor(SLOW);
      await page.getByLabel('Response', { exact: true }).selectOption({ label: 'Accept' });
      await page.getByLabel('Client responded at').fill(formatDatetimeLocal(new Date()));
      await page.getByLabel('Response method').fill('phone');
      await page.getByLabel('Evidence reference').fill(`E2E evidence ${randomUUID()}`);
      await page.getByRole('button', { name: 'Record Response for Version 1' }).click();
      await page.getByRole('button', { name: 'Create Booking' }).waitFor(SLOW);
      await page.getByRole('button', { name: 'Create Booking' }).click();
      await page.waitForURL(
        (url) => /^\/admin\/bookings\/[0-9a-fA-F-]{36}$/.test(url.pathname),
        SLOW,
      );
      const id = extractTrailingId(page.url());
      recorded.bookingIds.push(id);
      return id;
    });
    return { bookingId, clientName };
  }

  /** Admin / Manager assigns the fixture TC and one Finance user to a Booking. */
  async function assignStaff(adminPage: Page, bookingId: string, finance: Account, tag: string) {
    await guarded(`assign staff to booking ${tag}`, async () => {
      await adminPage.goto(`/admin/bookings/${bookingId}`);
      const tcPanel = adminPage
        .getByRole('heading', { name: 'Assignment', exact: true })
        .locator('xpath=..');
      await tcPanel.getByLabel('Assign to').waitFor(SLOW);
      await tcPanel.getByLabel('Assign to').selectOption({ label: tcAccount.name });
      await tcPanel.getByRole('button', { name: 'Assign' }).click();
      await tcPanel.getByText('Assignment updated.').waitFor(SLOW);

      const financePanel = adminPage
        .getByRole('heading', { name: 'Finance/Accounting assignment' })
        .locator('xpath=..');
      await financePanel
        .getByLabel('Assign to')
        .selectOption({ label: `${finance.name} (${finance.email})` });
      await financePanel.getByRole('button', { name: 'Assign' }).click();
      await financePanel.getByText('Finance/Accounting assignee set.').waitFor(SLOW);
    });
  }

  /** The assigned Finance user sets the Booking total and records one payment. */
  async function setTotalAndRecordPayment(
    financePage: Page,
    bookingId: string,
    total: string,
    amount: string,
    confirm: boolean,
    tag: string,
  ) {
    await guarded(`set total and record payment on booking ${tag}`, async () => {
      await financePage.goto(`/admin/payments/${bookingId}`);
      const totalForm = financePage.locator('form', {
        has: financePage.getByRole('heading', { name: 'Set the booking total' }),
      });
      await totalForm.getByLabel('Booking total').fill(total);
      await totalForm.getByLabel('Currency').selectOption('PHP');
      await totalForm.getByRole('button', { name: 'Save booking total' }).click();
      await financePage.getByRole('heading', { name: 'Correct the booking total' }).waitFor(SLOW);

      const recordForm = financePage.locator('form', {
        has: financePage.getByRole('heading', { name: 'Record a payment received' }),
      });
      await recordForm.getByLabel('Amount (PHP)').fill(amount);
      await recordForm.getByRole('button', { name: 'Record payment' }).click();
      const item = financePage.locator('section[aria-labelledby="payments-heading"] li', {
        has: financePage.locator('dt:text-is("Amount") + dd', { hasText: `PHP ${amount}` }),
      });
      await item.getByRole('button', { name: 'Confirm payment…' }).waitFor(SLOW);
      if (!confirm) return;
      await item.getByRole('button', { name: 'Confirm payment…' }).click();
      await item.locator('form').getByLabel('Reason', { exact: true }).fill('E2E: funds verified');
      await item.getByRole('button', { name: 'Confirm payment', exact: true }).click();
      await item.getByRole('button', { name: 'Issue receipt…' }).waitFor(SLOW);
    });
  }

  async function exportEntries(userId: string): Promise<Record<string, unknown>[]> {
    return guarded('read export audit entries', async () => {
      const rows = (await prisma.auditLog.findMany({
        where: { actorId: userId, action: 'FINANCE_EXPORT_GENERATED' },
        select: { afterState: true },
      })) as { afterState: Record<string, unknown> }[];
      return rows.map((row) => row.afterState);
    });
  }

  let primaryError: unknown;
  try {
    // ---------------------------------------------------------------- setup
    const admin = await createAccount('ADMIN_MANAGER', 'admin');
    const finance = await createAccount('FINANCE_ACCOUNTING', 'finance');
    const otherFinance = await createAccount('FINANCE_ACCOUNTING', 'finance-2');
    const visa = await createAccount('VISA_DOCUMENTATION', 'visa');
    const systemAdministrator = await createAccount('SYSTEM_ADMINISTRATOR', 'sysadmin');
    const clientUser = await createAccount('CLIENT', 'client');

    await guarded('sign in as the fixture Travel Consultant', async () => {
      await page.goto('/login');
      await page.getByLabel('Email').fill(tcAccount.email);
      await page.getByLabel('Password').fill(tcAccount.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => url.pathname === '/admin', { timeout: 45_000 });
    });

    const bookingA = await provisionBooking('A');
    const bookingB = await provisionBooking('B');
    const referenceOf = (bookingId: string): Promise<string> =>
      guarded('read a booking reference', async () => {
        const row = (await prisma.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { bookingReference: true },
        })) as { bookingReference: string };
        return row.bookingReference;
      });
    const referenceA = await referenceOf(bookingA.bookingId);
    const referenceB = await referenceOf(bookingB.bookingId);

    const adminPage = await signIn(browser, 1, admin, 'Admin / Manager');
    await assignStaff(adminPage, bookingA.bookingId, finance, 'A');
    await assignStaff(adminPage, bookingB.bookingId, otherFinance, 'B');

    const financePage = await signIn(browser, 2, finance, 'Finance / Accounting');
    await setTotalAndRecordPayment(financePage, bookingA.bookingId, '1000.00', '300.00', true, 'A');
    const otherFinancePage = await signIn(browser, 3, otherFinance, 'the second Finance user');
    await setTotalAndRecordPayment(
      otherFinancePage,
      bookingB.bookingId,
      '800.00',
      '200.00',
      false,
      'B',
    );
    console.log('[stage4] SETUP complete: two Bookings, one assigned to each Finance user.');

    // ------------------------------------ permitted role: Finance / Accounting
    const financePayments = await downloadThroughForm(
      financePage,
      'Finance',
      'payments',
      referenceA,
    );
    check(
      'Finance payments by reference: exactly the one payment of the assigned Booking',
      financePayments.rows.length === 1 &&
        financePayments.rows[0]?.bookingReference === referenceA &&
        financePayments.rows[0]?.clientFullName === bookingA.clientName &&
        financePayments.rows[0]?.currencyCode === 'PHP' &&
        financePayments.rows[0]?.amount === '300.00' &&
        financePayments.rows[0]?.status === 'CONFIRMED',
    );
    check(
      'Finance payments by reference: recordedAt and confirmedAt are timestamps, reversal and refund times are blank',
      TIMESTAMP_CELL.test(financePayments.rows[0]?.recordedAt ?? '') &&
        TIMESTAMP_CELL.test(financePayments.rows[0]?.confirmedAt ?? '') &&
        financePayments.rows[0]?.reversedAt === '' &&
        financePayments.rows[0]?.fullyRefundedAt === '',
    );

    const financeBookings = await downloadThroughForm(financePage, 'Finance', 'bookings', null);
    check(
      'Finance bookings unfiltered: only the Booking assigned to this Finance user',
      financeBookings.rows.length === 1 &&
        financeBookings.rows[0]?.bookingReference === referenceA &&
        financeBookings.rows[0]?.bookingTotalAmount === '1000.00' &&
        financeBookings.rows[0]?.derivedNetConfirmedPaid === '300.00' &&
        financeBookings.rows[0]?.derivedRemainingBalance === '700.00',
    );

    const financeOutOfScope = await downloadThroughForm(
      financePage,
      'Finance (unassigned Booking)',
      'payments',
      referenceB,
    );
    check(
      'Finance payments for a Booking it is not assigned to: an empty file, header only',
      financeOutOfScope.rows.length === 0,
    );

    const financeEntries = await exportEntries(finance.userId);
    check(
      'Finance: one audit entry per downloaded file, all scoped to assigned Bookings',
      financeEntries.length === 3 &&
        financeEntries.every(
          (entry) =>
            entry.scope === 'ASSIGNED_BOOKINGS' && entry.actorRole === 'FINANCE_ACCOUNTING',
        ) &&
        financeEntries
          .map((entry) => entry.rowCount)
          .sort()
          .join(',') === '0,1,1',
    );

    // A refusal shown by the form itself: a malformed booking reference.
    await guarded('Finance: malformed reference through the form', async () => {
      await financePage.goto('/admin/payments');
      const section = exportSection(financePage);
      await section.getByLabel('Records to export').selectOption('payments');
      await section.getByLabel(/^Booking reference/).fill('HPB-123');
      let downloads = 0;
      financePage.on('download', () => {
        downloads += 1;
      });
      const [response] = await Promise.all([
        financePage.waitForResponse(
          (candidate) => new URL(candidate.url()).pathname === EXPORT_PATH,
          SLOW,
        ),
        section.getByRole('button', { name: 'Download CSV' }).click(),
      ]);
      await section.getByRole('alert').waitFor(SLOW);
      check('Finance, malformed reference: the request returned 400', response.status() === 400);
      check(
        'Finance, malformed reference: the form shows its validation guidance',
        (await section
          .getByRole('alert')
          .filter({ hasText: 'Check the highlighted fields and try again.' })
          .count()) === 1,
      );
      check(
        'Finance, malformed reference: the booking reference field is marked invalid and described',
        (await section.getByLabel(/^Booking reference/).getAttribute('aria-invalid')) === 'true' &&
          (await section.getByLabel(/^Booking reference/).getAttribute('aria-describedby')) !==
            null,
      );
      check(
        'Finance, malformed reference: what was entered is still in the form',
        (await section.getByLabel(/^Booking reference/).inputValue()) === 'HPB-123' &&
          (await section.getByLabel('Records to export').inputValue()) === 'payments',
      );
      check('Finance, malformed reference: nothing was downloaded', downloads === 0);
    });
    check(
      'Finance, malformed reference: no further audit entry was written',
      (await exportEntries(finance.userId)).length === 3,
    );

    // ---------------------------------------- permitted role: Admin / Manager
    const adminPayments = await downloadThroughForm(adminPage, 'Admin', 'payments', referenceB);
    check(
      'Admin payments by reference: the pending payment of a Booking no Admin is assigned to',
      adminPayments.rows.length === 1 &&
        adminPayments.rows[0]?.bookingReference === referenceB &&
        adminPayments.rows[0]?.clientFullName === bookingB.clientName &&
        adminPayments.rows[0]?.amount === '200.00' &&
        adminPayments.rows[0]?.status === 'PENDING' &&
        adminPayments.rows[0]?.confirmedAt === '',
    );
    const adminBookings = await downloadThroughForm(adminPage, 'Admin', 'bookings', referenceA);
    check(
      'Admin bookings by reference: the fixture Booking is visible without an Admin assignment',
      adminBookings.rows.length === 1 &&
        adminBookings.rows[0]?.bookingReference === referenceA &&
        adminBookings.rows[0]?.clientFullName === bookingA.clientName &&
        adminBookings.rows[0]?.bookingTotalAmount === '1000.00' &&
        adminBookings.rows[0]?.derivedNetConfirmedPaid === '300.00' &&
        adminBookings.rows[0]?.derivedRemainingBalance === '700.00',
    );
    const adminEntries = await exportEntries(admin.userId);
    check(
      'Admin: one audit entry per downloaded file, both scoped to all Bookings',
      adminEntries.length === 2 &&
        adminEntries.every(
          (entry) => entry.scope === 'ALL_BOOKINGS' && entry.actorRole === 'ADMIN_MANAGER',
        ),
    );

    // ------------------------------------------ refusal for each other role
    // What each refused role is shown at /admin/payments: the Travel
    // Consultant may open the page and gets it without the export section;
    // the others get the application's "Access denied" page. Waiting for
    // that heading shows the page really rendered for a signed-in user
    // before the form's absence is counted.
    type RefusedHeading = 'Payments' | 'Access denied';
    const refused: [string, Page, string, RefusedHeading][] = [
      ['Travel Consultant', page, tcAccount.userId, 'Payments'],
    ];
    refused.push([
      'Visa Documentation',
      await signIn(browser, 4, visa, 'Visa Documentation'),
      visa.userId,
      'Access denied',
    ]);
    refused.push([
      'System Administrator',
      await signIn(browser, 5, systemAdministrator, 'System Administrator'),
      systemAdministrator.userId,
      'Access denied',
    ]);
    refused.push([
      'Client',
      await signIn(browser, 6, clientUser, 'Client'),
      clientUser.userId,
      'Access denied',
    ]);

    for (const [role, rolePage, userId, heading] of refused) {
      await guarded(`${role}: open the payments page`, async () => {
        await rolePage.goto('/admin/payments');
        const shown = await rolePage
          .getByRole('heading', { level: 1, name: heading, exact: true })
          .waitFor(SLOW)
          .then(
            () => true,
            () => false,
          );
        check(
          `${role}: /admin/payments rendered its "${heading}" page for this signed-in user`,
          shown && new URL(rolePage.url()).pathname === '/admin/payments',
        );
        check(
          `${role}: the page offers no export form`,
          (await rolePage.getByRole('button', { name: 'Download CSV' }).count()) === 0 &&
            (await rolePage.getByRole('heading', { name: 'Export finance records' }).count()) === 0,
        );
      });
      const outcome = await requestFromPage(rolePage, `${role}: request the export from its page`);
      check(
        `${role}: the export request from its browser session is refused with 403 and no file`,
        outcome.status === 403 && outcome.disposition === null && outcome.errorCode === 'FORBIDDEN',
      );
      check(`${role}: no audit entry was written`, (await exportEntries(userId)).length === 0);
    }

    // An unauthenticated browser (D-061 §10 names "an unauthenticated caller").
    const anonymousPage = await guarded('unauthenticated: open the sign-in page', async () => {
      const anonymousContext = await browser.newContext();
      openContexts.push(anonymousContext);
      const opened = await anonymousContext.newPage();
      await opened.goto('/login');
      return opened;
    });
    const anonymous = await requestFromPage(anonymousPage, 'unauthenticated: request the export');
    check(
      'Unauthenticated browser: the export request is refused with 401 and no file',
      anonymous.status === 401 &&
        anonymous.disposition === null &&
        anonymous.errorCode === 'UNAUTHENTICATED',
    );
  } catch (error) {
    primaryError = error;
  } finally {
    // Closing every context — the fixture's own included — removes
    // Playwright's temporary downloads and leaves no open page (D-064).
    // That they closed is a named check (D-065 §6), and the database
    // cleanup below runs whatever its outcome. `afterEach` closes and
    // checks again, for the case where this is not reached.
    check(CLOSURE_CHECK, await closeEveryContext(browser, page.context()));
    try {
      await removeRunData(prisma);
      // The fixture removes the Travel Consultant and the lead, client,
      // proposal, and booking chain it created; `afterAll` checks that.
      const residue = (await prisma.payment.findMany({
        where: { bookingId: { in: recorded.bookingIds } },
        select: { id: true },
      })) as unknown[];
      check('Cleanup: no payment of this run remains', residue.length === 0);
      const remainingUsers = (await prisma.user.findMany({
        where: { id: { in: recorded.staffUserIds } },
        select: { id: true },
      })) as unknown[];
      check('Cleanup: no account of this run remains', remainingUsers.length === 0);
      recorded.databaseCleaned = true;
    } catch (cleanupError) {
      // `afterEach` tries once more and, if that fails too, reports the ids.
      const kind = cleanupError instanceof Error ? cleanupError.constructor.name : 'unknown';
      check(`Cleanup completed without error (${kind})`, false);
    } finally {
      await prisma.$disconnect();
    }
  }

  const failed = results.filter((result) => !result.pass).map((result) => result.name);
  console.log(
    `[stage4] SUMMARY: ${results.length - failed.length} of ${results.length} checks passed.`,
  );
  if (primaryError) throw primaryError;
  expect(failed, 'Stage 4 checks that did not pass').toEqual([]);
});
