import { createHash, randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';
import { generateRandomString } from 'better-auth/crypto';

import { e2eIdentityHeaders, newIdentifiedContext } from './support/browser-identity';
import { expect, test } from './support/fixtures';
import { createE2EPrismaRpcClient } from './support/test-database';

// D-051 §13 (Stage 5B) — the real-Chromium, real isolated `heritage_v3_test`
// database, real admin surfaces, real activation flow, real signed-in
// CLIENT sessions E2E for the Conversations feature
// (`/client/support`/`/admin/conversations`). Nothing below is mocked: no
// auth, session, component, route, service, repository, or persistence stub
// anywhere. Mirrors client-overview.spec.ts's / client-proposal-review.
// spec.ts's / client-bookings.spec.ts's established conventions exactly (one
// real TC fixture; RPC results runtime-narrowed before field access;
// sanitized cleanup/failure reporting; canary assertions as boolean
// predicates against EXACT captured strings, never a UUID regex).
//
// The RPC bridge (test-database.ts) accepts only read (`findMany`) and
// `deleteMany` for `conversation`/`conversationParticipant`/`message` — no
// `create`/`update`/`upsert` exists for any of them (D-051 §13 Stage 5B).
// Every Conversation, ConversationParticipant, and Message this spec
// exercises is therefore created the only way the accepted contract allows:
// through the real browser UI and the real, unmodified conversations
// service (createConversationAsClient/createConversationAsStaff/
// replyAsClient/replyAsStaff), never a bridge shortcut.
//
// Token-bearing throughout (the activation flow handles a raw invitation
// token) — like activation.spec.ts/client-overview.spec.ts, trace,
// screenshot, and video are disabled at file scope, stricter than
// playwright.config.ts's inherited defaults.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// D-051 Stage 5B: deterministic, documentation-only client identities so
// this spec's sign-ins (the fixture TC on the default context here, and each
// of the four client sign-in contexts below) are not all counted in one
// shared Better Auth rate-limit bucket with every other spec's sign-ins (see
// e2e/support/browser-identity.ts). Index 0 = this default context. The
// unauthenticated and activation-only contexts never sign in, so they need
// no identity.
test.use({ extraHTTPHeaders: e2eIdentityHeaders('client-support', 0) });

// D-046: zero-retry, stop-on-first-attempt-failure. No
// `test.describe.configure({ retries })` override — the config default
// (`retries: 0`) stands, and the first attempt is the only attempt.

const SLOW = { timeout: 45_000 } as const;

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

function compact(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Waits for a locator that only appears after a client-side RSC
 * `router.refresh()` resolves; reloads and retries if a refresh stalls
 * under the isolated server's small connection pool. Duplicated from
 * client-overview.spec.ts's / client-proposal-review.spec.ts's / client-
 * bookings.spec.ts's identical, already-reviewed helper (per-file-copy
 * convention).
 */
async function expectAfterRefresh(
  page: Page,
  makeLocator: () => ReturnType<Page['locator']>,
  description: string,
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await expect(makeLocator(), description).toBeVisible({
        timeout: attempt < attempts ? 20_000 : 45_000,
      });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await page.reload({ waitUntil: 'commit', timeout: 45_000 });
      await page.waitForTimeout(2500);
    }
  }
}

/**
 * D-040 §8 "inline Flight/RSC payload inspection" — concatenate every inline
 * `self.__next_f.push(...)` script body; fall back to the whole HTML if none
 * are found so the isolation assertions can never be silently skipped.
 * Duplicated from the existing client-*.spec.ts files' identical helper.
 */
function extractInlineFlight(html: string): string {
  const matches = html.match(/self\.__next_f\.push\((?:[\s\S]*?)\)<\/script>/g);
  return matches && matches.length > 0 ? matches.join('\n') : html;
}

/**
 * D-051 §13 (Stage 5B, item G) — every rendered surface a plaintext
 * identifier could leak through on a given page: the raw HTML, the inline
 * Flight payload, the visible text, and — separately, via a live DOM
 * evaluation rather than the static HTML source — every input/textarea/
 * select's current value, every anchor href, every form action, and every
 * `data-*` attribute value on the page. Combined into one string so a
 * single `assertAbsent` call proves absence across every surface at once.
 */
async function collectDomSurfaces(pageObject: Page): Promise<string> {
  const html = await pageObject.content();
  const flight = extractInlineFlight(html);
  const visibleText = await pageObject.locator('body').innerText();
  const liveAttributeValues = await pageObject.evaluate(() => {
    const parts: string[] = [];
    document.querySelectorAll('input, textarea, select').forEach((element) => {
      const value = (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
      if (value) parts.push(value);
    });
    document.querySelectorAll('a[href]').forEach((element) => {
      const href = element.getAttribute('href');
      if (href) parts.push(href);
    });
    document.querySelectorAll('form[action]').forEach((element) => {
      const action = element.getAttribute('action');
      if (action) parts.push(action);
    });
    document.querySelectorAll('*').forEach((element) => {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.startsWith('data-')) parts.push(attribute.value);
      }
    });
    return parts.join('\n');
  });
  return [html, flight, visibleText, liveAttributeValues, pageObject.url()].join('\n');
}

