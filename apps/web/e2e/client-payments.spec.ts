import { createHash, randomUUID } from 'node:crypto';

import type { Browser, Page } from '@playwright/test';
import { generateRandomString, hashPassword } from 'better-auth/crypto';

import { e2eIdentityHeaders, newIdentifiedContext } from './support/browser-identity';
import { expect, test } from './support/fixtures';
import { createE2EPrismaRpcClient, type E2EPrismaRpcClient } from './support/test-database';

// D-054 Stage 5: the staff-to-client payment path in a real browser against
// the isolated production server (run-e2e.ts). Staff actions all go through
// the real admin UI: Admin/Manager assigns the Travel Consultant and the
// Finance/Accounting user to each Booking; Finance/Accounting sets the
// financials, approves the plan, records and confirms a payment, issues its
// receipt, and allocates it; the Travel Consultant proposes the plan. The
// client view is then checked for: proposed-only plans staying hidden, the
// approved plan and its server-computed balances, the confirmed payment and
// its receipt details — with no receipt file or download link (D-054 Stage 4
// correction, accepted September 29, 2026) — ownership isolation between two
// clients, and the denied and empty states. L2 (client payment-history
// wording) is unresolved: the client only ever sees this run's payment after
// it is confirmed, so no assertion here depends on how pending payments are
// presented.
//
// The Lead/Client/Proposal/Booking chain is built by the fixture's Travel
// Consultant and deleted by its own AuditLog-driven cleanupTestChain. Every
// other row this run creates — the Admin/Manager and Finance/Accounting
// accounts and their audit rows, the Booking assignments, every payment row,
// the portal invitations, client profiles, activated client users, and
// activation rate-limit rows — is invisible to that mechanism and is deleted
// by this spec itself, before the fixture's teardown, then verified absent.

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.use({ extraHTTPHeaders: e2eIdentityHeaders('client-payments', 0) });

const SLOW = { timeout: 45_000 } as const;

const DUE_1 = '2026-11-15';
const DUE_2 = '2026-12-15';

const COPY = {
  pageHeading: 'Payments & Receipts',
  emptyState: 'No payment plans to show yet.',
  staffPanel: 'Client area',
  noPayments: 'No payments have been recorded yet.',
} as const;

/** Mirrors features/invitations/token.ts's hashInvitationToken exactly. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Mirrors features/activation/rate-limit.ts's SOURCE_WINDOW_MS exactly. */
const SOURCE_WINDOW_MS = 15 * 60 * 1000;
function currentSourceWindowStart(): Date {
  return new Date(Math.floor(Date.now() / SOURCE_WINDOW_MS) * SOURCE_WINDOW_MS);
}

function extractTrailingId(url: string): string {
  const match = /\/([0-9a-fA-F-]{36})\/?(?:\?.*)?$/.exec(new URL(url).pathname);
  const id = match?.[1];
  if (!id) throw new Error(`Could not extract a UUID from URL: ${url}`);
  return id;
}

function formatDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The client view's own money format: currency, grouped whole part, two decimals. */
function php(amount: string): string {
  const [whole, fraction] = amount.split('.');
  return `PHP ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** The client view's own calendar-date format for a `@db.Date` value. */
function calendarDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00.000Z`).toLocaleDateString('en-PH', { timeZone: 'UTC' });
}

/**
 * Waits, on the page as it is, for a UI update that the screen's own
 * `router.refresh()` must produce after a successful mutation. One wait of
 * up to `SLOW` (45 s), with no reload and no retry: if the current screen
 * does not update in that time, the check fails.
 *
 * This replaces the reload-and-retry helper the other specs use
 * (`expectAfterRefresh`: wait 20 s, reload and pause 2.5 s, wait 20 s,
 * reload and pause 2.5 s, wait 45 s). The timing therefore differs: an
 * in-place update now has 45 s to appear instead of 20 s before the first
 * reload, and the longest wait before failing is 45 s instead of about
 * 90 s plus two reloads. A page that only shows the update after a reload
 * now fails here.
 */
async function expectUpdatedInPlace(
  locator: ReturnType<Page['getByRole']>,
  description: string,
): Promise<void> {
  await expect(locator, description).toBeVisible(SLOW);
}

function assertPrivateNoStoreCacheControl(raw: string | undefined, context: string): void {
  expect(raw, `${context}: Cache-Control must be present`).toBeTruthy();
  const directives = (raw ?? '').split(',').map((d) => d.trim().toLowerCase());
  expect(directives, `${context}: must include "private"`).toContain('private');
  expect(directives, `${context}: must include "no-store"`).toContain('no-store');
  expect(directives.includes('public'), `${context}: must not include "public"`).toBe(false);
}

function assertAbsent(surface: string, values: string[], context: string): void {
  for (const value of values) {
    expect(surface.includes(value), `${context}: "${value}" must be absent`).toBe(false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function narrowIdOnly(value: unknown, context: string): { id: string } {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error(`${context}: malformed { id } row.`);
  }
  return { id: value.id };
}
function narrowFirstIdOnly(value: unknown, context: string): { id: string } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context}: expected at least one { id } row.`);
  }
  return narrowIdOnly(value[0], context);
}
function narrowIdRows(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context}: expected an array of id rows.`);
  return value.map((row, i) => narrowIdOnly(row, `${context}[${i}]`).id);
}
function narrowStringField(value: unknown, field: string, context: string): string {
  if (!isRecord(value) || typeof value[field] !== 'string') {
    throw new Error(`${context}: malformed row (missing ${field}).`);
  }
  return value[field] as string;
}

