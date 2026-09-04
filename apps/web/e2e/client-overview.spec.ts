import { createHash, randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';
import { generateRandomString, hashPassword } from 'better-auth/crypto';

import { expect, test } from './support/fixtures';
import { createE2EPrismaRpcClient } from './support/test-database';

// D-040 §9/§10/§11 (Stage 6d) — the two-client real-activation browser E2E
// for the Client Home / Overview. Real Chromium, real isolated
// `heritage_v3_test` database, real admin surfaces, real activation flow,
// real signed-in CLIENT sessions. Nothing mocked below: no auth, session,
// component, route, service, repository, or persistence stub anywhere.
// Mirrors lead-to-booking-flow.spec.ts's and activation.spec.ts's
// established conventions exactly (one real TC fixture; RPC results
// runtime-narrowed before any field access; sanitized cleanup/failure
// reporting; token/canary assertions as boolean predicates only).
//
// This spec is token-bearing throughout (its activation flow handles a raw
// invitation token), so — like activation.spec.ts — it disables trace,
// screenshot, and video capture at file top level, stricter than
// playwright.config.ts's inherited defaults. Declared at file scope, never
// inside test.describe (Playwright's runner rejects a project-config
// override placed inside a describe group).
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// One whole-test retry: this spec drives ~40 sequential admin-UI steps
// plus two full portal activations on a single long-lived isolated
// `next start` server, and the admin UI's client-side `router.refresh()`
// steps (status change -> ConvertToClientPanel, publish -> Record Client
// Response, etc.) can transiently stall when that server's small
// connection pool is saturated — the same pre-existing flakiness that has
// broken the unmodified lead-to-booking-flow.spec.ts at its identical
// conversion step under load. Individual refresh-gated waits below already
// self-heal with a page reload; this is the last-resort backstop. Never
// weakens an assertion.
test.describe.configure({ retries: 1 });

/**
 * Waits for a locator that only appears after a client-side RSC
 * `router.refresh()` resolves. If it does not show within the per-attempt
 * budget, reloads the page (forcing a fresh server render) and tries
 * again — a targeted remedy for a stalled refresh, never an arbitrary
 * sleep. The final attempt gets a longer budget and its failure surfaces
 * normally.
 */
async function expectAfterRefresh(
  page: Page,
  makeLocator: () => Locator,
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

// --- Constants mirrored from feature modules (duplicated, not imported:
// the feature modules transitively import @/lib/db / the generated Prisma
// client, which cannot be loaded from Playwright-run code — see
// e2e/support/test-database.ts's own doc comment; activation.spec.ts
// establishes this exact duplication pattern). ---

/** Mirrors features/activation/rate-limit.ts's SOURCE_WINDOW_MS exactly. */
const SOURCE_WINDOW_MS = 15 * 60 * 1000;

/** Mirrors features/invitations/token.ts's hashInvitationToken exactly. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function currentSourceWindowStart(): Date {
  return new Date(Math.floor(Date.now() / SOURCE_WINDOW_MS) * SOURCE_WINDOW_MS);
}

// --- Small shared helpers (mirrored from the two existing specs). ---

function extractTrailingId(url: string): string {
  const match = /\/([0-9a-fA-F-]{36})\/?(?:\?.*)?$/.exec(new URL(url).pathname);
  const id = match?.[1];
  if (!id) {
    throw new Error(`Could not extract a UUID from URL: ${url}`);
  }
  return id;
}

function formatDatetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function compact(values: readonly (string | null | undefined)[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

// Several admin panels only re-render after an RSC `router.refresh()`
// resolves on the isolated production server; under sustained E2E load
// that round-trip can exceed the 15s default `expect` timeout. A longer,
// explicit budget for exactly those refresh-gated assertions (Playwright's
// recommended remedy — never an arbitrary `waitForTimeout`).
const SLOW = { timeout: 45_000 } as const;

// --- RPC-result runtime narrowing (JSON transport does not preserve real
// Prisma return semantics — every result is validated before field
// access; Stage 2 Correction Pass 2's discipline). ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected an object result for ${context}, got ${typeof value}.`);
  }
  return value;
}

function asString(record: Record<string, unknown>, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new Error(`Expected string field "${field}" on ${context}, got ${typeof value}.`);
  }
  return value;
}

/** Narrows an id-only `findMany` result (`select: { id: true }`) to `string[]`. */
function narrowIdRows(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected an array result for ${context}, got ${typeof value}.`);
  }
  return value.map((row, index) => asString(asRecord(row, `${context}[${index}]`), 'id', context));
}

function narrowClientProfileIdUser(value: unknown): { id: string; userId: string } {
  const record = asRecord(value, 'ClientProfile');
  return {
    id: asString(record, 'id', 'ClientProfile'),
    userId: asString(record, 'userId', 'ClientProfile'),
  };
}

function narrowIdOnly(value: unknown, context: string): { id: string } {
  return { id: asString(asRecord(value, context), 'id', context) };
}

function narrowBookingReference(value: unknown): { bookingReference: string } {
  const record = asRecord(value, 'Booking');
  return { bookingReference: asString(record, 'bookingReference', 'Booking') };
}

// --- Header assertions (D-040 §8). ---

/**
 * D-040 §8: the authenticated `/client` response must carry
 * `Cache-Control: private, no-store` — asserted directive-wise
 * (comma-separated, case-insensitive), a dynamically-rendered Next.js
 * response can compose the header from more than one source. Requires
 * `private` and `no-store`; forbids `public`, any `s-maxage`, and any
 * `max-age` with a positive value.
 */
function assertPrivateNoStoreCacheControl(rawHeader: string | undefined, context: string): void {
  expect(rawHeader, `${context}: Cache-Control must be present`).toBeTruthy();
  const directives = (rawHeader ?? '')
    .split(',')
    .map((directive) => directive.trim().toLowerCase());
  expect(directives, `${context}: Cache-Control must include "private"`).toContain('private');
  expect(directives, `${context}: Cache-Control must include "no-store"`).toContain('no-store');
  expect(directives.includes('public'), `${context}: Cache-Control must not include "public"`).toBe(
    false,
  );
  expect(
    directives.some((directive) => directive.startsWith('s-maxage')),
    `${context}: Cache-Control must not include an "s-maxage" directive`,
  ).toBe(false);
  const hasPositiveMaxAge = directives.some((directive) => {
    const match = /^max-age=(\d+)$/.exec(directive);
    return match !== null && Number(match[1]) > 0;
  });
  expect(
    hasPositiveMaxAge,
    `${context}: Cache-Control must not assign max-age a positive value`,
  ).toBe(false);
}

/**
 * D-040 §8: the `/client` response must retain the installed Next.js
 * runtime's framework-managed RSC `Vary` tokens. Read live from the actual
 * header, never hard-coded; a superset is permitted; and no custom `Vary`
 * key is introduced by next.config.ts (this only checks the framework
 * tokens are still there).
 */
const REQUIRED_RSC_VARY_TOKENS = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
] as const;

function assertFrameworkRscVary(rawHeader: string | undefined, context: string): void {
  expect(rawHeader, `${context}: Vary header must be present`).toBeTruthy();
  const tokens = (rawHeader ?? '').split(',').map((token) => token.trim().toLowerCase());
  for (const required of REQUIRED_RSC_VARY_TOKENS) {
    expect(tokens, `${context}: Vary must contain the framework RSC token "${required}"`).toContain(
      required,
    );
  }
}

/**
 * D-040 §8 "inline Flight/RSC payload inspection": concatenate every inline
 * `self.__next_f.push(...)` script body from the response HTML. Falls back
 * to the whole HTML when no such script is found, so the isolation
 * assertions can never be silently skipped by a payload-shape change.
 */
function extractInlineFlight(html: string): string {
  const matches = html.match(/self\.__next_f\.push\((?:[\s\S]*?)\)<\/script>/g);
  if (!matches || matches.length === 0) {
    return html;
  }
  return matches.join('\n');
}

// --- Canonical D-040 copy (verbatim; must match Stage 6c exactly). ---

const COPY = {
  pageHeading: 'Home / Overview',
  forbiddenH1: 'Client area',
  forbiddenBody: 'This area is for Heritage Philippines client accounts.',
  noProfileH1: 'Account setup in progress',
  noProfileBody:
    "Your client account isn't fully set up yet. Please contact your Heritage Philippines travel consultant for help completing your account setup.",
  errorBoundary: 'Something went wrong while loading your overview.',
  errorRetry: 'Try again',
  bookingsEmpty: 'No bookings yet. A booking is created after you accept a proposal.',
  proposalsEmpty: 'No proposals to review yet. Your travel consultant will prepare one for you.',
  progressBookingPending: 'At least one booking is awaiting confirmation by our team.',
  progressProposalInReview: "You're at the proposal-review stage.",
  proposalLineAwaiting1: 'You have 1 proposal waiting for your response.',
} as const;

const NAV_LABELS = [
  'Home / Overview',
  'My Journey',
  'Bookings',
  'Payments & Receipts',
  'Documents',
  'Visa Center',
  'Regional Tours',
  'Support & Messages',
  'Profile',
  'Settings',
] as const;

function supportGuidanceWithConsultant(consultantName: string): string {
  return `Support & Messages is planned for a later phase. Until then, ${consultantName}, your Heritage Philippines travel consultant, is your point of contact.`;
}

// Strings that appear ONLY in a fully composed Client Home / Overview — the
// portal nav, the travel-status / consultant section headings, and a
// section empty-state sentence. None can originate from `client/loading.tsx`
// (whose only text is "Home / Overview" / "Loading") or from either
// `client/layout.tsx` known-state panel, so finding any of them in a
// staff-forbidden or no-profile response would mean the overview really
// rendered.
const OVERVIEW_ONLY_MARKERS = [
  'Client portal',
  'Your travel status',
  'Your travel consultant',
  'No bookings yet. A booking is created after you accept a proposal.',
] as const;

// --- Module-scoped record for the test.afterAll fixture-chain residue
// verification (D-040 §9). Populated during the single test below. ---

type Recorded = {
  tcUserId?: string;
  leadIds: string[];
  clientIds: string[];
  proposalIds: string[];
  versionIds: string[];
  bookingIds: string[];
  activatedUserIds: string[];
  noProfileUserId?: string;
};

const recorded: Recorded = {
  leadIds: [],
  clientIds: [],
  proposalIds: [],
  versionIds: [],
  bookingIds: [],
  activatedUserIds: [],
};

type ProvisionedClient = {
  label: string;
  nameCanary: string;
  email: string;
  notesCanary: string;
  proposalContentMarker: string;
  clientPassword: string;
  leadId: string;
  clientId: string;
  proposalId: string;
  versionId: string;
  bookingId: string | null;
  bookingReference: string | null;
  manualUrl: string;
  rawToken: string;
  activatedUserId: string | null;
  invitationId: string | null;
  profileId: string | null;
};

test('D-040 §9: two activated clients see an isolated, header-hardened Client Home / Overview; staff and no-profile CLIENT see the exact panels (O-1)', async ({
  page,
  browser,
  request,
  tcAccount,
  baseURL,
}) => {
  // The full two-client provision + activation + five browser scenarios +
  // residue verification is well beyond the default 180s per-test budget.
  test.setTimeout(25 * 60 * 1000);

  const prisma = createE2EPrismaRpcClient();
  recorded.tcUserId = tcAccount.userId;

  const consultantName = tcAccount.name;
  const clients: ProvisionedClient[] = [];
  const usedTokens: string[] = [];
  let noProfileUserId: string | null = null;
  let primaryError: unknown;

  /**
   * Drives the real admin surfaces (as the fixture TC) to build one Client:
   * Lead -> QUALIFIED -> Client -> Notes canary -> Proposal + published
   * Version 1, and — for Client A only — an external ACCEPT, a Booking, and
   * the DRAFT -> PENDING_CONFIRMATION transition. Then prepares / sends
   * (manual email) / confirms the portal invitation and returns the
   * captured ids and raw token.
   */
  async function provisionClient(
    label: string,
    withAcceptedBooking: boolean,
  ): Promise<
    Pick<
      ProvisionedClient,
      | 'label'
      | 'nameCanary'
      | 'email'
      | 'notesCanary'
      | 'proposalContentMarker'
      | 'clientPassword'
      | 'leadId'
      | 'clientId'
      | 'proposalId'
      | 'bookingId'
      | 'manualUrl'
      | 'rawToken'
    >
  > {
    const nameCanary = `E2E CO ${label} ${randomUUID()}`;
    const email = `e2e-co-${label.toLowerCase()}-${randomUUID()}@example.test`;
    const source = 'E2E client-overview automated journey';
    const notesCanary = `E2E-CO-NOTES-${label}-${randomUUID()}`;
    const proposalContentMarker = `E2E-CO-PROPOSAL-${label}-${randomUUID()}.`;
    const clientPassword = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');

    // Lead.
    await page.goto('/admin/leads/new');
    await page.getByLabel('Full name').fill(nameCanary);
    await page.getByLabel('Source').fill(source);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Create Lead' }).click();
    await expect(page.getByRole('status')).toContainText(`Lead ${nameCanary} was created.`, SLOW);
    await page.getByRole('link', { name: 'View Lead' }).click();
    await page.waitForURL((url) => /^\/admin\/leads\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const leadId = extractTrailingId(page.url());
    recorded.leadIds.push(leadId);
    // Let the Lead detail page finish hydrating before interacting.
    await expect(page.getByText('Assigned Consultant:')).toBeVisible(SLOW);

    // NEW -> QUALIFIED.
    await page.getByLabel('Change status to').selectOption({ label: 'Qualified' });
    await page.getByRole('button', { name: 'Change Status' }).click();
    await expect(page.getByText('Status updated.')).toBeVisible(SLOW);

    // Convert to a new Client — ConvertToClientPanel renders only once the
    // post-status-change RSC refresh resolves (reload-retry if it stalls).
    await expectAfterRefresh(
      page,
      () => page.getByRole('heading', { name: 'Convert to Client' }),
      'Convert to Client panel after NEW -> QUALIFIED',
    );
    await page.getByLabel('Create a new Client').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(
      page.getByText(`Converted. A new client, "${nameCanary}", was created.`),
    ).toBeVisible(SLOW);

    // Open the Client detail page.
    await page.getByRole('link', { name: 'Clients', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/admin/clients');
    await page.getByLabel('Search').fill(nameCanary);
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.locator('a:visible', { hasText: nameCanary }).click();
    await page.waitForURL((url) => /^\/admin\/clients\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const clientId = extractTrailingId(page.url());
    recorded.clientIds.push(clientId);
    await expect(page.getByRole('heading', { name: nameCanary })).toBeVisible(SLOW);

    // Set the forbidden "Notes" canary through EditClientForm.
    await page.getByLabel('Notes', { exact: true }).fill(notesCanary);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Client updated.')).toBeVisible(SLOW);

    // Create the Proposal + first ProposalVersion with the content marker.
    await page.getByLabel('Proposal content').fill(proposalContentMarker);
    await page.getByRole('button', { name: 'Create Proposal / ROS' }).click();
    await page.waitForURL((url) => /^\/admin\/proposals\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const proposalId = extractTrailingId(page.url());
    recorded.proposalIds.push(proposalId);

    // Publish Version 1 — RecordProposalResponsePanel appears only once the
    // published version is the current client-visible, no-response version.
    await page.getByRole('button', { name: 'Publish Version 1' }).click();
    await expectAfterRefresh(
      page,
      () => page.getByRole('heading', { name: 'Record Client Response' }),
      'Record Client Response panel after publishing Version 1',
    );

    let bookingId: string | null = null;
    if (withAcceptedBooking) {
      // External ACCEPT (blueprint §9.1). CreateBookingButton appears only
      // once this version carries an ACCEPT response.
      await page.getByLabel('Response', { exact: true }).selectOption({ label: 'Accept' });
      await page.getByLabel('Client responded at').fill(formatDatetimeLocal(new Date()));
      await page.getByLabel('Response method').fill('phone');
      await page.getByLabel('Evidence reference').fill(`E2E CO evidence ${randomUUID()}`);
      await page.getByRole('button', { name: 'Record Response for Version 1' }).click();
      await expectAfterRefresh(
        page,
        () => page.getByRole('button', { name: 'Create Booking' }),
        'Create Booking button after recording ACCEPT',
      );

      // Booking, then DRAFT -> PENDING_CONFIRMATION on its own admin page.
      await page.getByRole('button', { name: 'Create Booking' }).click();
      await page.waitForURL((url) => /^\/admin\/bookings\/[0-9a-fA-F-]{36}$/.test(url.pathname));
      bookingId = extractTrailingId(page.url());
      recorded.bookingIds.push(bookingId);
      await expect(page.getByText('Draft')).toBeVisible(SLOW);
      await page.getByLabel('New status').selectOption({ label: 'Pending Confirmation' });
      await page.getByRole('button', { name: 'Update status' }).click();
      await expectAfterRefresh(
        page,
        () => page.locator('dd', { hasText: 'Pending Confirmation' }),
        'Booking status <dd> after DRAFT -> PENDING_CONFIRMATION',
      );
    }

    // Back to the Client detail page for the invitation.
    await page.goto(`/admin/clients/${clientId}`);
    await page.getByRole('button', { name: 'Prepare Invitation' }).click();
    await expect(page.getByText('Invitation prepared.')).toBeVisible(SLOW);
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(page.getByText('Invitation sent.')).toBeVisible(SLOW);

    const manualUrl = await page.getByLabel('One-time invitation link').inputValue();
    const hashMatch = /^#token=([A-Za-z0-9_-]{24})$/.exec(new URL(manualUrl, baseURL).hash);
    const rawToken = hashMatch?.[1];
    if (!rawToken) {
      throw new Error('Could not extract the invitation token from the manual link.');
    }
    usedTokens.push(rawToken);

    await page.getByRole('button', { name: 'Confirm Manual Sent' }).click();
    await expect(page.getByText('Manual send confirmed.')).toBeVisible(SLOW);

    return {
      label,
      nameCanary,
      email,
      notesCanary,
      proposalContentMarker,
      clientPassword,
      leadId,
      clientId,
      proposalId,
      bookingId,
      manualUrl,
      rawToken,
    };
  }

  /** Activates one client through a fresh, unauthenticated browser context. */
  async function activateClient(client: {
    manualUrl: string;
    clientPassword: string;
  }): Promise<void> {
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
      await expect(
        activationPage.getByText('Your account has been activated. Sign in to continue.'),
      ).toBeVisible(SLOW);
    } finally {
      await context.close();
    }
  }

  // Captured early (fresh server) for the late cross-client canary scan.
  let staffClientHtml = '';
  let noProfileClientHtml = '';

  try {
    // 1. Real TRAVEL_CONSULTANT login (once).
    await page.goto('/login');
    await page.getByLabel('Email').fill(tcAccount.email);
    await page.getByLabel('Password').fill(tcAccount.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 45_000 });

    // 2. O-1 (Stage 6c review) — run BOTH known-state browser scenarios now,
    //    against a freshly started isolated server, before the heavy
    //    two-client provisioning loads it. Each is a static layout panel
    //    (Layer 2 in D-040 §2); neither renders `{children}` / page.tsx, so
    //    there is no overview composition and no client data to leak.

    // 2a. An authenticated non-CLIENT (the fixture TC) at /client gets the
    //     exact forbidden panel — NOT client/error.tsx, NOT the no-profile
    //     panel.
    await page.goto('/client');
    await expect(page.locator('main')).toHaveCount(1, SLOW);
    await expect(page.getByRole('heading', { level: 1, name: COPY.forbiddenH1 })).toBeVisible(SLOW);
    await expect(page.getByText(COPY.forbiddenBody, { exact: true })).toBeVisible();
    await expect(page.getByText(COPY.errorBoundary)).toHaveCount(0);
    await expect(page.getByRole('button', { name: COPY.errorRetry })).toHaveCount(0);
    await expect(page.getByText(COPY.noProfileH1)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: COPY.pageHeading })).toHaveCount(0);
    staffClientHtml = await page.content();
    expect(staffClientHtml.includes(COPY.forbiddenBody)).toBe(true);
    expect(
      staffClientHtml.includes(COPY.errorBoundary),
      'staff /client must not fall through to client/error.tsx',
    ).toBe(false);
    // No portal chrome and no overview section ever composed. (The static
    // string "Home / Overview" is deliberately NOT scanned for here: it is
    // the label in `client/loading.tsx`, whose Suspense fallback Next
    // streams for the concurrently-executing — and then FORBIDDEN-throwing
    // — `page.tsx` segment; that fallback markup lingers in the raw
    // response string though it is never in the committed DOM and carries
    // no client data. The markers below appear ONLY in a real composed
    // overview and can never come from `loading.tsx` or a layout panel.)
    for (const marker of OVERVIEW_ONLY_MARKERS) {
      expect(staffClientHtml.includes(marker), `staff panel must not render "${marker}"`).toBe(
        false,
      );
    }
    await page.goto('/admin');

    // 2b. An authenticated CLIENT with no ClientProfile at /client gets the
    //     exact "Account setup in progress" panel — NOT client/error.tsx,
    //     NOT the forbidden panel — and never reveals the missing profile.
    noProfileUserId = randomUUID();
    recorded.noProfileUserId = noProfileUserId;
    const noProfileEmail = `e2e-co-noprofile-${randomUUID()}@example.test`;
    const noProfilePassword = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');
    await prisma.user.create({
      data: {
        id: noProfileUserId,
        name: `E2E CO No-Profile CLIENT ${randomUUID()}`,
        email: noProfileEmail,
        emailVerified: true,
        role: 'CLIENT',
        isActive: true,
        accounts: {
          create: {
            id: randomUUID(),
            accountId: noProfileUserId,
            providerId: 'credential',
            password: await hashPassword(noProfilePassword),
          },
        },
      },
    });
    const noProfileContext = await browser.newContext();
    try {
      const noProfilePage = await noProfileContext.newPage();
      await noProfilePage.goto('/login');
      await noProfilePage.getByLabel('Email').fill(noProfileEmail);
      await noProfilePage.getByLabel('Password').fill(noProfilePassword);
      await noProfilePage.getByRole('button', { name: 'Sign in' }).click();
      // /login -> /dashboard -> (CLIENT) /client -> the no-profile panel.
      // `waitUntil: 'commit'` so a slow `load` cannot mask an arrived URL.
      await noProfilePage.waitForURL((url) => url.pathname === '/client', {
        timeout: 60_000,
        waitUntil: 'commit',
      });
      await expect(noProfilePage.locator('main')).toHaveCount(1, SLOW);
      await expect(
        noProfilePage.getByRole('heading', { level: 1, name: COPY.noProfileH1 }),
      ).toBeVisible(SLOW);
      await expect(noProfilePage.getByText(COPY.noProfileBody, { exact: true })).toBeVisible();
      await expect(noProfilePage.getByText(COPY.errorBoundary)).toHaveCount(0);
      await expect(noProfilePage.getByRole('button', { name: COPY.errorRetry })).toHaveCount(0);
      await expect(noProfilePage.getByText(COPY.forbiddenH1)).toHaveCount(0);
      await expect(
        noProfilePage.getByRole('heading', { level: 1, name: COPY.pageHeading }),
      ).toHaveCount(0);
      noProfileClientHtml = await noProfilePage.content();
      expect(noProfileClientHtml.includes(COPY.noProfileBody)).toBe(true);
      expect(
        noProfileClientHtml.includes(COPY.errorBoundary),
        'no-profile /client must not fall through to client/error.tsx',
      ).toBe(false);
      // Calm and generic — never reveals that no ClientProfile row exists.
      expect(noProfileClientHtml.toLowerCase().includes('clientprofile')).toBe(false);
      // Same rationale as the staff panel above re: the "Home / Overview"
      // loading-fallback label — scan only for genuinely overview-only text.
      for (const marker of OVERVIEW_ONLY_MARKERS) {
        expect(
          noProfileClientHtml.includes(marker),
          `no-profile panel must not render "${marker}"`,
        ).toBe(false);
      }
    } finally {
      await noProfileContext.close();
    }

    // 3. Provision Client A (accepted proposal + PENDING_CONFIRMATION
    //    booking) and Client B (published proposal only, no response).
    const provisionedA = await provisionClient('A', true);
    const provisionedB = await provisionClient('B', false);

    // 3. Capture the remaining internal ids (ProposalVersion id for both;
    //    bookingReference for A) via the narrowly allowlisted RPC surface.
    const [versionsA, versionsB] = await Promise.all([
      prisma.proposalVersion.findMany({
        where: { proposalId: provisionedA.proposalId },
        select: { id: true },
      }),
      prisma.proposalVersion.findMany({
        where: { proposalId: provisionedB.proposalId },
        select: { id: true },
      }),
    ]);
    const versionIdsA = narrowIdRows(versionsA, 'ProposalVersion(A)');
    const versionIdsB = narrowIdRows(versionsB, 'ProposalVersion(B)');
    expect(versionIdsA).toHaveLength(1);
    expect(versionIdsB).toHaveLength(1);
    const versionIdA = versionIdsA[0]!;
    const versionIdB = versionIdsB[0]!;
    recorded.versionIds.push(versionIdA, versionIdB);

    const bookingReferenceA = narrowBookingReference(
      await prisma.booking.findUniqueOrThrow({
        where: { id: provisionedA.bookingId! },
        select: { bookingReference: true },
      }),
    ).bookingReference;

    // 4. Unauthenticated `/client` — the exact base route redirects (3xx) to
    //    `/login` (D-040 §9). `request` is the top-level, cookie-less
    //    fixture context.
    const anonResponse = await request.get('/client', { maxRedirects: 0 });
    expect(
      anonResponse.status(),
      'unauthenticated GET /client must be a 3xx redirect',
    ).toBeGreaterThanOrEqual(300);
    expect(anonResponse.status()).toBeLessThan(400);
    const anonLocation = anonResponse.headers()['location'] ?? '';
    expect(
      anonLocation.endsWith('/login'),
      `redirect location "${anonLocation}" must end "/login"`,
    ).toBe(true);

    // 5. Activate both accounts through fresh unauthenticated contexts.
    await activateClient(provisionedA);
    await page.waitForTimeout(2000);
    await activateClient(provisionedB);
    await page.waitForTimeout(2000);

    // 6. Recover the activated User id, ClientProfile id, and
    //    PortalInvitation id for each (committed activation state).
    async function recoverActivationIds(clientId: string): Promise<{
      activatedUserId: string;
      profileId: string;
      invitationId: string;
    }> {
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
      return {
        activatedUserId: profile.userId,
        profileId: profile.id,
        invitationId: invitation.id,
      };
    }

    const idsA = await recoverActivationIds(provisionedA.clientId);
    const idsB = await recoverActivationIds(provisionedB.clientId);
    recorded.activatedUserIds.push(idsA.activatedUserId, idsB.activatedUserId);

    const clientA: ProvisionedClient = {
      ...provisionedA,
      versionId: versionIdA,
      bookingReference: bookingReferenceA,
      activatedUserId: idsA.activatedUserId,
      invitationId: idsA.invitationId,
      profileId: idsA.profileId,
    };
    const clientB: ProvisionedClient = {
      ...provisionedB,
      versionId: versionIdB,
      bookingReference: null,
      activatedUserId: idsB.activatedUserId,
      invitationId: idsB.invitationId,
      profileId: idsB.profileId,
    };
    clients.push(clientA, clientB);

    // 7. Sign in as each client, verify the `/dashboard` -> `/client` fork,
    //    assert the exact overview, capture the live headers, and capture
    //    the rendered HTML + inline Flight payload for the isolation checks.
    async function signInAndCaptureOverview(client: ProvisionedClient): Promise<{
      html: string;
      flight: string;
    }> {
      const context = await browser.newContext();
      try {
        const clientPage = await context.newPage();

        // Sign in, tolerating a transient stall in the sign-in POST or the
        // /login -> /dashboard -> /client chain when the isolated server's
        // small connection pool is briefly saturated after the two-client
        // provisioning + activation. Each attempt is a genuine end-to-end
        // sign-in; a retry only re-issues it from a clean /login.
        let signedIn = false;
        let lastSignInError: unknown;
        for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
          try {
            await clientPage.goto('/login', { waitUntil: 'commit', timeout: 45_000 });
            await clientPage.getByLabel('Email').fill(client.email);
            await clientPage.getByLabel('Password').fill(client.clientPassword);
            await clientPage.getByRole('button', { name: 'Sign in' }).click();
            // /login pushes /dashboard; /dashboard redirects a CLIENT to /client.
            await clientPage.waitForURL((url) => url.pathname === '/client', {
              timeout: 30_000,
              waitUntil: 'commit',
            });
            signedIn = true;
          } catch (error) {
            lastSignInError = error;
            await clientPage.waitForTimeout(3000);
          }
        }
        if (!signedIn) {
          throw lastSignInError instanceof Error
            ? lastSignInError
            : new Error('Client sign-in did not reach /client after 3 attempts.');
        }

        // Explicit dashboard-role-fork proof, and the response object used
        // for the live header assertions (one render, not a separate fetch).
        const clientResponse = await clientPage.goto('/dashboard', {
          waitUntil: 'commit',
          timeout: 60_000,
        });
        await clientPage.waitForURL((url) => url.pathname === '/client', {
          timeout: 60_000,
          waitUntil: 'commit',
        });

        // Exactly one <main> landmark.
        await expect(clientPage.locator('main')).toHaveCount(1, SLOW);
        await expect(
          clientPage.getByRole('heading', { level: 1, name: COPY.pageHeading }),
        ).toBeVisible(SLOW);

        // Identity — the client's own name + email; phone was never set, so
        // an explicit placeholder, never a fabricated value.
        await expect(clientPage.getByText(client.nameCanary, { exact: true })).toBeVisible();
        await expect(clientPage.getByText(client.email, { exact: true })).toBeVisible();

        // Navigation — ten labels verbatim, Home / Overview current (not a
        // link), the nine later-phase items inert with a visible
        // "Coming soon" and no href.
        const navItems = clientPage
          .getByRole('navigation', { name: 'Client portal' })
          .locator('li');
        await expect(navItems).toHaveCount(10);
        for (let index = 0; index < NAV_LABELS.length; index += 1) {
          await expect(navItems.nth(index)).toContainText(NAV_LABELS[index]!);
        }
        // "Home / Overview" appears twice on the page — the <h1> and the
        // current nav item — so scope this to the nav.
        const current = clientPage
          .getByRole('navigation', { name: 'Client portal' })
          .getByText('Home / Overview', { exact: true });
        await expect(current).toHaveAttribute('aria-current', 'page');
        expect(await current.evaluate((node) => node.tagName)).toBe('SPAN');
        await expect(
          clientPage.getByRole('navigation', { name: 'Client portal' }).getByRole('link'),
        ).toHaveCount(0);
        await expect(navItems.filter({ hasText: 'Coming soon' })).toHaveCount(9);

        // Consultant card + support-guidance line (the converting TC is
        // auto-assigned during Lead -> Client conversion).
        await expect(
          clientPage.getByRole('heading', { level: 2, name: 'Your travel consultant' }),
        ).toBeVisible();
        await expect(clientPage.getByText(consultantName, { exact: true })).toBeVisible();
        await expect(
          clientPage.getByText(supportGuidanceWithConsultant(consultantName), { exact: true }),
        ).toBeVisible();

        if (client.label === 'A') {
          await expect(
            clientPage.getByRole('heading', { level: 2, name: 'Proposals (1)' }),
          ).toBeVisible();
          await expect(clientPage.getByText('Version 1', { exact: true })).toBeVisible();
          await expect(clientPage.getByText('Accepted', { exact: true })).toBeVisible();

          await expect(
            clientPage.getByRole('heading', { level: 2, name: 'Bookings (1)' }),
          ).toBeVisible();
          await expect(
            clientPage.getByText(client.bookingReference!, { exact: true }),
          ).toBeVisible();
          await expect(clientPage.getByText('Pending confirmation', { exact: true })).toBeVisible();

          // Travel status: proposalLine omitted; progressLine
          // BOOKING_PENDING_CONFIRMATION.
          await expect(
            clientPage.getByText(COPY.progressBookingPending, { exact: true }),
          ).toBeVisible();
          await expect(clientPage.getByText(COPY.proposalLineAwaiting1)).toHaveCount(0);
        } else {
          await expect(
            clientPage.getByRole('heading', { level: 2, name: 'Proposals (1)' }),
          ).toBeVisible();
          await expect(clientPage.getByText('Version 1', { exact: true })).toBeVisible();
          await expect(
            clientPage.getByText('Awaiting your response', { exact: true }),
          ).toBeVisible();

          await expect(
            clientPage.getByRole('heading', { level: 2, name: 'Bookings (0)' }),
          ).toBeVisible();
          await expect(clientPage.getByText(COPY.bookingsEmpty, { exact: true })).toBeVisible();

          // Travel status: proposalLine PROPOSALS_AWAITING_YOU (1);
          // progressLine PROPOSAL_IN_REVIEW.
          await expect(
            clientPage.getByText(COPY.proposalLineAwaiting1, { exact: true }),
          ).toBeVisible();
          await expect(
            clientPage.getByText(COPY.progressProposalInReview, { exact: true }),
          ).toBeVisible();
        }

        // Live headers on the authenticated `/client` navigation response
        // (D-040 §8) — `clientResponse` is the final response after the
        // /dashboard -> /client server redirect.
        expect(
          clientResponse,
          'the /dashboard -> /client navigation must yield a response',
        ).not.toBeNull();
        expect(clientResponse!.status()).toBe(200);
        expect(new URL(clientResponse!.url()).pathname).toBe('/client');
        assertPrivateNoStoreCacheControl(
          clientResponse!.headers()['cache-control'],
          'authenticated GET /client',
        );
        expect(clientResponse!.headers()['referrer-policy']).toBe('no-referrer');
        assertFrameworkRscVary(clientResponse!.headers()['vary'], 'authenticated GET /client');

        const html = await clientPage.content();
        return { html, flight: extractInlineFlight(html) };
      } finally {
        await context.close();
      }
    }

    // Brief pauses between load bursts so the isolated server's small
    // connection pool can drain between the activation phase and each
    // signed-in overview render (not an element wait — a deliberate
    // server-recovery gap).
    await page.waitForTimeout(3000);
    const outputA = await signInAndCaptureOverview(clientA);
    await page.waitForTimeout(3000);
    const outputB = await signInAndCaptureOverview(clientB);

    // 8. Two-client HTML + inline Flight/RSC isolation (D-040 §8/§9), as
    //    boolean predicates against exact captured strings — never a UUID
    //    regex.
    const surfacesA = [outputA.html, outputA.flight];
    const surfacesB = [outputB.html, outputB.flight];

    function assertAbsent(surfaces: string[], values: string[], context: string): void {
      for (const surface of surfaces) {
        for (const value of values) {
          expect(surface.includes(value), `${context}: "${value}" must be absent`).toBe(false);
        }
      }
    }
    function assertPresent(surfaces: string[], value: string, context: string): void {
      for (const surface of surfaces) {
        expect(surface.includes(value), `${context}: "${value}" must be present`).toBe(true);
      }
    }

    // Neither client's output carries the other client's canaries or ids.
    assertAbsent(
      surfacesA,
      [
        clientB.nameCanary,
        clientB.email,
        clientB.proposalContentMarker,
        clientB.notesCanary,
        clientB.clientId,
        clientB.activatedUserId!,
        clientB.proposalId,
        clientB.versionId,
        clientB.invitationId!,
        clientB.profileId!,
      ],
      "Client A's output vs Client B",
    );
    assertAbsent(
      surfacesB,
      [
        clientA.nameCanary,
        clientA.email,
        clientA.proposalContentMarker,
        clientA.notesCanary,
        clientA.clientId,
        clientA.activatedUserId!,
        clientA.proposalId,
        clientA.versionId,
        clientA.invitationId!,
        clientA.profileId!,
        clientA.bookingId!,
        clientA.bookingReference!,
      ],
      "Client B's output vs Client A (asymmetric — B has no booking)",
    );

    // Each client's own forbidden fields (proposal content, notes) and own
    // server-only identifiers are absent from its own output (D-040 §8 —
    // the DTO is identifier-minimized; only `bookingReference` may appear).
    assertAbsent(
      surfacesA,
      [
        clientA.proposalContentMarker,
        clientA.notesCanary,
        clientA.clientId,
        clientA.activatedUserId!,
        clientA.proposalId,
        clientA.versionId,
        clientA.invitationId!,
        clientA.profileId!,
        clientA.bookingId!,
      ],
      "Client A's own output — forbidden fields & internal ids",
    );
    assertAbsent(
      surfacesB,
      [
        clientB.proposalContentMarker,
        clientB.notesCanary,
        clientB.clientId,
        clientB.activatedUserId!,
        clientB.proposalId,
        clientB.versionId,
        clientB.invitationId!,
        clientB.profileId!,
      ],
      "Client B's own output — forbidden fields & internal ids",
    );

    // Positive controls: the UUID-bearing name canary IS rendered for each
    // client, and A's client-facing bookingReference IS present in A's own
    // output.
    assertPresent(surfacesA, clientA.nameCanary, "Client A's output (positive control)");
    assertPresent(surfacesB, clientB.nameCanary, "Client B's output (positive control)");
    assertPresent(surfacesA, clientA.bookingReference!, "Client A's output (bookingReference)");

    // 9. O-1 late cross-client canary scan. The staff forbidden panel and
    //    the no-profile panel were both captured against a freshly started
    //    server in step 2 (each a static Layer-2 render with no `{children}`
    //    composition). Now that Client A's and Client B's exact canaries and
    //    internal ids are known, assert neither panel's HTML or inline
    //    Flight payload contains any of them — defense in depth on top of
    //    the structural "no overview sections" checks already made in step 2.
    {
      const aAndBSecrets = [
        clientA.nameCanary,
        clientA.email,
        clientA.notesCanary,
        clientA.proposalContentMarker,
        clientA.bookingReference!,
        clientA.clientId,
        clientA.proposalId,
        clientA.versionId,
        clientA.activatedUserId!,
        clientA.invitationId!,
        clientA.profileId!,
        clientB.nameCanary,
        clientB.email,
        clientB.notesCanary,
        clientB.proposalContentMarker,
        clientB.clientId,
        clientB.proposalId,
        clientB.versionId,
        clientB.activatedUserId!,
        clientB.invitationId!,
        clientB.profileId!,
      ];
      assertAbsent(
        [staffClientHtml, extractInlineFlight(staffClientHtml)],
        aAndBSecrets,
        'O-1 staff forbidden panel — no A/B overview or identifier data',
      );
      assertAbsent(
        [noProfileClientHtml, extractInlineFlight(noProfileClientHtml)],
        aAndBSecrets,
        'O-1 no-profile panel — no A/B overview or identifier data',
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // --- Spec-owned activation-chain cleanup + in-test residue check
    // (D-040 §9). Runs BEFORE the tcAccount fixture's own cleanupTestChain
    // (which deletes the Client rows and would fail on ClientProfile /
    // PortalInvitation's onDelete: Restrict FKs if they still existed).
    // The Lead/Client/Proposal/Version/Acceptance/Booking/history/
    // assignment/TC chain is that fixture's responsibility, not duplicated
    // here. Every id list is compacted with `filter(Boolean)`, and each
    // residue check is skipped when its list is empty. Sanitized: a
    // failure throws only a safe class name + non-secret ids. ---
    try {
      const tokenHashes = usedTokens.map(sha256Hex);
      const clientIds = compact(clients.map((client) => client.clientId));

      // Recover any activation id a mid-test failure left unassigned.
      for (const client of clients) {
        if (!client.activatedUserId || !client.profileId) {
          try {
            const profile = narrowClientProfileIdUser(
              await prisma.clientProfile.findUniqueOrThrow({
                where: { clientId: client.clientId },
                select: { id: true, userId: true },
              }),
            );
            client.activatedUserId ??= profile.userId;
            client.profileId ??= profile.id;
          } catch {
            /* nothing committed for this client — leave undefined */
          }
        }
        if (!client.invitationId) {
          try {
            client.invitationId = narrowIdOnly(
              await prisma.portalInvitation.findUniqueOrThrow({
                where: { clientId: client.clientId },
                select: { id: true },
              }),
              'PortalInvitation',
            ).id;
          } catch {
            /* nothing committed */
          }
        }
      }
      const recoveredProfileIds = compact(clients.map((client) => client.profileId));
      const recoveredInvitationIds = compact(clients.map((client) => client.invitationId));
      const recoveredActivatedUserIds = compact(clients.map((client) => client.activatedUserId));
      const allDisposableUserIds = compact([...recoveredActivatedUserIds, noProfileUserId]);
      const auditOr = [
        ...recoveredInvitationIds.map((id) => ({ entityId: id })),
        ...recoveredActivatedUserIds.map((id) => ({ actorId: id })),
      ];

      // 1. RateLimitBucket rows this run's own real HTTP requests created.
      if (tokenHashes.length > 0) {
        await prisma.rateLimitBucket.deleteMany({
          where: { dimension: 'TOKEN', bucketKey: { in: tokenHashes } },
        });
      }
      // Shared SOURCE bucket: best-effort only, no strict absence assertion.
      await prisma.rateLimitBucket.deleteMany({
        where: {
          dimension: 'SOURCE',
          bucketKey: 'unknown-source',
          windowStart: currentSourceWindowStart(),
        },
      });

      // 2. Activation AuditLog rows (PORTAL_INVITATION_OPENED /
      //    PORTAL_INVITATION_ACTIVATED — not attributed to the TC actor).
      if (auditOr.length > 0) {
        await prisma.auditLog.deleteMany({ where: { OR: auditOr } });
      }

      // 3. ClientProfile before its Client / User (onDelete: Restrict).
      if (clientIds.length > 0) {
        await prisma.clientProfile.deleteMany({ where: { clientId: { in: clientIds } } });
        // 4. PortalInvitation.
        await prisma.portalInvitation.deleteMany({ where: { clientId: { in: clientIds } } });
      }

      // 5. The activated CLIENT users + the synthetic no-profile CLIENT
      //    user (Account cascade-deletes with each).
      if (allDisposableUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: allDisposableUserIds } } });
      }

      // 6. In-test residue check — by recorded id, no time predicate; only
      //    the exact spec-removed artifacts are gone.
      if (recoveredProfileIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.clientProfile.findMany({
              where: { id: { in: recoveredProfileIds } },
              select: { id: true },
            }),
            'ClientProfile residue',
          ),
        ).toEqual([]);
      }
      if (recoveredInvitationIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.portalInvitation.findMany({
              where: { id: { in: recoveredInvitationIds } },
              select: { id: true },
            }),
            'PortalInvitation residue',
          ),
        ).toEqual([]);
      }
      if (allDisposableUserIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.user.findMany({
              where: { id: { in: allDisposableUserIds } },
              select: { id: true },
            }),
            'activated/no-profile User residue',
          ),
        ).toEqual([]);
      }
      if (auditOr.length > 0) {
        expect(
          narrowIdRows(
            await prisma.auditLog.findMany({ where: { OR: auditOr }, select: { id: true } }),
            'activation AuditLog residue',
          ),
        ).toEqual([]);
      }
      if (tokenHashes.length > 0) {
        expect(
          narrowIdRows(
            await prisma.rateLimitBucket.findMany({
              where: { dimension: 'TOKEN', bucketKey: { in: tokenHashes } },
              select: { id: true },
            }),
            'TOKEN RateLimitBucket residue',
          ),
        ).toEqual([]);
      }
    } catch (cleanupError) {
      const className =
        cleanupError instanceof Error ? cleanupError.constructor.name : typeof cleanupError;
      const safeIds = {
        clientIds: compact(clients.map((c) => c.clientId)),
        invitationIds: compact(clients.map((c) => c.invitationId)),
        activatedUserIds: compact(clients.map((c) => c.activatedUserId)),
        noProfileUserId: noProfileUserId ?? '(none)',
      };
      const wrapped = new Error(
        `client-overview E2E activation-chain cleanup failed (${className}). Manual remediation may be required for: ${JSON.stringify(safeIds)}.`,
      );
      if (!primaryError) {
        primaryError = wrapped;
      } else {
        // A real failure is already in flight — report, do not mask.
        console.error(
          `[client-overview-e2e] cleanup also failed after the primary failure (${className}).`,
        );
      }
    } finally {
      await prisma.$disconnect();
    }
  }

  if (primaryError) {
    throw primaryError;
  }
});

// D-040 §9: after the test body and the tcAccount fixture's own
// cleanupTestChain have both run, verify the entire fixture-owned chain is
// gone — its own RPC client, `$disconnect` in `finally`, module-scoped
// recorded ids, `filter(Boolean)` before every `in` filter, each check
// skipped when its id list is empty. No `count` operation is used; the
// `Account` rows are not separately asserted (they cascade on `User`
// deletion, a schema invariant fixtures.ts already relies on).
test.afterAll(async () => {
  const prisma = createE2EPrismaRpcClient();
  try {
    const leadIds = compact(recorded.leadIds);
    const clientIds = compact(recorded.clientIds);
    const proposalIds = compact(recorded.proposalIds);
    const versionIds = compact(recorded.versionIds);
    const bookingIds = compact(recorded.bookingIds);
    const tcUserId = recorded.tcUserId;
    const disposableUserIds = compact([
      tcUserId,
      ...recorded.activatedUserIds,
      recorded.noProfileUserId,
    ]);

    const emptyId = async (
      label: string,
      run: () => Promise<unknown>,
      skip: boolean,
    ): Promise<void> => {
      if (skip) return;
      expect(narrowIdRows(await run(), label)).toEqual([]);
    };

    await emptyId(
      'Lead residue',
      () => prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true } }),
      leadIds.length === 0,
    );
    await emptyId(
      'LeadStatusHistory residue',
      () =>
        prisma.leadStatusHistory.findMany({
          where: { leadId: { in: leadIds } },
          select: { id: true },
        }),
      leadIds.length === 0,
    );
    await emptyId(
      'Client residue',
      () => prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true } }),
      clientIds.length === 0,
    );
    await emptyId(
      'Proposal residue',
      () => prisma.proposal.findMany({ where: { id: { in: proposalIds } }, select: { id: true } }),
      proposalIds.length === 0,
    );
    await emptyId(
      'ProposalVersion residue',
      () =>
        prisma.proposalVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true },
        }),
      versionIds.length === 0,
    );
    await emptyId(
      'ProposalAcceptance residue',
      () =>
        prisma.proposalAcceptance.findMany({
          where: { proposalVersionId: { in: versionIds } },
          select: { id: true },
        }),
      versionIds.length === 0,
    );
    await emptyId(
      'Booking residue',
      () => prisma.booking.findMany({ where: { id: { in: bookingIds } }, select: { id: true } }),
      bookingIds.length === 0,
    );
    await emptyId(
      'BookingStatusHistory residue',
      () =>
        prisma.bookingStatusHistory.findMany({
          where: { bookingId: { in: bookingIds } },
          select: { id: true },
        }),
      bookingIds.length === 0,
    );
    if (tcUserId) {
      expect(
        await prisma.staffAssignment.findFirst({
          where: {
            OR: [
              { leadId: { in: leadIds } },
              { clientId: { in: clientIds } },
              { assignedStaffId: tcUserId },
              { assignedByUserId: tcUserId },
            ],
          },
        }),
      ).toBeNull();
      await emptyId(
        'AuditLog (fixture actor) residue',
        () => prisma.auditLog.findMany({ where: { actorId: tcUserId }, select: { id: true } }),
        false,
      );
    }
    await emptyId(
      'User (fixture + activated + no-profile) residue',
      () =>
        prisma.user.findMany({ where: { id: { in: disposableUserIds } }, select: { id: true } }),
      disposableUserIds.length === 0,
    );
  } catch (error) {
    const className = error instanceof Error ? error.constructor.name : typeof error;
    throw new Error(
      `client-overview E2E afterAll residue verification failed (${className}). Recorded ids: ${JSON.stringify(
        {
          leadIds: compact(recorded.leadIds),
          clientIds: compact(recorded.clientIds),
          proposalIds: compact(recorded.proposalIds),
          versionIds: compact(recorded.versionIds),
          bookingIds: compact(recorded.bookingIds),
          activatedUserIds: compact(recorded.activatedUserIds),
          noProfileUserId: recorded.noProfileUserId ?? '(none)',
        },
      )}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
});