function assertAbsent(surfaces: string[], values: string[], context: string): void {
  for (const surface of surfaces) {
    for (const value of values) {
      expect(surface.includes(value), `${context}: "${value}" must be absent`).toBe(false);
    }
  }
}

// --- RPC-result runtime narrowing (JSON transport does not preserve real
// Prisma return semantics — every result is validated before field access;
// Stage 2 Correction Pass 2's discipline). ---
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function narrowIdOnly(value: unknown, context: string): { id: string } {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error(`${context}: malformed { id } row.`);
  }
  return { id: value.id };
}
function narrowClientProfileIdUser(value: unknown): { id: string; userId: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.userId !== 'string') {
    throw new Error('Malformed ClientProfile { id, userId } row.');
  }
  return { id: value.id, userId: value.userId };
}
function narrowIdRows(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context}: expected an array of id rows.`);
  return value.map((row, i) => narrowIdOnly(row, `${context}[${i}]`).id);
}

// --- Module-scoped recorded ids for the test.afterAll fixture-chain residue
// verification (mirrors every existing client-*.spec.ts file's identical
// pattern). ---
type Recorded = {
  tcUserId?: string;
  leadIds: string[];
  clientIds: string[];
  activatedUserIds: string[];
  profileIds: string[];
  invitationIds: string[];
  rawTokens: string[];
  conversationIds: string[];
};
const recorded: Recorded = {
  leadIds: [],
  clientIds: [],
  activatedUserIds: [],
  profileIds: [],
  invitationIds: [],
  rawTokens: [],
  conversationIds: [],
};

type ProvisionedClient = {
  label: 'A' | 'B';
  nameCanary: string;
  email: string;
  clientPassword: string;
  leadId: string;
  clientId: string;
  manualUrl: string;
  rawToken: string;
  activatedUserId?: string;
  profileId?: string;
  invitationId?: string;
};

test('D-051 §13: a real CLIENT creates a Conversation, receives a staff reply after a real admin-side CLIENT_VISIBLE/INTERNAL_NOTE exchange, replies again, and a second client never sees any of it — with isolation, non-addressability, unauthenticated-redirect, and exact-identifier-containment guarantees', async ({
  tcAccount,
  browser,
  page,
  request,
}) => {
  test.setTimeout(900_000);
  const prisma = createE2EPrismaRpcClient();
  recorded.tcUserId = tcAccount.userId;
  let primaryError: unknown;
  // Hoisted above the outer try/catch/finally so the finally block's own
  // defense-in-depth conversation-discovery fallback can see them
  // regardless of where the test later fails (D-051 Stage 5B correction).
  let clientAClientId: string | undefined;
  let clientBClientId: string | undefined;

  // Unique, run-specific exact canary values (D-051 §13 Stage 5B) — every
  // isolation/containment assertion below is a boolean predicate against
  // one of these exact strings, never a UUID-shape or generic-pattern
  // match.
  const openingCanary = `E2E-CS-OPEN-${randomUUID()}`;
  const staffVisibleCanary = `E2E-CS-STAFF-VISIBLE-${randomUUID()}`;
  const staffInternalNoteCanary = `E2E-CS-STAFF-INTERNAL-${randomUUID()}`;
  const followUpCanary = `E2E-CS-FOLLOWUP-A-${randomUUID()}`;

  async function provisionClient(label: 'A' | 'B'): Promise<ProvisionedClient> {
    const nameCanary = `E2E CS ${label} ${randomUUID()}`;
    const email = `e2e-cs-${label.toLowerCase()}-${randomUUID()}@example.test`;
    const clientPassword = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');

    // A. Provisioning — the established Lead -> Convert -> Client path.
    // Conversations have no Proposal/Booking dependency, so this spec never
    // seeds either — a deliberately lighter provisioning chain than the
    // other client-*.spec.ts files, per D-051's own scope.
    await page.goto('/admin/leads/new');
    await page.getByLabel('Full name').fill(nameCanary);
    await page.getByLabel('Source').fill('E2E client-support journey');
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

    // Converting as the fixture TC auto-assigns them as this Client's
    // active Travel Consultant (D-051 §3/§5) — preserved, never altered,
    // for the rest of this spec.
    await expectAfterRefresh(
      page,
      () => page.getByRole('heading', { name: 'Convert to Client' }),
      `Convert to Client panel after NEW -> QUALIFIED (${label})`,
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

    await page.getByRole('link', { name: 'Clients', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/admin/clients');
    await expectAfterRefresh(
      page,
      () => page.getByLabel('Search'),
      'Clients list Search field after navigating from the Clients nav link',
    );
    await page.getByLabel('Search').fill(nameCanary);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.locator('a:visible', { hasText: nameCanary }).click();
    await page.waitForURL((url) => /^\/admin\/clients\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const clientId = extractTrailingId(page.url());
    recorded.clientIds.push(clientId);
    await expect(page.getByRole('heading', { name: nameCanary })).toBeVisible(SLOW);

    // Invitation: Prepare -> Send -> capture the one-time link -> Confirm.
    await page.getByRole('button', { name: 'Prepare Invitation' }).click();
    await expect(page.getByText('Invitation prepared.')).toBeVisible(SLOW);
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(page.getByText('Invitation sent.')).toBeVisible(SLOW);
    const manualUrl = await page.getByLabel('One-time invitation link').inputValue();
    const hashMatch = /#token=([A-Za-z0-9_-]{24})$/.exec(manualUrl);
    const rawToken = hashMatch?.[1];
    if (!rawToken) {
      throw new Error(`Could not extract the invitation token from the manual link (${label}).`);
    }
    await page.getByRole('button', { name: 'Confirm Manual Sent' }).click();
    await expect(page.getByText('Manual send confirmed.')).toBeVisible(SLOW);

    return { label, nameCanary, email, clientPassword, leadId, clientId, manualUrl, rawToken };
  }

  async function activateClient(client: ProvisionedClient): Promise<void> {
    const context = await browser.newContext();
    try {
      const activationPage = await context.newPage();
      await activationPage.goto(client.manualUrl);
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
  }

  async function recoverActivationIds(
    clientId: string,
  ): Promise<{ activatedUserId: string; profileId: string; invitationId: string }> {
    const profile = narrowClientProfileIdUser(
      await prisma.clientProfile.findUniqueOrThrow({
        where: { clientId },
        select: { id: true, userId: true },
      }),
    );
    const invitation = narrowIdOnly(
      await prisma.portalInvitation.findUniqueOrThrow({
        where: { clientId },
        select: { id: true },
      }),
      'PortalInvitation',
    );
    return { activatedUserId: profile.userId, profileId: profile.id, invitationId: invitation.id };
  }

  async function signInAsClient(pageObject: Page, email: string, password: string): Promise<void> {
    let signedIn = false;
    for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
      try {
        await pageObject.goto('/login', { waitUntil: 'commit', timeout: 45_000 });
        await pageObject.getByLabel('Email').fill(email);
        await pageObject.getByLabel('Password').fill(password);
        await pageObject.getByRole('button', { name: 'Sign in' }).click();
        await pageObject.waitForURL((url) => url.pathname === '/client', {
          timeout: 30_000,
          waitUntil: 'commit',
        });
        signedIn = true;
      } catch {
        await pageObject.waitForTimeout(3000);
      }
    }
    expect(signedIn, 'client sign-in reached /client').toBe(true);
  }

  try {
    // 1. Real TRAVEL_CONSULTANT login (once).
    await page.goto('/login');
    await page.getByLabel('Email').fill(tcAccount.email);
    await page.getByLabel('Password').fill(tcAccount.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 45_000 });

    // 2. Provision Client A (will create + receive replies) and Client B
    //    (isolation control — never given a Conversation of her own).
    const provisionedA = await provisionClient('A');
    clientAClientId = provisionedA.clientId;
    await page.waitForTimeout(1500);
    const provisionedB = await provisionClient('B');
    clientBClientId = provisionedB.clientId;

    // 3. Activate both accounts.
    await activateClient(provisionedA);
    await page.waitForTimeout(2000);
    await activateClient(provisionedB);
    await page.waitForTimeout(2000);

    const idsA = await recoverActivationIds(provisionedA.clientId);
    const idsB = await recoverActivationIds(provisionedB.clientId);
    const clientA: ProvisionedClient = { ...provisionedA, ...idsA };
    const clientB: ProvisionedClient = { ...provisionedB, ...idsB };
    recorded.activatedUserIds.push(clientA.activatedUserId!, clientB.activatedUserId!);
    recorded.profileIds.push(clientA.profileId!, clientB.profileId!);
    recorded.invitationIds.push(clientA.invitationId!, clientB.invitationId!);
    recorded.rawTokens.push(clientA.rawToken, clientB.rawToken);

    // 4. Unauthenticated `/client/support` redirects (3xx) to `/login`.
    const anonApi = await request.get('/client/support', { maxRedirects: 0 });
    expect(
      anonApi.status(),
      'unauthenticated GET /client/support must be a 3xx',
    ).toBeGreaterThanOrEqual(300);
    expect(anonApi.status()).toBeLessThan(400);
    expect((anonApi.headers()['location'] ?? '').endsWith('/login')).toBe(true);

    // F. A real, fresh unauthenticated browser context confirms the same
    //    redirect and leaks nothing (there is no A/B content yet at this
    //    point, but this is the harness's real-browser proof, distinct from
    //    the API-level check above).
    const anonContext = await browser.newContext();
    try {
      const anonPage = await anonContext.newPage();
      await anonPage.goto('/client/support', { waitUntil: 'commit', timeout: 60_000 });
      await anonPage.waitForURL((url) => url.pathname === '/login', { timeout: 45_000 });
      const anonHtml = await anonPage.content();
      assertAbsent(
        [anonHtml],
        [clientA.nameCanary, clientB.nameCanary],
        'unauthenticated /client/support redirect page',
      );
    } finally {
      await anonContext.close();
    }

    // 5. B. Client A creation — sign in, navigate via the real nav link,
    //    create a Conversation through the real UI.
    const contextA = await newIdentifiedContext(browser, 'client-support', 1);
    let conversationARow: { id: string } | undefined;
    try {
      const a = await contextA.newPage();
      await signInAsClient(a, clientA.email, clientA.clientPassword);

      const portalNavA = a.getByRole('navigation', { name: 'Client portal' });
      await portalNavA.getByRole('link', { name: 'Support & Messages' }).click();
      await a.waitForURL((url) => url.pathname === '/client/support', SLOW);
      await expect(a.getByRole('heading', { level: 1, name: 'Support & Messages' })).toBeVisible(
        SLOW,
      );

      const createForm = a.getByRole('form', { name: 'Start a new conversation' });
      await createForm.getByLabel('Category').selectOption({ label: 'General Inquiry' });
      await createForm.getByLabel('Message').fill(openingCanary);
      await createForm.getByRole('button', { name: 'Start conversation' }).click();

      // Server-owned completion signals only (D-051 Stage 5B correction).
      // A controlled <textarea> keeps its typed text as real text content
      // (React syncs `defaultValue`), so a page-wide `getByText(openingCanary)`
      // is satisfied by the create form itself before the Server Action has
      // returned — never by the rendered thread. The gates below cannot be:
      // (1) the action's own role="status" result, which exists only after
      // createConversationAsClient has returned (row committed); (2) the
      // conversation <article>, rendered from the server payload; (3) the
      // canary inside that article's message list item. The create form is
      // a sibling outside the <article>, so it cannot satisfy (2) or (3).
      // The status is matched by role, scoped to the create form, and its
      // text is asserted separately: a live-region `status` has no
      // accessible name of its own (Playwright derives names from content
      // only for button/heading/link/etc.), so `getByRole('status', { name })`
      // can never match — the established pattern across this suite is
      // `getByRole('status')` plus `toContainText`.
      await expect(createForm.getByRole('status')).toContainText('Conversation started.', SLOW);
      const conversationCardA = a.getByRole('article');
      await expect(conversationCardA).toHaveCount(1);
      await expect(
        conversationCardA.locator('li').filter({ hasText: openingCanary }),
      ).toBeVisible();

      // Resolve and record the UI-created Conversation.id immediately —
      // failure-safe cleanup (D-051 Stage 5B correction): every later
      // step's cleanup/residue proof now depends on this id being tracked
      // as soon as the real row is confirmed to exist, never deferred to a
      // later "happy path" section that a failure elsewhere could skip.
      // The single read below is deterministic, not a retry: the gates
      // above only pass after the write has committed.
      const earlyConversationRows = narrowIdRows(
        await prisma.conversation.findMany({
          where: { clientId: clientA.clientId },
          select: { id: true },
        }),
        'Conversation(A, early recovery)',
      );
      expect(earlyConversationRows).toHaveLength(1);
      conversationARow = { id: earlyConversationRows[0]! };
      recorded.conversationIds.push(conversationARow.id);

      await expect(
        conversationCardA.getByRole('heading', { level: 2, name: 'General Inquiry' }),
      ).toBeVisible();
      await expect(conversationCardA.getByText('You', { exact: true })).toBeVisible();

      // Form succeeds and resets as designed — the category/body controls
      // return to their empty starting values, and the form remains usable
      // (never permanently replaced) for a second conversation.
      await expect(createForm.getByLabel('Category')).toHaveValue('');
      await expect(createForm.getByLabel('Message')).toHaveValue('');
    } finally {
      await contextA.close();
    }

    // 6. C. Authorized staff workflow — the fixture TC is already
    //    signed in (from provisioning); navigate to /admin/conversations
    //    through the real admin nav link and reply twice.
    await page.getByRole('link', { name: 'Conversations' }).click();
    await page.waitForURL((url) => url.pathname === '/admin/conversations', SLOW);
    await expect(page.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible(SLOW);

    const conversationCardTC = page.locator('article').filter({ hasText: clientA.nameCanary });
    await expect(conversationCardTC).toHaveCount(1);

    // Every message-canary check below is scoped to a message list item —
    // never the whole card — because the card also contains the reply
    // form's controlled <textarea>, whose typed text is real text content
    // and would satisfy a card-wide `getByText` before the server renders
    // anything (D-051 Stage 5B correction).
    const openingItemTC = conversationCardTC.locator('li').filter({ hasText: openingCanary });
    const clientVisibleItem = conversationCardTC
      .locator('li')
      .filter({ hasText: staffVisibleCanary });
    const internalNoteItem = conversationCardTC
      .locator('li')
      .filter({ hasText: staffInternalNoteCanary });
    await expect(openingItemTC).toBeVisible();

    const staffReplyForm = conversationCardTC.getByRole('form', { name: 'Reply' });
    await staffReplyForm.getByLabel('Message').fill(staffVisibleCanary);
    await staffReplyForm.getByRole('radio', { name: 'Client-visible' }).check();
    await staffReplyForm.getByRole('button', { name: 'Send reply' }).click();
    await expectAfterRefresh(
      page,
      () => clientVisibleItem,
      'staff CLIENT_VISIBLE reply appears after revalidation',
    );

    // The first reply's own observable completion state (D-051 Stage 5B
    // correction) — never a sleep, an arbitrary wait, or a repeated-input
    // loop: the action's own success status, pending cleared, the submit
    // button's text reverted, and the controlled fields genuinely reset.
    // Every check below is a single Playwright locator assertion (its own
    // built-in auto-retry), not a manual loop. Pending is confirmed cleared
    // first so exactly one role="status" element (the success message)
    // remains when its text is asserted; the status is matched by role,
    // scoped to this conversation card, with its text asserted separately.
    await expect(conversationCardTC.getByText('Sending…')).toHaveCount(0);
    await expect(conversationCardTC.getByRole('status')).toContainText('Reply sent.', SLOW);
    const resetReplyForm = conversationCardTC.getByRole('form', { name: 'Reply' });
    await expect(resetReplyForm.getByRole('button', { name: 'Send reply' })).toBeVisible();
    await expect(resetReplyForm.getByLabel('Message')).toHaveValue('');
    await expect(resetReplyForm.getByRole('radio', { name: 'Client-visible' })).not.toBeChecked();
    await expect(resetReplyForm.getByRole('radio', { name: 'Internal note' })).not.toBeChecked();
    await expect(resetReplyForm.getByRole('button', { name: 'Send reply' })).toBeDisabled();

    // Reacquire the Client A conversation card and reply-form locators
    // after those assertions (D-051 Stage 5B correction).
    const staffReplyFormAgain = conversationCardTC.getByRole('form', { name: 'Reply' });
    await staffReplyFormAgain.getByLabel('Message').fill(staffInternalNoteCanary);
    await staffReplyFormAgain.getByRole('radio', { name: 'Internal note' }).check();
    await expect(staffReplyFormAgain.getByLabel('Message')).toHaveValue(staffInternalNoteCanary);
    await expect(staffReplyFormAgain.getByRole('radio', { name: 'Internal note' })).toBeChecked();
    await expect(
      staffReplyFormAgain.getByRole('radio', { name: 'Client-visible' }),
    ).not.toBeChecked();
    const secondReplySubmit = staffReplyFormAgain.getByRole('button', { name: 'Send reply' });
    await expect(secondReplySubmit).toBeEnabled();
    await secondReplySubmit.click();
    await expectAfterRefresh(
      page,
      () => internalNoteItem,
      'staff INTERNAL_NOTE reply appears after revalidation',
    );

    // The second submission's own observable completion state, following
    // the first-reply pattern above (D-051 Stage 5B correction). Note that
    // this form keeps `{ status: 'success' }` from the first reply, so the
    // "Reply sent." status alone cannot distinguish the second action's
    // completion; what does is the action-owned reset — the typed body and
    // the Internal-note selection exist only until the second action's own
    // success state clears them — together with pending being cleared. No
    // sleep, polling loop, retry, or timeout change: each line is a single
    // Playwright locator assertion. Pending is confirmed cleared before the
    // status text is asserted, because while the second submission is in
    // flight this card can briefly hold two role="status" elements (the
    // earlier success message and "Sending…"); once pending is gone exactly
    // one remains, so the role-scoped `toContainText` cannot hit a
    // strict-mode violation.
    await expect(conversationCardTC.getByText('Sending…')).toHaveCount(0);
    await expect(conversationCardTC.getByRole('status')).toContainText('Reply sent.', SLOW);
    const resetReplyFormAfterNote = conversationCardTC.getByRole('form', { name: 'Reply' });
    await expect(resetReplyFormAfterNote.getByRole('button', { name: 'Send reply' })).toBeVisible();
    await expect(resetReplyFormAfterNote.getByLabel('Message')).toHaveValue('');
    await expect(
      resetReplyFormAfterNote.getByRole('radio', { name: 'Client-visible' }),
    ).not.toBeChecked();
    await expect(
      resetReplyFormAfterNote.getByRole('radio', { name: 'Internal note' }),
    ).not.toBeChecked();
    await expect(
      resetReplyFormAfterNote.getByRole('button', { name: 'Send reply' }),
    ).toBeDisabled();

    // The staff UI visibly distinguishes both messages (D-051 §8/§16) —
    // never color alone; each message's own visibility badge text.
    await expect(clientVisibleItem.getByText('Client-visible')).toBeVisible();
    await expect(internalNoteItem.getByText('Internal note')).toBeVisible();

    // 7. D. Client visibility and reply — sign back in as Client A, revisit
    //    /client/support through normal browser navigation.
    const contextA2 = await newIdentifiedContext(browser, 'client-support', 2);
    try {
      const a = await contextA2.newPage();
      await signInAsClient(a, clientA.email, clientA.clientPassword);
      await a.goto('/client/support', { waitUntil: 'commit', timeout: 60_000 });
      await a.reload({ waitUntil: 'commit', timeout: 45_000 });

      await expect(
        a.getByRole('article').locator('li').filter({ hasText: staffVisibleCanary }),
      ).toBeVisible(SLOW);

      // The INTERNAL_NOTE exact canary is absent from visible text, page
      // HTML, and the inline Flight payload.
      const htmlAfterStaffReplies = await a.content();
      const flightAfterStaffReplies = extractInlineFlight(htmlAfterStaffReplies);
      const visibleTextAfterStaffReplies = await a.locator('body').innerText();
      assertAbsent(
        [htmlAfterStaffReplies, flightAfterStaffReplies, visibleTextAfterStaffReplies],
        [staffInternalNoteCanary],
        "Client A's /client/support after staff replies",
      );

      const conversationCardA = a.getByRole('article');
      const clientReplyForm = conversationCardA.getByRole('form', { name: 'Reply' });
      await clientReplyForm.getByLabel('Message').fill(followUpCanary);
      await clientReplyForm.getByRole('button', { name: 'Send reply' }).click();
      const followUpItemA = conversationCardA.locator('li').filter({ hasText: followUpCanary });
      await expectAfterRefresh(
        a,
        () => followUpItemA,
        "Client A's follow-up reply appears after revalidation",
      );
      await expect(followUpItemA.getByText('You', { exact: true })).toBeVisible();

      // The follow-up submission's own observable completion state,
      // following the first staff-reply pattern (D-051 Stage 5B
      // correction). This is the first submission on this freshly loaded
      // page, so the action-owned "Reply sent." status is discriminating
      // here. Single locator assertions only — no sleep, polling loop,
      // retry, or timeout change.
      await expect(conversationCardA.getByText('Sending…')).toHaveCount(0);
      await expect(conversationCardA.getByRole('status')).toContainText('Reply sent.', SLOW);
      const resetClientReplyForm = conversationCardA.getByRole('form', { name: 'Reply' });
      await expect(resetClientReplyForm.getByRole('button', { name: 'Send reply' })).toBeVisible();
      await expect(resetClientReplyForm.getByLabel('Message')).toHaveValue('');
      await expect(resetClientReplyForm.getByRole('button', { name: 'Send reply' })).toBeDisabled();
    } finally {
      await contextA2.close();
    }

    // 8. Revisit the admin conversation — the real staff UI sees the
    //    follow-up. (After a full reload no reply form holds typed text;
    //    the check is still scoped to the message list item.)
    await page.reload({ waitUntil: 'commit', timeout: 45_000 });
    await expectAfterRefresh(
      page,
      () => conversationCardTC.locator('li').filter({ hasText: followUpCanary }),
      "staff view sees Client A's follow-up reply after reload",
    );

    // 9. E. Cross-client isolation — Client B, who never created a
    //    Conversation, sees the correct empty state and none of Client A's
    //    content.
    const contextB = await newIdentifiedContext(browser, 'client-support', 3);
    try {
      const b = await contextB.newPage();
      await signInAsClient(b, clientB.email, clientB.clientPassword);

      const portalNavB = b.getByRole('navigation', { name: 'Client portal' });
      await portalNavB.getByRole('link', { name: 'Support & Messages' }).click();
      await b.waitForURL((url) => url.pathname === '/client/support', SLOW);
      await expect(
        b.getByText('No conversations yet. Send a message below to get started.'),
      ).toBeVisible(SLOW);
      await expect(b.getByRole('article')).toHaveCount(0);

      const htmlB = await b.content();
      const flightB = extractInlineFlight(htmlB);
      const visibleTextB = await b.locator('body').innerText();
      assertAbsent(
        [htmlB, flightB, visibleTextB],
        [
          clientA.nameCanary,
          openingCanary,
          staffVisibleCanary,
          staffInternalNoteCanary,
          followUpCanary,
        ],
        "Client B's /client/support vs Client A",
      );

      // Client B cannot address Client A's Conversation through a URL —
      // `/client/support` carries no dynamic segment and no such route
      // exists (D-051 §10/§14). `conversationARow` was already resolved
      // and recorded immediately after creation (Section B) — reused here,
      // never re-queried or re-recorded (D-051 Stage 5B correction).
      const notFoundResponse = await b.goto(`/client/support/${conversationARow!.id}`, {
        waitUntil: 'commit',
        timeout: 60_000,
      });
      expect(
        notFoundResponse?.status(),
        'no per-conversation route exists — this must not resolve to a page',
      ).toBe(404);
      const notFoundHtml = await b.content();
      assertAbsent(
        [notFoundHtml],
        [openingCanary, staffVisibleCanary, staffInternalNoteCanary, followUpCanary],
        "Client B's attempted direct navigation to Client A's Conversation.id",
      );
    } finally {
      await contextB.close();
    }

    // 10. G. Exact identifier containment on Client A's own client-facing
    //     route — resolved via RPC findMany only now that every UI-created
    //     row exists.
    const messageRows = narrowIdRows(
      await prisma.message.findMany({
        where: { conversationId: conversationARow!.id },
        select: { id: true },
      }),
      'Message(A)',
    );
    expect(messageRows).toHaveLength(4); // opening + staff CLIENT_VISIBLE + staff INTERNAL_NOTE + A's follow-up
    const participantRows = narrowIdRows(
      await prisma.conversationParticipant.findMany({
        where: { conversationId: conversationARow!.id },
        select: { id: true },
      }),
      'ConversationParticipant(A)',
    );
    expect(participantRows).toHaveLength(2); // CLIENT + TRAVEL_CONSULTANT

    const forbiddenIdentifiersA = compact([
      conversationARow!.id,
      clientA.clientId,
      clientA.profileId,
      clientA.activatedUserId,
      tcAccount.userId,
      ...messageRows,
      ...participantRows,
    ]);

    const contextA3 = await newIdentifiedContext(browser, 'client-support', 4);
    try {
      const a = await contextA3.newPage();
      await signInAsClient(a, clientA.email, clientA.clientPassword);
      await a.goto('/client/support', { waitUntil: 'commit', timeout: 60_000 });
      await expect(
        a.getByRole('article').locator('li').filter({ hasText: followUpCanary }),
      ).toBeVisible(SLOW);

      const domSurfaces = await collectDomSurfaces(a);
      assertAbsent(
        [domSurfaces],
        forbiddenIdentifiersA,
        "Client A's /client/support — exact plaintext identifier containment (D-051 §13)",
      );
      // Positive control: the owner legitimately sees her own content — it
      // is not prohibited data.
      expect(domSurfaces.includes(followUpCanary), 'positive control: own content is visible').toBe(
        true,
      );
    } finally {
      await contextA3.close();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // --- Spec-owned cleanup — runs BEFORE the tcAccount fixture's own
    // cleanupTestChain (which deletes the Client rows and would fail on
    // ClientProfile/PortalInvitation onDelete: Restrict FKs, or on any
    // still-present Conversation via its own onDelete: Restrict to Client,
    // if they still existed). Message and ConversationParticipant are
    // deleted before Conversation (both onDelete: Restrict to Conversation)
    // — mirroring every onDelete: Restrict-respecting cleanup already
    // established in this codebase's other client-*.spec.ts files.
    // Sanitized: a failure throws only a safe class name + non-secret ids,
    // and never masks an already-set primaryError. ---
    try {
      // Defense-in-depth (D-051 Stage 5B correction): if no conversation id
      // was ever recorded — a failure occurred at or before the exact
      // point Section B normally records it — discover only Conversations
      // tied to the exact, already-known test-owned client ids. Never a
      // broad, prefix, wildcard, or time-based query.
      if (recorded.conversationIds.length === 0) {
        const discoverableClientIds = compact([clientAClientId, clientBClientId]);
        if (discoverableClientIds.length > 0) {
          const discoveredConversationIds = narrowIdRows(
            await prisma.conversation.findMany({
              where: { clientId: { in: discoverableClientIds } },
              select: { id: true },
            }),
            'Conversation (fallback discovery)',
          );
          recorded.conversationIds.push(...discoveredConversationIds);
        }
      }

      if (recorded.conversationIds.length > 0) {
        await prisma.message.deleteMany({
          where: { conversationId: { in: recorded.conversationIds } },
        });
        await prisma.conversationParticipant.deleteMany({
          where: { conversationId: { in: recorded.conversationIds } },
        });
        await prisma.conversation.deleteMany({ where: { id: { in: recorded.conversationIds } } });
      }

      const invitationIds = compact(recorded.invitationIds);
      const profileIds = compact(recorded.profileIds);
      const activatedUserIds = compact(recorded.activatedUserIds);
      const tokenHashes = compact(recorded.rawTokens).map(sha256Hex);

      if (invitationIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { entityId: { in: invitationIds } } });
        await prisma.portalInvitation.deleteMany({ where: { id: { in: invitationIds } } });
      }
      if (profileIds.length > 0) {
        await prisma.clientProfile.deleteMany({ where: { id: { in: profileIds } } });
      }
      if (activatedUserIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { actorId: { in: activatedUserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: activatedUserIds } } });
      }
      if (tokenHashes.length > 0) {
        await prisma.rateLimitBucket.deleteMany({
          where: { dimension: 'TOKEN', bucketKey: { in: tokenHashes } },
        });
      }
      await prisma.rateLimitBucket.deleteMany({
        where: {
          dimension: 'SOURCE',
          bucketKey: 'unknown-source',
          windowStart: currentSourceWindowStart(),
        },
      });

      // In-test residue checks by recorded id (no time predicate).
      if (recorded.conversationIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.message.findMany({
              where: { conversationId: { in: recorded.conversationIds } },
              select: { id: true },
            }),
            'Message residue',
          ),
        ).toEqual([]);
        expect(
          narrowIdRows(
            await prisma.conversationParticipant.findMany({
              where: { conversationId: { in: recorded.conversationIds } },
              select: { id: true },
            }),
            'ConversationParticipant residue',
          ),
        ).toEqual([]);
        expect(
          narrowIdRows(
            await prisma.conversation.findMany({
              where: { id: { in: recorded.conversationIds } },
              select: { id: true },
            }),
            'Conversation residue',
          ),
        ).toEqual([]);
      }
      if (profileIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.clientProfile.findMany({
              where: { id: { in: profileIds } },
              select: { id: true },
            }),
            'ClientProfile residue',
          ),
        ).toEqual([]);
      }
      if (invitationIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.portalInvitation.findMany({
              where: { id: { in: invitationIds } },
              select: { id: true },
            }),
            'PortalInvitation residue',
          ),
        ).toEqual([]);
      }
      if (activatedUserIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.user.findMany({
              where: { id: { in: activatedUserIds } },
              select: { id: true },
            }),
            'activated User residue',
          ),
        ).toEqual([]);
      }
    } catch (cleanupError) {
      const className =
        cleanupError instanceof Error ? cleanupError.constructor.name : typeof cleanupError;
      const safeIds = {
        clientIds: compact(recorded.clientIds),
        conversationIds: recorded.conversationIds,
        invitationIds: compact(recorded.invitationIds),
        activatedUserIds: compact(recorded.activatedUserIds),
      };
      const wrapped = new Error(
        `client-support E2E cleanup failed (${className}). Manual remediation may be required for: ${JSON.stringify(safeIds)}.`,
      );
      if (!primaryError) primaryError = wrapped;
      else console.error(`[client-support-e2e] cleanup also failed (${className}).`);
    } finally {
      await prisma.$disconnect();
    }
  }

  if (primaryError) throw primaryError;
});

// After the test body and the tcAccount fixture's own cleanupTestChain have
// both run, verify the entire fixture-owned chain (Lead/Client/User) is
// genuinely gone, AND re-confirm the spec-owned Conversation/
// ConversationParticipant/Message rows (already deleted in-test above)
// remain absent — defense in depth, mirroring every existing client-*.
// spec.ts file's identical afterAll discipline.
test.afterAll(async () => {
  const prisma = createE2EPrismaRpcClient();
  try {
    const leadIds = compact(recorded.leadIds);
    const clientIds = compact(recorded.clientIds);
    const disposableUserIds = compact([recorded.tcUserId, ...recorded.activatedUserIds]);

    const emptyId = async (
      label: string,
      run: () => Promise<unknown>,
      skip: boolean,
    ): Promise<void> => {
      if (skip) return;
      expect(narrowIdRows(await run(), label)).toEqual([]);
    };

    if (recorded.conversationIds.length > 0) {
      await emptyId(
        'Message residue (afterAll)',
        () =>
          prisma.message.findMany({
            where: { conversationId: { in: recorded.conversationIds } },
            select: { id: true },
          }),
        false,
      );
      await emptyId(
        'ConversationParticipant residue (afterAll)',
        () =>
          prisma.conversationParticipant.findMany({
            where: { conversationId: { in: recorded.conversationIds } },
            select: { id: true },
          }),
        false,
      );
      await emptyId(
        'Conversation residue (afterAll)',
        () =>
          prisma.conversation.findMany({
            where: { id: { in: recorded.conversationIds } },
            select: { id: true },
          }),
        false,
      );
    }

    await emptyId(
      'Lead residue',
      () => prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true } }),
      leadIds.length === 0,
    );
    await emptyId(
      'Client residue',
      () => prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true } }),
      clientIds.length === 0,
    );
    if (recorded.tcUserId) {
      await emptyId(
        'AuditLog (fixture actor) residue',
        () =>
          prisma.auditLog.findMany({
            where: { actorId: recorded.tcUserId },
            select: { id: true },
          }),
        false,
      );
      // The RPC bridge allowlists only `findFirst`/`deleteMany` for
      // `staffAssignment` (test-database.ts) — never `findMany`.
      expect(
        await prisma.staffAssignment.findFirst({
          where: {
            OR: [
              { clientId: { in: clientIds } },
              { assignedStaffId: recorded.tcUserId },
              { assignedByUserId: recorded.tcUserId },
            ],
          },
        }),
        'StaffAssignment residue',
      ).toBeNull();
    }
    await emptyId(
      'User (fixture + activated) residue',
      () =>
        prisma.user.findMany({ where: { id: { in: disposableUserIds } }, select: { id: true } }),
      disposableUserIds.length === 0,
    );
  } catch (error) {
    const className = error instanceof Error ? error.constructor.name : typeof error;
    throw new Error(
      `client-support E2E afterAll residue verification failed (${className}). Recorded ids: ${JSON.stringify(
        {
          leadIds: compact(recorded.leadIds),
          clientIds: compact(recorded.clientIds),
          conversationIds: recorded.conversationIds,
          activatedUserIds: compact(recorded.activatedUserIds),
        },
      )}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
});