// --- Module-scoped record, populated as each real entity is created, for
// the spec-owned cleanup and the afterAll residue check. ---
const recorded = {
  tcUserId: undefined as string | undefined,
  staffUserIds: [] as string[],
  leadIds: [] as string[],
  clientIds: [] as string[],
  proposalIds: [] as string[],
  bookingIds: [] as string[],
  activatedUserIds: [] as string[],
  profileIds: [] as string[],
  invitationIds: [] as string[],
  rawTokens: [] as string[],
};

type StaffAccount = { userId: string; email: string; password: string; name: string };

type ProvisionedClient = {
  label: 'A' | 'B' | 'C';
  nameCanary: string;
  email: string;
  clientPassword: string;
  clientId: string;
};

/**
 * A login-capable staff account for this run only, created exactly as the
 * tcAccount fixture creates its own (a User plus a linked credential
 * Account in one nested write, hashed with better-auth's own hashPassword).
 * Recorded before creation so the spec-owned cleanup always removes it.
 */
async function createStaffAccount(
  prisma: E2EPrismaRpcClient,
  role: 'ADMIN_MANAGER' | 'FINANCE_ACCOUNTING',
): Promise<StaffAccount> {
  const userId = randomUUID();
  const email = `e2e-cp-${role.toLowerCase().replace('_', '-')}-${randomUUID()}@example.test`;
  const name = `E2E ${role === 'ADMIN_MANAGER' ? 'Admin' : 'Finance'} ${randomUUID()}`;
  const password = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');
  recorded.staffUserIds.push(userId);
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
  return { userId, email, password, name };
}

async function signIn(
  browser: Browser,
  identityIndex: number,
  email: string,
  password: string,
): Promise<Page> {
  const context = await newIdentifiedContext(browser, 'client-payments', identityIndex);
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
  return page;
}

test('D-054 Stage 5: staff record a payment path that the client sees only once approved — balances, receipt details without a download, isolation, and the denied and empty states', async ({
  tcAccount,
  browser,
  page,
}) => {
  test.setTimeout(1_200_000);
  const prisma = createE2EPrismaRpcClient();
  recorded.tcUserId = tcAccount.userId;

  async function provisionClient(label: 'A' | 'B' | 'C'): Promise<ProvisionedClient> {
    const nameCanary = `E2E CP ${label} ${randomUUID()}`;
    const email = `e2e-cp-${label.toLowerCase()}-${randomUUID()}@example.test`;
    const clientPassword = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');

    await page.goto('/admin/leads/new');
    await page.getByLabel('Full name').fill(nameCanary);
    await page.getByLabel('Source').fill('E2E client-payments journey');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Create Lead' }).click();
    await expect(page.getByRole('status')).toContainText(`Lead ${nameCanary} was created.`, SLOW);
    await page.getByRole('link', { name: 'View Lead' }).click();
    await page.waitForURL((url) => /^\/admin\/leads\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const leadId = extractTrailingId(page.url());
    recorded.leadIds.push(leadId);
    await expect(page.getByText('Assigned Consultant:')).toBeVisible(SLOW);

    await page.getByLabel('Change status to').selectOption({ label: 'Qualified' });
    await page.getByRole('button', { name: 'Change Status' }).click();
    await expect(page.getByText('Status updated.')).toBeVisible(SLOW);

    await expectUpdatedInPlace(
      page.getByRole('heading', { name: 'Convert to Client' }),
      `Convert to Client panel (${label})`,
    );
    await page.getByLabel('Create a new Client').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    const [conversionResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname === `/api/leads/${leadId}/conversion`,
        SLOW,
      ),
      page.getByRole('button', { name: 'Confirm' }).click(),
    ]);
    expect(conversionResponse.ok()).toBe(true);
    // Record the converted Client's id from the conversion response itself,
    // before the Clients navigation (client-overview.spec.ts's own pattern),
    // so the afterAll Client residue check covers it even if a later step
    // in this function fails before the detail page is reached.
    const conversionBody: unknown = await conversionResponse.json();
    recorded.clientIds.push(
      narrowIdOnly(
        isRecord(conversionBody) ? conversionBody.client : undefined,
        `conversion response client (${label})`,
      ).id,
    );

    await page.getByRole('link', { name: 'Clients', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/admin/clients');
    // The Clients list must render after the link click itself — no reload.
    await expect(page.getByLabel('Search'), `Clients Search (${label})`).toBeVisible(SLOW);
    await page.getByLabel('Search').fill(nameCanary);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.locator('a:visible', { hasText: nameCanary }).click();
    await page.waitForURL((url) => /^\/admin\/clients\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const clientId = extractTrailingId(page.url());
    if (!recorded.clientIds.includes(clientId)) recorded.clientIds.push(clientId);
    await expect(page.getByRole('heading', { name: nameCanary })).toBeVisible(SLOW);

    return { label, nameCanary, email, clientPassword, clientId };
  }

  /** Proposal -> publish -> recorded Accept -> Create Booking (client-bookings.spec.ts's sequence). */
  async function createAcceptedBooking(clientId: string, marker: string): Promise<string> {
    await page.goto(`/admin/clients/${clientId}`);
    await expect(page.getByLabel('Proposal content')).toBeVisible(SLOW);
    await page.getByLabel('Proposal content').fill(marker);
    await page.getByRole('button', { name: 'Create Proposal / ROS' }).click();
    await page.waitForURL((url) => /^\/admin\/proposals\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    recorded.proposalIds.push(extractTrailingId(page.url()));

    await page.getByRole('button', { name: 'Publish Version 1' }).click();
    await expectUpdatedInPlace(
      page.getByRole('heading', { name: 'Record Client Response' }),
      `Record Client Response panel (${marker})`,
    );
    await page.getByLabel('Response', { exact: true }).selectOption({ label: 'Accept' });
    await page.getByLabel('Client responded at').fill(formatDatetimeLocal(new Date()));
    await page.getByLabel('Response method').fill('phone');
    await page.getByLabel('Evidence reference').fill(`E2E evidence ${randomUUID()}`);
    await page.getByRole('button', { name: 'Record Response for Version 1' }).click();
    await expectUpdatedInPlace(
      page.getByRole('button', { name: 'Create Booking' }),
      `Create Booking button (${marker})`,
    );
    await page.getByRole('button', { name: 'Create Booking' }).click();
    await page.waitForURL((url) => /^\/admin\/bookings\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const bookingId = extractTrailingId(page.url());
    recorded.bookingIds.push(bookingId);
    return bookingId;
  }

  async function inviteAndActivate(
    client: ProvisionedClient,
    identityIndex: number,
  ): Promise<void> {
    await page.goto(`/admin/clients/${client.clientId}`);
    await page.getByRole('button', { name: 'Prepare Invitation' }).click();
    await expect(page.getByText('Invitation prepared.')).toBeVisible(SLOW);
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(page.getByText('Invitation sent.')).toBeVisible(SLOW);
    const manualUrl = await page.getByLabel('One-time invitation link').inputValue();
    // Recovered only to hash it for this spec's own RateLimitBucket cleanup
    // — never logged or persisted.
    const rawToken = /#token=([A-Za-z0-9_-]{24})$/.exec(manualUrl)?.[1];
    if (!rawToken) throw new Error(`Could not extract the invitation token (${client.label}).`);
    // Recorded now, not after activation, so a failure later in this
    // function still lets cleanup remove this token's rate-limit rows.
    recorded.rawTokens.push(rawToken);
    await page.getByRole('button', { name: 'Confirm Manual Sent' }).click();
    await expect(page.getByText('Manual send confirmed.')).toBeVisible(SLOW);

    const context = await newIdentifiedContext(browser, 'client-payments', identityIndex);
    try {
      const activationPage = await context.newPage();
      await activationPage.goto(manualUrl);
      await activationPage.getByRole('button', { name: 'Continue' }).click();
      await activationPage.getByLabel('Password', { exact: true }).fill(client.clientPassword);
      await activationPage
        .getByLabel('Confirm password', { exact: true })
        .fill(client.clientPassword);
      await activationPage.getByRole('button', { name: 'Activate account' }).click();
      await activationPage.waitForURL(
        (url) => url.pathname === '/login' && url.searchParams.get('activated') === '1',
        { timeout: 45_000 },
      );
    } finally {
      await context.close();
    }

    recorded.profileIds.push(
      narrowIdOnly(
        await prisma.clientProfile.findUniqueOrThrow({
          where: { clientId: client.clientId },
          select: { id: true },
        }),
        `ClientProfile(${client.label})`,
      ).id,
    );
    recorded.invitationIds.push(
      narrowIdOnly(
        await prisma.portalInvitation.findUniqueOrThrow({
          where: { clientId: client.clientId },
          select: { id: true },
        }),
        `PortalInvitation(${client.label})`,
      ).id,
    );
    recorded.activatedUserIds.push(
      narrowFirstIdOnly(
        await prisma.user.findMany({ where: { email: client.email }, select: { id: true } }),
        `activated User(${client.label})`,
      ).id,
    );
  }

  /** Admin/Manager assigns the fixture TC and the Finance user through the Booking detail panels. */
  async function assignBookingStaff(
    adminPage: Page,
    bookingId: string,
    finance: StaffAccount,
  ): Promise<void> {
    await adminPage.goto(`/admin/bookings/${bookingId}`);
    const tcPanel = adminPage
      .getByRole('heading', { name: 'Assignment', exact: true })
      .locator('xpath=..');
    await expect(tcPanel.getByLabel('Assign to')).toBeVisible(SLOW);
    await tcPanel.getByLabel('Assign to').selectOption({ label: tcAccount.name });
    await tcPanel.getByRole('button', { name: 'Assign' }).click();
    await expect(tcPanel.getByText('Assignment updated.')).toBeVisible(SLOW);

    const financePanel = adminPage
      .getByRole('heading', { name: 'Finance/Accounting assignment' })
      .locator('xpath=..');
    await financePanel
      .getByLabel('Assign to')
      .selectOption({ label: `${finance.name} (${finance.email})` });
    await financePanel.getByRole('button', { name: 'Assign' }).click();
    await expect(financePanel.getByText('Finance/Accounting assignee set.')).toBeVisible(SLOW);
    await expectUpdatedInPlace(
      adminPage.locator('strong', { hasText: `${finance.name} (${finance.email})` }),
      'Finance assignee shown after refresh',
    );
  }

  async function setFinancials(financePage: Page, bookingId: string, total: string) {
    await financePage.goto(`/admin/payments/${bookingId}`);
    const form = financePage.locator('form', {
      has: financePage.getByRole('heading', { name: 'Set the booking total' }),
    });
    await form.getByLabel('Booking total').fill(total);
    await form.getByLabel('Currency').selectOption('PHP');
    await form.getByRole('button', { name: 'Save booking total' }).click();
    await expect(financePage.getByText('Booking total saved.')).toBeVisible(SLOW);
    await expectUpdatedInPlace(
      financePage.getByRole('heading', { name: 'Correct the booking total' }),
      'financials saved',
    );
  }

  async function proposePlan(bookingId: string, rows: [string, string][]) {
    await page.goto(`/admin/payments/${bookingId}`);
    await expect(page.getByRole('button', { name: 'Propose plan' })).toBeVisible(SLOW);
    for (let i = 1; i < rows.length; i += 1) {
      await page.getByRole('button', { name: 'Add installment' }).click();
    }
    for (const [i, [amount, due]] of rows.entries()) {
      await page.getByLabel(new RegExp(`^Installment ${i + 1} .*amount$`)).fill(amount);
      await page.getByLabel('Due date').nth(i).fill(due);
    }
    await page.getByRole('button', { name: 'Propose plan' }).click();
    await expectUpdatedInPlace(
      page.getByText('Proposed — awaiting Finance approval'),
      'plan proposed',
    );
  }

  async function approvePlan(financePage: Page, bookingId: string) {
    await financePage.goto(`/admin/payments/${bookingId}`);
    await financePage.getByRole('button', { name: 'Approve plan…' }).click();
    const box = financePage.locator('form', {
      hasText: 'Approving makes this plan visible to the client',
    });
    await box.getByRole('button', { name: 'Approve plan', exact: true }).click();
    await expectUpdatedInPlace(financePage.getByText('Status: Approved'), 'approved');
  }

  function paymentItem(financePage: Page, amount: string) {
    return financePage.locator('section[aria-labelledby="payments-heading"] li', {
      has: financePage.locator('dt:text-is("Amount") + dd', { hasText: amount }),
    });
  }

  const clientCard = (clientPage: Page, reference: string) =>
    clientPage.getByRole('main').getByRole('article', { name: `Booking ${reference}` });
  const fact = async (clientPage: Page, reference: string, term: string) =>
    (
      await clientCard(clientPage, reference)
        .locator(`dt:text-is("${term}") + dd`)
        .first()
        .textContent()
    )?.trim();

  let primaryError: unknown;
  try {
    // 1. Staff accounts for this run (the TC comes from the fixture).
    const admin = await createStaffAccount(prisma, 'ADMIN_MANAGER');
    const finance = await createStaffAccount(prisma, 'FINANCE_ACCOUNTING');

    // 2. TC builds two client chains through the real admin UI; C has no Booking.
    await page.goto('/login');
    await page.getByLabel('Email').fill(tcAccount.email);
    await page.getByLabel('Password').fill(tcAccount.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 45_000 });

    const clientA = await provisionClient('A');
    const clientB = await provisionClient('B');
    const clientC = await provisionClient('C');
    const bookingA = await createAcceptedBooking(clientA.clientId, `E2E-CP-A-${randomUUID()}`);
    const bookingB = await createAcceptedBooking(clientB.clientId, `E2E-CP-B-${randomUUID()}`);
    const refOf = async (bookingId: string) =>
      narrowStringField(
        await prisma.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { bookingReference: true },
        }),
        'bookingReference',
        'Booking',
      );
    const refA = await refOf(bookingA);
    const refB = await refOf(bookingB);

    // 3. Admin/Manager assigns the TC and Finance to both Bookings.
    const adminPage = await signIn(browser, 1, admin.email, admin.password);
    await assignBookingStaff(adminPage, bookingA, finance);
    await assignBookingStaff(adminPage, bookingB, finance);

    // 4. Finance sets the financials; the TC proposes each plan.
    const financePage = await signIn(browser, 2, finance.email, finance.password);
    await setFinancials(financePage, bookingA, '1000.00');
    await setFinancials(financePage, bookingB, '800.00');
    await proposePlan(bookingA, [
      ['300.00', DUE_1],
      ['700.00', DUE_2],
    ]);
    await proposePlan(bookingB, [['800.00', DUE_1]]);

    // 5. Invite and activate A, B, and C.
    // The two fixed pauses below are carried over from the other specs'
    // activation sequence. Each follows a completed activation and precedes
    // a full page load, so neither can mask an in-place update.
    await inviteAndActivate(clientA, 3);
    await page.waitForTimeout(2000);
    await inviteAndActivate(clientB, 4);
    await page.waitForTimeout(2000);
    await inviteAndActivate(clientC, 5);

    // 6. A proposed-only plan is never client-visible.
    const pageA = await signIn(browser, 6, clientA.email, clientA.clientPassword);
    await pageA.goto('/client/payments');
    await expect(
      pageA.getByRole('main').getByRole('heading', { level: 1, name: COPY.pageHeading }),
    ).toBeVisible(SLOW);
    await expect(pageA.getByRole('main').getByText(COPY.emptyState)).toBeVisible(SLOW);
    await expect(pageA.getByRole('main').getByRole('article')).toHaveCount(0);
    assertAbsent(await pageA.content(), [refA], 'client A while the plan is only proposed');

    // 7. Finance approves both plans; A now sees the approved plan and balances.
    await approvePlan(financePage, bookingA);
    await approvePlan(financePage, bookingB);
    await pageA.goto('/client/payments');
    await expect(clientCard(pageA, refA)).toBeVisible(SLOW);
    expect(await fact(pageA, refA, 'Total booking amount')).toBe(php('1000.00'));
    expect(await fact(pageA, refA, 'Confirmed amount paid')).toBe(php('0.00'));
    expect(await fact(pageA, refA, 'Remaining balance')).toBe(php('1000.00'));
    expect(await fact(pageA, refA, 'Next payment due')).toBe(
      `${php('300.00')} on ${calendarDate(DUE_1)}`,
    );
    await expect(clientCard(pageA, refA).getByText(COPY.noPayments)).toBeVisible();

    // 8. Finance records, confirms, receipts, and allocates a 300.00 payment.
    await financePage.goto(`/admin/payments/${bookingA}`);
    const recordForm = financePage.locator('form', {
      has: financePage.getByRole('heading', { name: 'Record a payment received' }),
    });
    await recordForm.getByLabel('Amount (PHP)').fill('300.00');
    await recordForm.getByRole('button', { name: 'Record payment' }).click();
    await expectUpdatedInPlace(
      paymentItem(financePage, 'PHP 300.00').getByRole('button', { name: 'Confirm payment…' }),
      'payment recorded',
    );
    // A recorded but not yet confirmed (PENDING) payment must not reduce the
    // balance (D-054 §5: its net contribution is 0). Only the three
    // server-computed balance values are checked here — nothing about how a
    // pending payment is worded or listed in the history (L2, unresolved).
    await pageA.goto('/client/payments');
    await expect(clientCard(pageA, refA)).toBeVisible(SLOW);
    expect(await fact(pageA, refA, 'Confirmed amount paid')).toBe(php('0.00'));
    expect(await fact(pageA, refA, 'Remaining balance')).toBe(php('1000.00'));
    expect(await fact(pageA, refA, 'Next payment due')).toBe(
      `${php('300.00')} on ${calendarDate(DUE_1)}`,
    );

    const recordedItem = paymentItem(financePage, 'PHP 300.00');
    await recordedItem.getByRole('button', { name: 'Confirm payment…' }).click();
    await recordedItem
      .locator('form')
      .getByLabel('Reason', { exact: true })
      .fill('E2E: funds verified');
    await recordedItem.getByRole('button', { name: 'Confirm payment', exact: true }).click();
    await expectUpdatedInPlace(
      paymentItem(financePage, 'PHP 300.00').getByRole('button', { name: 'Issue receipt…' }),
      'payment confirmed',
    );
    await paymentItem(financePage, 'PHP 300.00')
      .getByRole('button', { name: 'Issue receipt…' })
      .click();
    await paymentItem(financePage, 'PHP 300.00')
      .getByRole('button', { name: 'Issue receipt', exact: true })
      .click();
    await expect(
      financePage
        .locator('section[aria-labelledby="payments-heading"]')
        .getByRole('status')
        .filter({ hasText: 'Receipt issued.' }),
    ).toBeVisible(SLOW);
    const allocateForm = financePage.locator('form', {
      has: financePage.getByRole('heading', { name: 'Allocate a payment to an installment' }),
    });
    await expectUpdatedInPlace(
      allocateForm.getByLabel('Amount (PHP)'),
      'allocation form available',
    );
    await allocateForm.getByLabel('Amount (PHP)').fill('300.00');
    await allocateForm.getByRole('button', { name: 'Allocate' }).click();
    await expect(financePage.getByText('Allocation recorded.')).toBeVisible(SLOW);

    const receiptRows = await prisma.receipt.findMany({
      where: { payment: { bookingId: bookingA } },
      select: { id: true, receiptNumber: true },
    });
    expect(Array.isArray(receiptRows) && receiptRows.length).toBe(1);
    const receiptNumberA = narrowStringField(
      (receiptRows as unknown[])[0],
      'receiptNumber',
      'Receipt',
    );

    // 9. A sees the server-computed balances and the receipt details — no download.
    await pageA.goto('/client/payments');
    await expect(clientCard(pageA, refA)).toBeVisible(SLOW);
    expect(await fact(pageA, refA, 'Confirmed amount paid')).toBe(php('300.00'));
    expect(await fact(pageA, refA, 'Remaining balance')).toBe(php('700.00'));
    expect(await fact(pageA, refA, 'Next payment due')).toBe(
      `${php('700.00')} on ${calendarDate(DUE_2)}`,
    );
    const history = clientCard(pageA, refA).getByRole('region', { name: 'Payment history' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
    const historyRow = history.getByRole('listitem').first();
    await expect(historyRow).toContainText(php('300.00'));
    await expect(historyRow).toContainText('Confirmed');
    await expect(historyRow).toContainText(`Receipt ${receiptNumberA}, issued`);
    const schedule = clientCard(pageA, refA).getByRole('region', { name: 'Installment schedule' });
    await expect(schedule.getByRole('listitem')).toHaveCount(2);
    await expect(schedule.getByRole('listitem').first()).toContainText('Paid');

    // The accepted Stage 4 correction: receipt details only — no link,
    // download, or file of any kind, and no action control.
    const mainA = pageA.getByRole('main');
    await expect(mainA.locator('a[download]')).toHaveCount(0);
    await expect(historyRow.locator('a')).toHaveCount(0);
    const hrefsA = await mainA
      .locator('a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect([...new Set(hrefsA)].sort()).toEqual([`/client/bookings/${refA}`, '/client/support']);
    await expect(mainA.locator('button, form, input, select, textarea')).toHaveCount(0);

    // 10. Isolation and client-safe output, including the raw HTML and
    // inline RSC payload, and the private/no-store response headers.
    // Labelled, so a failure names the leaking record type without echoing the id.
    const internalIdsA: [string, string[]][] = [
      ['Booking', [bookingA]],
      ['Client', [clientA.clientId]],
      [
        'PaymentPlan',
        narrowIdRows(
          await prisma.paymentPlan.findMany({
            where: { bookingId: bookingA },
            select: { id: true },
          }),
          'PaymentPlan(A)',
        ),
      ],
      [
        'Installment',
        narrowIdRows(
          await prisma.installment.findMany({
            where: { paymentPlan: { bookingId: bookingA } },
            select: { id: true },
          }),
          'Installment(A)',
        ),
      ],
      [
        'Payment',
        narrowIdRows(
          await prisma.payment.findMany({ where: { bookingId: bookingA }, select: { id: true } }),
          'Payment(A)',
        ),
      ],
      [
        'PaymentStatusHistory',
        narrowIdRows(
          await prisma.paymentStatusHistory.findMany({
            where: { payment: { bookingId: bookingA } },
            select: { id: true },
          }),
          'PaymentStatusHistory(A)',
        ),
      ],
      [
        'PaymentAllocation',
        narrowIdRows(
          await prisma.paymentAllocation.findMany({
            where: { payment: { bookingId: bookingA } },
            select: { id: true },
          }),
          'PaymentAllocation(A)',
        ),
      ],
      [
        'Receipt',
        narrowIdRows(
          await prisma.receipt.findMany({
            where: { payment: { bookingId: bookingA } },
            select: { id: true },
          }),
          'Receipt(A)',
        ),
      ],
    ];
    const responseA = await pageA.request.get('/client/payments');
    expect(responseA.status()).toBe(200);
    assertPrivateNoStoreCacheControl(responseA.headers()['cache-control'], 'client A payments');
    expect(responseA.headers()['referrer-policy']).toBe('no-referrer');
    const htmlA = await responseA.text();
    expect(htmlA).toContain(refA);
    assertAbsent(
      htmlA,
      [refB, clientB.nameCanary, bookingB, clientB.clientId],
      'client A payments',
    );
    // Positive control: every id list must be non-empty, or the leak check
    // below would pass without checking anything.
    for (const [recordLabel, ids] of internalIdsA) {
      expect(ids.length, `${recordLabel} ids recorded for client A`).toBeGreaterThan(0);
    }
    const leakedA = internalIdsA
      .filter(([, ids]) => ids.some((id) => htmlA.includes(id)))
      .map(([label]) => label);
    expect(leakedA, 'client A payments HTML/RSC payload: internal record ids').toEqual([]);

    const pageB = await signIn(browser, 7, clientB.email, clientB.clientPassword);
    await pageB.goto('/client/payments');
    await expect(clientCard(pageB, refB)).toBeVisible(SLOW);
    await expect(pageB.getByRole('main').getByRole('article')).toHaveCount(1);
    expect(await fact(pageB, refB, 'Total booking amount')).toBe(php('800.00'));
    expect(await fact(pageB, refB, 'Remaining balance')).toBe(php('800.00'));
    await expect(clientCard(pageB, refB).getByText(COPY.noPayments)).toBeVisible();
    const responseB = await pageB.request.get('/client/payments');
    expect(responseB.status()).toBe(200);
    const htmlB = await responseB.text();
    // Positive control: this is B's own page, not an error or redirect body.
    expect(htmlB).toContain(refB);
    assertAbsent(htmlB, [refA, receiptNumberA, clientA.nameCanary, bookingA], 'client B payments');

    // The client surface is read-only server-side, not only in the UI
    // (D-054 §7): a signed-in client is refused by a payments mutation
    // route and by the staff payments page for their own Booking.
    const clientMutation = await pageA.request.post('/api/payments', { data: {} });
    expect(clientMutation.status()).toBe(403);
    const clientOnStaffPage = await pageA.request.get(`/admin/payments/${bookingA}`);
    const staffPageHtml = await clientOnStaffPage.text();
    expect(staffPageHtml).toContain('Access denied');
    assertAbsent(
      staffPageHtml,
      [refA, receiptNumberA, 'Record a payment received'],
      'client A requesting the staff payments page',
    );

    // 11. Empty state with a Support & Messages path.
    const pageC = await signIn(browser, 8, clientC.email, clientC.clientPassword);
    await pageC.goto('/client/payments');
    await expect(pageC.getByRole('main').getByText(COPY.emptyState)).toBeVisible(SLOW);
    await expect(pageC.getByRole('main').getByRole('article')).toHaveCount(0);
    await expect(
      pageC.getByRole('main').getByRole('link', { name: 'Support & Messages' }).first(),
    ).toHaveAttribute('href', '/client/support');

    // 12. Denied: a staff account, and a signed-out visitor.
    await page.goto('/client/payments');
    await expect(page.getByRole('main').getByText(COPY.staffPanel)).toBeVisible(SLOW);
    assertAbsent(await page.content(), [refA, refB], 'staff visiting /client/payments');

    const anonymous = await newIdentifiedContext(browser, 'client-payments', 9);
    try {
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto('/client/payments');
      await anonymousPage.waitForURL((url) => url.pathname === '/login', SLOW);
    } finally {
      await anonymous.close();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // --- Spec-owned cleanup — unconditional, before the tcAccount
    // fixture's cleanupTestChain, and scoped by this run's recorded ids —
    // except the shared SOURCE rate-limit bucket for the current window,
    // which is removed best-effort, as the other specs do. ---
    try {
      const bookings = { in: recorded.bookingIds };
      if (recorded.bookingIds.length > 0) {
        // 1. Payment rows (they reference the Booking and staff Users).
        await prisma.receipt.deleteMany({ where: { payment: { bookingId: bookings } } });
        await prisma.paymentAllocation.deleteMany({ where: { payment: { bookingId: bookings } } });
        await prisma.paymentStatusHistory.deleteMany({
          where: { payment: { bookingId: bookings } },
        });
        await prisma.payment.deleteMany({ where: { bookingId: bookings } });
        await prisma.installment.deleteMany({ where: { paymentPlan: { bookingId: bookings } } });
        await prisma.paymentPlan.deleteMany({ where: { bookingId: bookings } });
        // 2. Booking assignments made by the Admin/Manager.
        await prisma.staffAssignment.deleteMany({ where: { bookingId: bookings } });
      }

      // 3. PortalInvitation, ClientProfile, activated clients, rate limits.
      // Re-discovered by Client id first (client-overview.spec.ts's own
      // remedy): a failure inside inviteAndActivate, after the invitation or
      // profile exists but before its id was recorded, must not leave a row
      // that blocks the fixture's Client delete (both are onDelete: Restrict).
      if (recorded.clientIds.length > 0) {
        const byClient = { clientId: { in: recorded.clientIds } };
        const invitationRows: unknown = await prisma.portalInvitation.findMany({
          where: byClient,
          select: { id: true },
        });
        for (const id of narrowIdRows(invitationRows, 'PortalInvitation by client')) {
          if (!recorded.invitationIds.includes(id)) recorded.invitationIds.push(id);
        }
        const profileRows: unknown = await prisma.clientProfile.findMany({
          where: byClient,
          select: { id: true, userId: true },
        });
        for (const row of Array.isArray(profileRows) ? profileRows : []) {
          if (!isRecord(row) || typeof row.id !== 'string' || typeof row.userId !== 'string') {
            throw new Error('ClientProfile by client: malformed { id, userId } row.');
          }
          if (!recorded.profileIds.includes(row.id)) recorded.profileIds.push(row.id);
          if (!recorded.activatedUserIds.includes(row.userId)) {
            recorded.activatedUserIds.push(row.userId);
          }
        }
      }
      if (recorded.invitationIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { entityId: { in: recorded.invitationIds } } });
        await prisma.portalInvitation.deleteMany({ where: { id: { in: recorded.invitationIds } } });
      }
      if (recorded.profileIds.length > 0) {
        await prisma.clientProfile.deleteMany({ where: { id: { in: recorded.profileIds } } });
      }
      if (recorded.activatedUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: recorded.activatedUserIds } } });
      }
      if (recorded.rawTokens.length > 0) {
        await prisma.rateLimitBucket.deleteMany({
          where: { dimension: 'TOKEN', bucketKey: { in: recorded.rawTokens.map(sha256Hex) } },
        });
        await prisma.rateLimitBucket.deleteMany({
          where: {
            dimension: 'SOURCE',
            bucketKey: 'unknown-source',
            windowStart: currentSourceWindowStart(),
          },
        });
      }

      // 4. The Admin/Manager and Finance/Accounting accounts, after their audit rows.
      if (recorded.staffUserIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorId: { in: recorded.staffUserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: recorded.staffUserIds } } });
      }

      // 5. In-test residue checks by recorded id.
      if (recorded.bookingIds.length > 0) {
        for (const [label, run] of [
          [
            'PaymentPlan',
            () =>
              prisma.paymentPlan.findMany({ where: { bookingId: bookings }, select: { id: true } }),
          ],
          [
            'Payment',
            () => prisma.payment.findMany({ where: { bookingId: bookings }, select: { id: true } }),
          ],
          [
            'Receipt',
            () =>
              prisma.receipt.findMany({
                where: { payment: { bookingId: bookings } },
                select: { id: true },
              }),
          ],
        ] as const) {
          expect(narrowIdRows(await run(), `${label} residue`)).toEqual([]);
        }
      }
      if (recorded.clientIds.length > 0) {
        const byClient = { clientId: { in: recorded.clientIds } };
        expect(
          narrowIdRows(
            await prisma.portalInvitation.findMany({ where: byClient, select: { id: true } }),
            'PortalInvitation residue',
          ),
        ).toEqual([]);
        expect(
          narrowIdRows(
            await prisma.clientProfile.findMany({ where: byClient, select: { id: true } }),
            'ClientProfile residue',
          ),
        ).toEqual([]);
      }
      if (recorded.invitationIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.auditLog.findMany({
              where: { entityId: { in: recorded.invitationIds } },
              select: { id: true },
            }),
            'invitation AuditLog residue',
          ),
        ).toEqual([]);
      }
      if (recorded.rawTokens.length > 0) {
        expect(
          narrowIdRows(
            await prisma.rateLimitBucket.findMany({
              where: { dimension: 'TOKEN', bucketKey: { in: recorded.rawTokens.map(sha256Hex) } },
              select: { id: true },
            }),
            'TOKEN RateLimitBucket residue',
          ),
        ).toEqual([]);
      }
      const disposableUsers = [...recorded.staffUserIds, ...recorded.activatedUserIds];
      if (disposableUsers.length > 0) {
        expect(
          narrowIdRows(
            await prisma.user.findMany({
              where: { id: { in: disposableUsers } },
              select: { id: true },
            }),
            'staff/activated User residue',
          ),
        ).toEqual([]);
        expect(
          narrowIdRows(
            await prisma.auditLog.findMany({
              where: { actorId: { in: recorded.staffUserIds } },
              select: { id: true },
            }),
            'staff AuditLog residue',
          ),
        ).toEqual([]);
      }
    } catch (cleanupError) {
      const className =
        cleanupError instanceof Error ? cleanupError.constructor.name : typeof cleanupError;
      const wrapped = new Error(
        `client-payments.spec.ts cleanup failed (${className}). Manual remediation may be required for: ${JSON.stringify(
          { ...recorded, rawTokens: `[${recorded.rawTokens.length} redacted]` },
        )}.`,
      );
      if (!primaryError) primaryError = wrapped;
      else console.error(`[client-payments-e2e] cleanup also failed (${className}).`);
    } finally {
      await prisma.$disconnect();
    }
  }

  if (primaryError) throw primaryError;
});

// After the test body and the tcAccount fixture's cleanupTestChain have both
// run, verify the fixture-owned chain and this spec's payment rows are gone.
// Read-only: performs no deletion of its own.
test.afterAll(async () => {
  const prisma = createE2EPrismaRpcClient();
  try {
    const emptyId = async (label: string, run: () => Promise<unknown>, skip: boolean) => {
      if (skip) return;
      expect(narrowIdRows(await run(), label)).toEqual([]);
    };
    const bookings = { in: recorded.bookingIds };
    const noBookings = recorded.bookingIds.length === 0;
    await emptyId(
      'Lead residue',
      () => prisma.lead.findMany({ where: { id: { in: recorded.leadIds } }, select: { id: true } }),
      recorded.leadIds.length === 0,
    );
    await emptyId(
      'Client residue',
      () =>
        prisma.client.findMany({ where: { id: { in: recorded.clientIds } }, select: { id: true } }),
      recorded.clientIds.length === 0,
    );
    await emptyId(
      'Proposal residue',
      () =>
        prisma.proposal.findMany({
          where: { id: { in: recorded.proposalIds } },
          select: { id: true },
        }),
      recorded.proposalIds.length === 0,
    );
    await emptyId(
      'Booking residue',
      () => prisma.booking.findMany({ where: { id: bookings }, select: { id: true } }),
      noBookings,
    );
    await emptyId(
      'PaymentPlan residue',
      () => prisma.paymentPlan.findMany({ where: { bookingId: bookings }, select: { id: true } }),
      noBookings,
    );
    await emptyId(
      'Payment residue',
      () => prisma.payment.findMany({ where: { bookingId: bookings }, select: { id: true } }),
      noBookings,
    );
    const disposableUserIds = [
      ...(recorded.tcUserId ? [recorded.tcUserId] : []),
      ...recorded.staffUserIds,
      ...recorded.activatedUserIds,
    ];
    await emptyId(
      'User (fixture + staff + activated) residue',
      () =>
        prisma.user.findMany({ where: { id: { in: disposableUserIds } }, select: { id: true } }),
      disposableUserIds.length === 0,
    );
    if (recorded.tcUserId) {
      await emptyId(
        'AuditLog (fixture actor) residue',
        () =>
          prisma.auditLog.findMany({ where: { actorId: recorded.tcUserId }, select: { id: true } }),
        false,
      );
    }
  } catch (error) {
    const className = error instanceof Error ? error.constructor.name : typeof error;
    throw new Error(
      `client-payments.spec.ts afterAll residue verification failed (${className}). Recorded ids: ${JSON.stringify(
        { ...recorded, rawTokens: `[${recorded.rawTokens.length} redacted]` },
      )}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
});
