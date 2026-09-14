import { createHash, randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';
import { generateRandomString } from 'better-auth/crypto';

import { expect, test } from './support/fixtures';
import { createE2EPrismaRpcClient } from './support/test-database';

// D-049 §8 (Stage 4) — the real-Chromium, real isolated `heritage_v3_test`
// database, real admin surfaces, real activation flow, real signed-in
// CLIENT session E2E for the client Bookings list/detail slice
// (`/client/bookings`). Nothing below is mocked: no auth, session,
// component, route, service, repository, or persistence stub anywhere.
// Mirrors client-proposal-review.spec.ts's / client-overview.spec.ts's /
// lead-to-booking-flow.spec.ts's established conventions exactly (one real
// TC fixture; the real Lead -> Convert -> Proposal -> publish -> externally
// recorded Accept -> Create Booking -> status-transition admin chain; RPC
// results runtime-narrowed before field access; sanitized cleanup/failure
// reporting; canary assertions as boolean predicates against EXACT captured
// strings, never a UUID regex).
//
// The RPC bridge (test-database.ts) accepts only scalar Proposal /
// ProposalVersion `create` writes (D-047's own write-validator scope,
// unchanged and unmodified here) — it has no Booking write path. Every
// Booking in this spec is therefore created the only way the accepted
// contract allows: through the real admin UI, from a real externally
// recorded Accept response, exactly as lead-to-booking-flow.spec.ts already
// does once. This spec repeats that exact sequence to seed enough bookings
// to prove real pagination (D-049 §4), never a bridge shortcut.
//
// Because Booking has no admin-UI "detail update" path yet (D-049 §5's own
// note, mirroring schemas.ts's `createBookingSchema` comment: destination,
// notes, traveler count, etc. remain unset until a later checkpoint), every
// Booking this spec creates has `destination`/`tourPackageName`/
// `travelerCount`/`includedServices`/`excludedServices`/`specialRequests`/
// `clientVisibleNotes`/`internalNotes`/`totalAmount`/`currencyCode` = null.
// This spec cannot and does not claim to prove those fields render
// correctly WHEN POPULATED — that is fully proven at the unit (service.
// test.ts) and real-database integration (service.integration.test.ts)
// tiers, both of which seed those fields directly. This spec's own
// identifier/field-exposure scope is what a real, unmodified harness can
// actually produce: the absence of `Booking.id`, `clientId`,
// `proposalVersionId`, staff identity, and the literal field-name strings
// themselves from rendered output.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// D-046 / D-049 §8: zero-retry, stop-on-first-attempt-failure. No
// `test.describe.configure({ retries })` override — the config default
// (`retries: 0`) stands, and the first attempt is the only attempt.

const SLOW = { timeout: 45_000 } as const;
const PAGE_SIZE = 10;
// 11 non-DRAFT bookings for Client A: page 1 = the 10 newest, page 2 = the
// 1 oldest — the minimum that genuinely exercises the fixed page size and
// the Next/Previous boundary (D-049 §4).
const NON_DRAFT_COUNT = 11;
const NONEXISTENT_REFERENCE = `HPB-${'F'.repeat(20)}`;
const MALFORMED_REFERENCE = 'not-a-valid-reference';

const COPY = {
  pageHeading: 'Bookings',
  emptyState: 'No bookings yet. A booking is created after you accept a proposal.',
  errorBoundary: 'Something went wrong while loading your bookings.',
  notFoundHeading: 'Booking not found',
  notFoundMessage:
    "We couldn't find that booking. It may not exist, or it may not be available to your account.",
  backLink: 'Back to Bookings',
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

/**
 * Waits for a locator that only appears after a client-side RSC
 * `router.refresh()` resolves. If it does not show within the per-attempt
 * budget, reloads the page (forcing a fresh server render) and tries again
 * — a targeted remedy for a stalled refresh, never an arbitrary sleep.
 * Duplicated from lead-to-booking-flow.spec.ts's / client-proposal-review.
 * spec.ts's identical, already-reviewed helper (per-file-copy convention).
 */
async function expectAfterRefresh(
  page: Page,
  makeLocator: () => ReturnType<Page['getByRole']>,
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
 * Duplicated from client-proposal-review.spec.ts's identical helper.
 */
function extractInlineFlight(html: string): string {
  const matches = html.match(/self\.__next_f\.push\((?:[\s\S]*?)\)<\/script>/g);
  return matches && matches.length > 0 ? matches.join('\n') : html;
}

function assertPrivateNoStoreCacheControl(raw: string | undefined, context: string): void {
  expect(raw, `${context}: Cache-Control must be present`).toBeTruthy();
  const directives = (raw ?? '').split(',').map((d) => d.trim().toLowerCase());
  expect(directives, `${context}: must include "private"`).toContain('private');
  expect(directives, `${context}: must include "no-store"`).toContain('no-store');
  expect(directives.includes('public'), `${context}: must not include "public"`).toBe(false);
}

const REQUIRED_RSC_VARY_TOKENS = [
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
] as const;
function assertFrameworkRscVary(raw: string | undefined, context: string): void {
  expect(raw, `${context}: Vary must be present`).toBeTruthy();
  const tokens = (raw ?? '').split(',').map((t) => t.trim().toLowerCase());
  for (const required of REQUIRED_RSC_VARY_TOKENS) {
    expect(tokens, `${context}: Vary must retain the framework token "${required}"`).toContain(
      required,
    );
  }
}

function assertAbsent(surfaces: string[], values: string[], context: string): void {
  for (const surface of surfaces) {
    for (const value of values) {
      expect(surface.includes(value), `${context}: "${value}" must be absent`).toBe(false);
    }
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
/**
 * The E2E RPC bridge's allowlist (test-database.ts) does not expose
 * `findFirstOrThrow` for every model (notably `user`) — only
 * `findUniqueOrThrow`/`findMany`/`deleteMany`. Where the queried field isn't
 * itself the unique lookup key, this narrows a `findMany` result's first row
 * instead, failing loudly (never silently) if the array comes back empty.
 */
function narrowFirstIdOnly(value: unknown, context: string): { id: string } {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context}: expected at least one { id } row.`);
  }
  return narrowIdOnly(value[0], context);
}
/** A residue-check array of `{ id }` rows, narrowed before `.toEqual([])`. */
function narrowIdRows(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context}: expected an array of id rows.`);
  return value.map((row, i) => narrowIdOnly(row, `${context}[${i}]`).id);
}
type BookingRow = {
  id: string;
  bookingReference: string;
  clientId: string;
  proposalVersionId: string;
  status: string;
};
function narrowBookingRows(value: unknown): BookingRow[] {
  if (!Array.isArray(value)) throw new Error('expected an array of Booking rows.');
  return value.map((row, i) => {
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      typeof row.bookingReference !== 'string' ||
      typeof row.clientId !== 'string' ||
      typeof row.proposalVersionId !== 'string' ||
      typeof row.status !== 'string'
    ) {
      throw new Error(`malformed Booking row at index ${i}.`);
    }
    return {
      id: row.id,
      bookingReference: row.bookingReference,
      clientId: row.clientId,
      proposalVersionId: row.proposalVersionId,
      status: row.status,
    };
  });
}

// --- Module-scoped record, populated as each real entity is created.
// leadIds/clientIds/proposalIds/bookingIds feed the read-only test.afterAll
// residue check (run once the tcAccount fixture's own cleanupTestChain has
// already deleted them). profileIds/invitationIds/activatedUserIds/
// rawTokens are ALSO consumed by the in-test spec-owned cleanup below —
// unlike the Lead/Client/Proposal/ProposalVersion/ProposalAcceptance/
// Booking/StaffAssignment/LeadStatusHistory/BookingStatusHistory chain
// (fully rediscovered and deleted automatically by cleanupTestChain via
// this run's own AuditLog trail, exactly as lead-to-booking-flow.spec.ts
// relies on with no explicit cleanup of its own — every action in this
// spec's admin chain, including every proposal-response recording, is
// performed by the one TC actor, never a real client-side Server Action),
// ClientProfile/PortalInvitation/the activated client User rows/
// RateLimitBucket rows are invisible to that mechanism and must be deleted
// by this spec itself, BEFORE the tcAccount fixture's own teardown runs —
// otherwise its own Client deleteMany would fail against the still-present
// ClientProfile/PortalInvitation onDelete: Restrict FKs (mirrors
// client-proposal-review.spec.ts's identical, already-reviewed discipline).
const recorded = {
  tcUserId: undefined as string | undefined,
  leadIds: [] as string[],
  clientIds: [] as string[],
  proposalIds: [] as string[],
  bookingIds: [] as string[],
  activatedUserIds: [] as string[],
  profileIds: [] as string[],
  invitationIds: [] as string[],
  rawTokens: [] as string[],
};

type ProvisionedClient = {
  label: 'A' | 'B' | 'C';
  nameCanary: string;
  email: string;
  clientPassword: string;
  leadId: string;
  clientId: string;
};

test('D-049 §8: an activated client browses their paginated Bookings list, opens a detail view, and every controlled absence (malformed / nonexistent / DRAFT / foreign-client reference) renders the identical generic "Booking not found" state — with isolation, header, navigation, and artifact-safety guarantees', async ({
  tcAccount,
  browser,
  page,
  request,
}) => {
  test.setTimeout(1_200_000);
  const prisma = createE2EPrismaRpcClient();
  recorded.tcUserId = tcAccount.userId;

  async function provisionClient(label: 'A' | 'B' | 'C'): Promise<ProvisionedClient> {
    const nameCanary = `E2E CB ${label} ${randomUUID()}`;
    const email = `e2e-cb-${label.toLowerCase()}-${randomUUID()}@example.test`;
    const clientPassword = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');

    await page.goto('/admin/leads/new');
    await page.getByLabel('Full name').fill(nameCanary);
    await page.getByLabel('Source').fill('E2E client-bookings journey');
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
    // /admin/clients is a Server Component that awaits a real listClients()
    // query before any content exists, and this is a client-side Next.js
    // <Link> transition (no full document reload) — waitForURL's own
    // load-based sync does not guarantee that RSC render has actually
    // streamed in yet. Same targeted remedy expectAfterRefresh already
    // applies elsewhere in this file (D-049 Stage 4 cross-tier
    // investigation: confirmed directly as the cause of an otherwise
    // symptomless getByLabel('Search') timeout here).
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

    return { label, nameCanary, email, clientPassword, leadId, clientId };
  }

  /**
   * The only accepted path to a real Booking (see the file header comment):
   * Proposal -> publish -> externally recorded Accept (blueprint §9.1,
   * requires no client login) -> Create Booking -> optional status
   * transition away from DRAFT. Mirrors lead-to-booking-flow.spec.ts's
   * identical sequence exactly.
   */
  async function createAcceptedBooking(
    clientId: string,
    marker: string,
    targetStatus: 'DRAFT' | 'PENDING_CONFIRMATION',
  ): Promise<string> {
    await page.goto(`/admin/clients/${clientId}`);
    await expect(page.getByLabel('Proposal content')).toBeVisible(SLOW);
    await page.getByLabel('Proposal content').fill(marker);
    await page.getByRole('button', { name: 'Create Proposal / ROS' }).click();
    await page.waitForURL((url) => /^\/admin\/proposals\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const proposalId = extractTrailingId(page.url());
    recorded.proposalIds.push(proposalId);

    await page.getByRole('button', { name: 'Publish Version 1' }).click();
    await expectAfterRefresh(
      page,
      () => page.getByRole('heading', { name: 'Record Client Response' }),
      `Record Client Response panel (${marker})`,
    );

    await page.getByLabel('Response', { exact: true }).selectOption({ label: 'Accept' });
    await page.getByLabel('Client responded at').fill(formatDatetimeLocal(new Date()));
    await page.getByLabel('Response method').fill('phone');
    await page.getByLabel('Evidence reference').fill(`E2E evidence ${randomUUID()}`);
    await page.getByRole('button', { name: 'Record Response for Version 1' }).click();
    await expectAfterRefresh(
      page,
      () => page.getByRole('button', { name: 'Create Booking' }),
      `Create Booking button (${marker})`,
    );

    await page.getByRole('button', { name: 'Create Booking' }).click();
    await page.waitForURL((url) => /^\/admin\/bookings\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const bookingId = extractTrailingId(page.url());
    recorded.bookingIds.push(bookingId);

    if (targetStatus === 'PENDING_CONFIRMATION') {
      await expect(page.getByText('Draft')).toBeVisible(SLOW);
      await page.getByLabel('New status').selectOption({ label: 'Pending Confirmation' });
      await page.getByRole('button', { name: 'Update status' }).click();
      await expect(page.locator('dd', { hasText: 'Pending Confirmation' })).toBeVisible(SLOW);
    }

    return bookingId;
  }

  async function inviteAndActivate(client: ProvisionedClient): Promise<void> {
    await page.goto(`/admin/clients/${client.clientId}`);
    await page.getByRole('button', { name: 'Prepare Invitation' }).click();
    await expect(page.getByText('Invitation prepared.')).toBeVisible(SLOW);
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(page.getByText('Invitation sent.')).toBeVisible(SLOW);
    const manualUrl = await page.getByLabel('One-time invitation link').inputValue();
    // The raw token, recovered only to compute its RateLimitBucket TOKEN-
    // dimension hash for this spec's own cleanup below — never logged,
    // never persisted, discarded once `recorded.rawTokens` holds the hash
    // input momentarily in memory. Mirrors client-proposal-review.spec.ts's
    // identical extraction.
    const hashMatch = /#token=([A-Za-z0-9_-]{24})$/.exec(manualUrl);
    const rawToken = hashMatch?.[1];
    if (!rawToken) {
      throw new Error(
        `Could not extract the invitation token from the manual link (${client.label}).`,
      );
    }
    await page.getByRole('button', { name: 'Confirm Manual Sent' }).click();
    await expect(page.getByText('Manual send confirmed.')).toBeVisible(SLOW);

    const context = await browser.newContext();
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

    recorded.rawTokens.push(rawToken);
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
        // `PortalInvitation.clientId` is `@unique` (schema.prisma), and
        // `findUniqueOrThrow` (unlike `findFirstOrThrow`) is allowlisted by
        // the E2E RPC bridge (test-database.ts).
        await prisma.portalInvitation.findUniqueOrThrow({
          where: { clientId: client.clientId },
          select: { id: true },
        }),
        `PortalInvitation(${client.label})`,
      ).id,
    );
    recorded.activatedUserIds.push(
      // `user` is allowlisted for `findMany`/`deleteMany`/`create` only —
      // no `findFirstOrThrow` — even though `User.email` is itself
      // `@unique` (schema.prisma).
      narrowFirstIdOnly(
        await prisma.user.findMany({ where: { email: client.email }, select: { id: true } }),
        `activated User(${client.label})`,
      ).id,
    );
  }

  let primaryError: unknown;
  try {
    // 1. Real TRAVEL_CONSULTANT login (once).
    await page.goto('/login');
    await page.getByLabel('Email').fill(tcAccount.email);
    await page.getByLabel('Password').fill(tcAccount.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 45_000 });

    // 2. Provision the three Clients this spec needs:
    //    A — the owning client under test (11 non-DRAFT + 1 DRAFT booking).
    //    B — a second client, never activated; its 1 non-DRAFT booking is
    //        the "foreign-client reference" fixture, reached only through
    //        A's own session.
    //    C — activated but given zero bookings, for the page-1 empty state.
    const clientA = await provisionClient('A');
    const clientB = await provisionClient('B');
    const clientC = await provisionClient('C');

    // 3. Client A: 11 non-DRAFT bookings (the pagination fixture) + 1 DRAFT
    //    booking (never transitioned — the "own DRAFT" not-found fixture).
    for (let i = 0; i < NON_DRAFT_COUNT; i += 1) {
      await createAcceptedBooking(
        clientA.clientId,
        `E2E-CB-A-${String(i).padStart(2, '0')}-${randomUUID()}`,
        'PENDING_CONFIRMATION',
      );
    }
    const draftBookingId = await createAcceptedBooking(
      clientA.clientId,
      `E2E-CB-A-DRAFT-${randomUUID()}`,
      'DRAFT',
    );

    // 4. Client B: 1 non-DRAFT booking.
    const otherBookingId = await createAcceptedBooking(
      clientB.clientId,
      `E2E-CB-B-${randomUUID()}`,
      'PENDING_CONFIRMATION',
    );

    // 5. Invite + activate A and C (B is never activated — it does not need
    //    to log in for this spec's purposes).
    await inviteAndActivate(clientA);
    await page.waitForTimeout(2000);
    await inviteAndActivate(clientC);
    await page.waitForTimeout(2000);

    // 6. Read back the exact Booking rows via the RPC bridge (reads are
    //    unrestricted; only writes are validator-gated) — this is the only
    //    way to learn each Booking's server-generated `bookingReference`
    //    and the exact plaintext `Booking.id` / `clientId` /
    //    `proposalVersionId` values D-049 §8's leakage scan requires, never
    //    a UUID regex. Profile/invitation/activated-user ids were already
    //    recorded by inviteAndActivate itself, above.
    const allBookingRows = narrowBookingRows(
      await prisma.booking.findMany({
        where: { id: { in: recorded.bookingIds } },
        select: {
          id: true,
          bookingReference: true,
          clientId: true,
          proposalVersionId: true,
          status: true,
        },
      }),
    );
    const bookingRowById = new Map(allBookingRows.map((row) => [row.id, row]));

    const draftRow = bookingRowById.get(draftBookingId)!;
    const otherRow = bookingRowById.get(otherBookingId)!;
    const ownedNonDraftRows = allBookingRows.filter(
      (row) => row.clientId === clientA.clientId && row.id !== draftBookingId,
    );
    expect(ownedNonDraftRows).toHaveLength(NON_DRAFT_COUNT);
    // Deterministic newest-first order matches creation order reversed —
    // `Booking.createdAt` is DB-generated per real sequential creation, so
    // this spec asserts membership/counts, not a specific tie-broken
    // sequence (that exact `createdAt desc, id asc` ordering is already
    // proven deterministically at the integration tier with explicit
    // timestamps).
    const ownedReferenceSet = new Set(ownedNonDraftRows.map((row) => row.bookingReference));

    // 7. Unauthenticated `/client/bookings` redirects (3xx) to `/login`.
    const anon = await request.get('/client/bookings', { maxRedirects: 0 });
    expect(
      anon.status(),
      'unauthenticated GET /client/bookings must be a 3xx',
    ).toBeGreaterThanOrEqual(300);
    expect(anon.status()).toBeLessThan(400);
    expect((anon.headers()['location'] ?? '').endsWith('/login')).toBe(true);

    // 8. Sign in as Client A, tolerating a transient stall in the
    //    /login -> /dashboard -> /client chain under connection-pool
    //    pressure (identical, already-reviewed technique to
    //    client-proposal-review.spec.ts).
    const contextA = await browser.newContext();
    try {
      const a = await contextA.newPage();
      let signedIn = false;
      for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
        try {
          await a.goto('/login', { waitUntil: 'commit', timeout: 45_000 });
          await a.getByLabel('Email').fill(clientA.email);
          await a.getByLabel('Password').fill(clientA.clientPassword);
          await a.getByRole('button', { name: 'Sign in' }).click();
          await a.waitForURL((url) => url.pathname === '/client', {
            timeout: 30_000,
            waitUntil: 'commit',
          });
          signedIn = true;
        } catch {
          await a.waitForTimeout(3000);
        }
      }
      expect(signedIn, 'Client A sign-in reached /client').toBe(true);

      // --- Navigation: open Bookings from the Home / Overview nav ---
      const bookingsNavLink = a.getByRole('link', { name: 'Bookings' });
      await expect(bookingsNavLink).toBeVisible(SLOW);
      await bookingsNavLink.click();
      await a.waitForURL((url) => url.pathname === '/client/bookings', SLOW);
      // Active state: "Bookings" is the non-link current span; the other
      // two real nav labels remain ordinary links. Scoped to the portal nav
      // itself (rather than a bare getByText) because the page's own <h1>
      // heading is also the literal text "Bookings" — an unscoped exact-text
      // locator would match both and violate Playwright's strict mode.
      const portalNav = a.getByRole('navigation', { name: 'Client portal' });
      const currentSpan = portalNav.getByText('Bookings', { exact: true });
      await expect(currentSpan).toHaveAttribute('aria-current', 'page');
      await expect(portalNav.getByRole('link', { name: 'Home / Overview' })).toBeVisible();
      await expect(portalNav.getByRole('link', { name: 'My Journey' })).toBeVisible();
      await expect(portalNav.getByRole('link', { name: 'Bookings' })).toHaveCount(0);

      // --- List page 1 ---
      const listResponse = await a.goto('/client/bookings', {
        waitUntil: 'commit',
        timeout: 60_000,
      });
      await expect(a.getByRole('heading', { level: 1, name: COPY.pageHeading })).toBeVisible(SLOW);
      await expect(a.locator('main')).toHaveCount(1, SLOW);
      await expect(a.getByText(COPY.emptyState)).toHaveCount(0);
      await expect(a.getByText(COPY.errorBoundary)).toHaveCount(0);

      // Scoped to <main> — the shared ClientPortalNav (rendered in
      // client/layout.tsx's <header>, outside <main>) itself renders one
      // <li> per nav label (3 real + 7 inert ClientPortalNavItem rows), so
      // an unscoped page-wide getByRole('listitem') would double-count
      // (confirmed directly: 10 booking rows + 10 nav rows = 20).
      const mainRegion = a.getByRole('main');
      const items = mainRegion.getByRole('listitem');
      await expect(items).toHaveCount(PAGE_SIZE, SLOW);

      expect(listResponse, 'the /client/bookings navigation must yield a response').not.toBeNull();
      expect(listResponse!.status()).toBe(200);
      assertPrivateNoStoreCacheControl(
        listResponse!.headers()['cache-control'],
        'authenticated GET /client/bookings',
      );
      expect(listResponse!.headers()['referrer-policy']).toBe('no-referrer');
      assertFrameworkRscVary(listResponse!.headers()['vary'], 'authenticated GET /client/bookings');

      await expect(a.getByRole('link', { name: 'Next' })).toBeVisible();
      await expect(a.getByRole('link', { name: 'Previous' })).toHaveCount(0);

      // Every reference rendered on page 1 belongs to A's owned set; none
      // is the DRAFT reference or B's reference.
      const page1Hrefs = await a
        .getByRole('link')
        .evaluateAll((els) =>
          els.map((el) => (el as HTMLAnchorElement).getAttribute('href') ?? ''),
        );
      const page1References = page1Hrefs
        .map((href) => /^\/client\/bookings\/(HPB-[0-9A-F]{20})$/.exec(href)?.[1])
        .filter((v): v is string => Boolean(v));
      expect(page1References).toHaveLength(PAGE_SIZE);
      for (const ref of page1References) {
        expect(ownedReferenceSet.has(ref)).toBe(true);
      }
      expect(page1References.includes(draftRow.bookingReference)).toBe(false);
      expect(page1References.includes(otherRow.bookingReference)).toBe(false);

      // --- List page 2 ---
      await a.getByRole('link', { name: 'Next' }).click();
      await a.waitForURL(
        (url) => url.pathname === '/client/bookings' && url.searchParams.get('page') === '2',
      );
      await expect(mainRegion.getByRole('listitem')).toHaveCount(1, SLOW);
      await expect(a.getByRole('link', { name: 'Previous' })).toBeVisible();
      await expect(a.getByRole('link', { name: 'Next' })).toHaveCount(0);
      const page2Hrefs = await a
        .getByRole('link')
        .evaluateAll((els) =>
          els.map((el) => (el as HTMLAnchorElement).getAttribute('href') ?? ''),
        );
      const page2References = page2Hrefs
        .map((href) => /^\/client\/bookings\/(HPB-[0-9A-F]{20})$/.exec(href)?.[1])
        .filter((v): v is string => Boolean(v));
      expect(page2References).toHaveLength(1);
      expect(page1References.includes(page2References[0]!)).toBe(false);
      expect(ownedReferenceSet.has(page2References[0]!)).toBe(true);

      // --- Detail view ---
      const detailTargetReference = page1References[0]!;
      const detailResponse = await a.goto(`/client/bookings/${detailTargetReference}`, {
        waitUntil: 'commit',
        timeout: 60_000,
      });
      await expect(
        a.getByRole('heading', { level: 1, name: `Booking ${detailTargetReference}` }),
      ).toBeVisible(SLOW);
      await expect(a.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(a.locator('main')).toHaveCount(1);
      await expect(a.getByRole('link', { name: COPY.backLink })).toHaveAttribute(
        'href',
        '/client/bookings',
      );
      expect(detailResponse!.status()).toBe(200);
      assertPrivateNoStoreCacheControl(
        detailResponse!.headers()['cache-control'],
        'authenticated GET /client/bookings/[bookingReference]',
      );
      expect(detailResponse!.headers()['referrer-policy']).toBe('no-referrer');

      const detailHtml = await a.content();
      const detailFlight = extractInlineFlight(detailHtml);
      const targetRow = allBookingRows.find((r) => r.bookingReference === detailTargetReference)!;
      assertAbsent(
        [detailHtml, detailFlight],
        [
          targetRow.id,
          targetRow.clientId,
          targetRow.proposalVersionId,
          tcAccount.userId,
          tcAccount.email,
        ],
        `detail view of ${detailTargetReference}`,
      );
      assertAbsent(
        [detailHtml, detailFlight],
        [
          'internalNotes',
          'BookingStatusHistory',
          'previousStatus',
          'changedByUserId',
          'totalAmount',
          'currencyCode',
        ],
        `detail view of ${detailTargetReference} (excluded-field names)`,
      );

      // --- Every controlled absence renders the identical generic panel ---
      const notFoundCases: Array<{ label: string; segment: string; rejected: string }> = [
        {
          label: 'malformed reference',
          segment: MALFORMED_REFERENCE,
          rejected: MALFORMED_REFERENCE,
        },
        {
          label: 'well-formed nonexistent reference',
          segment: NONEXISTENT_REFERENCE,
          rejected: NONEXISTENT_REFERENCE,
        },
        {
          label: "the owning client's own DRAFT booking",
          segment: draftRow.bookingReference,
          rejected: draftRow.bookingReference,
        },
        {
          label: "another client's booking",
          segment: otherRow.bookingReference,
          rejected: otherRow.bookingReference,
        },
      ];
      for (const { label, segment, rejected } of notFoundCases) {
        await a.goto(`/client/bookings/${segment}`, { waitUntil: 'commit', timeout: 60_000 });
        await expect(
          a.getByRole('heading', { level: 1, name: COPY.notFoundHeading }),
          `${label}: generic not-found heading`,
        ).toBeVisible(SLOW);
        await expect(a.getByText(COPY.notFoundMessage), `${label}: generic message`).toBeVisible();
        await expect(a.locator('main'), `${label}: exactly one main`).toHaveCount(1);
        await expect(
          a.getByRole('link', { name: COPY.backLink }),
          `${label}: back link`,
        ).toHaveAttribute('href', '/client/bookings');

        const html = await a.content();
        const flight = extractInlineFlight(html);
        // The rejected segment is expected to appear inside Next.js's own
        // internal Flight "flightRouterState" tuple (confirmed directly
        // against the actual captured payload:
        // `["bookingReference","<segment>","d",null]` plus a leading
        // canonical-segments array) — this is universal, content-free App
        // Router routing bookkeeping present for ANY dynamic-segment URL,
        // identical in shape regardless of whether the segment is
        // malformed, nonexistent, DRAFT, or another client's real
        // reference. It only echoes back the exact URL the caller
        // themselves already navigated to; it never distinguishes between
        // the four controlled-absence causes (their structural shape is
        // identical in every case) and reveals nothing the caller didn't
        // already supply. The actual anti-enumeration property this must
        // assert is that the rejected reference never appears in the
        // RENDERED, user-visible surface — so this scans the HTML with
        // every <script> block (the only place the router-state tuple
        // lives) stripped out, never the raw HTML or the Flight payload
        // itself, for this one assertion.
        const visibleHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
        assertAbsent(
          [visibleHtml],
          [rejected],
          `${label}: rejected reference must never appear in rendered content`,
        );
        assertAbsent(
          [html, flight],
          [draftRow.id, otherRow.id, clientA.clientId, clientB.clientId],
          `${label}: no internal identifier leakage`,
        );
      }

      // --- Keyboard reachability: the pagination/back links are real,
      //     focusable in-app anchors (not exhaustively re-walking every
      //     control the shared ClientPortalNav test suite already covers
      //     for its own three real nav items). ---
      await a.goto('/client/bookings', { waitUntil: 'commit' });
      await a.getByRole('link', { name: 'Next' }).focus();
      await expect(a.getByRole('link', { name: 'Next' })).toBeFocused();

      // Loading and unexpected-error states are not asserted here: the
      // loading skeleton is not reliably observable against a local
      // Postgres instance fast enough for Playwright to capture it, and
      // this spec — using only the accepted, unmodified application and
      // harness — has no supported way to force a genuinely unexpected
      // server error without fabricating one; both states are already
      // unit/component-tested (loading.test.tsx, error.test.tsx, D-049
      // Stage 3).
    } finally {
      await contextA.close();
    }

    // --- Empty state: Client C, zero bookings ---
    const contextC = await browser.newContext();
    try {
      const c = await contextC.newPage();
      let signedIn = false;
      for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
        try {
          await c.goto('/login', { waitUntil: 'commit', timeout: 45_000 });
          await c.getByLabel('Email').fill(clientC.email);
          await c.getByLabel('Password').fill(clientC.clientPassword);
          await c.getByRole('button', { name: 'Sign in' }).click();
          await c.waitForURL((url) => url.pathname === '/client', {
            timeout: 30_000,
            waitUntil: 'commit',
          });
          signedIn = true;
        } catch {
          await c.waitForTimeout(3000);
        }
      }
      expect(signedIn, 'Client C sign-in reached /client').toBe(true);

      await c.goto('/client/bookings', { waitUntil: 'commit', timeout: 60_000 });
      await expect(c.getByRole('heading', { level: 1, name: COPY.pageHeading })).toBeVisible(SLOW);
      await expect(c.getByText(COPY.emptyState)).toBeVisible(SLOW);
      // Scoped to <main> — see the identical page-1 comment above; an
      // unscoped check would count ClientPortalNav's own 10 <li> rows.
      await expect(c.getByRole('main').getByRole('listitem')).toHaveCount(0);
      await expect(c.getByRole('navigation', { name: 'Booking pages' })).toHaveCount(0);
      await expect(c.locator('main')).toHaveCount(1);
    } finally {
      await contextC.close();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // --- Spec-owned cleanup — runs unconditionally (success or failure),
    // and BEFORE the tcAccount fixture's own cleanupTestChain (which
    // deletes the Lead/Client/Proposal/ProposalVersion/ProposalAcceptance/
    // Booking/StaffAssignment chain via this run's AuditLog trail — see
    // the `recorded` object's own doc comment above). Sanitized: a failure
    // here throws only a safe class name plus non-secret ids, and never
    // masks an already-set primaryError. ---
    try {
      // 1. PortalInvitation (references Client, onDelete: Restrict).
      if (recorded.invitationIds.length > 0) {
        await prisma.auditLog.deleteMany({ where: { entityId: { in: recorded.invitationIds } } });
        await prisma.portalInvitation.deleteMany({ where: { id: { in: recorded.invitationIds } } });
      }

      // 2. ClientProfile before its Client / User (onDelete: Restrict on
      //    both).
      if (recorded.profileIds.length > 0) {
        await prisma.clientProfile.deleteMany({ where: { id: { in: recorded.profileIds } } });
      }

      // 3. Activated CLIENT users (Account cascade-deletes with each) —
      //    never the TC actor, which the tcAccount fixture's own teardown
      //    disposes of separately.
      if (recorded.activatedUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: recorded.activatedUserIds } } });
      }

      // 4. RateLimitBucket rows this run's real activation HTTP requests
      //    created.
      if (recorded.rawTokens.length > 0) {
        await prisma.rateLimitBucket.deleteMany({
          where: { dimension: 'TOKEN', bucketKey: { in: recorded.rawTokens.map(sha256Hex) } },
        });
      }
      if (recorded.rawTokens.length > 0) {
        await prisma.rateLimitBucket.deleteMany({
          where: {
            dimension: 'SOURCE',
            bucketKey: 'unknown-source',
            windowStart: currentSourceWindowStart(),
          },
        });
      }

      // 5. In-test residue checks by recorded id (no time predicate).
      if (recorded.profileIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.clientProfile.findMany({
              where: { id: { in: recorded.profileIds } },
              select: { id: true },
            }),
            'ClientProfile residue',
          ),
        ).toEqual([]);
      }
      if (recorded.invitationIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.portalInvitation.findMany({
              where: { id: { in: recorded.invitationIds } },
              select: { id: true },
            }),
            'PortalInvitation residue',
          ),
        ).toEqual([]);
      }
      if (recorded.activatedUserIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.user.findMany({
              where: { id: { in: recorded.activatedUserIds } },
              select: { id: true },
            }),
            'activated User residue',
          ),
        ).toEqual([]);
      }
    } catch (cleanupError) {
      const className =
        cleanupError instanceof Error ? cleanupError.constructor.name : typeof cleanupError;
      const wrapped = new Error(
        `client-bookings.spec.ts cleanup failed (${className}). Manual remediation may be required for: ${JSON.stringify(
          recorded,
        )}.`,
      );
      if (!primaryError) primaryError = wrapped;
      else console.error(`[client-bookings-e2e] cleanup also failed (${className}).`);
    } finally {
      await prisma.$disconnect();
    }
  }

  if (primaryError) throw primaryError;
});

// After the test body and the tcAccount fixture's cleanupTestChain have both
// run, verify the fixture-owned chain (rediscovered and deleted via this
// run's own AuditLog trail — see the `recorded` object's own doc comment
// above) is genuinely gone. Read-only: this performs no deletion of its own.
test.afterAll(async () => {
  const prisma = createE2EPrismaRpcClient();
  try {
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
      'ProposalVersion residue',
      () =>
        prisma.proposalVersion.findMany({
          where: { proposalId: { in: recorded.proposalIds } },
          select: { id: true },
        }),
      recorded.proposalIds.length === 0,
    );
    await emptyId(
      'Booking residue',
      () =>
        prisma.booking.findMany({
          where: { id: { in: recorded.bookingIds } },
          select: { id: true },
        }),
      recorded.bookingIds.length === 0,
    );
    if (recorded.tcUserId) {
      await emptyId(
        'AuditLog (fixture actor) residue',
        () =>
          prisma.auditLog.findMany({ where: { actorId: recorded.tcUserId }, select: { id: true } }),
        false,
      );
    }
    const disposableUserIds = [
      ...(recorded.tcUserId ? [recorded.tcUserId] : []),
      ...recorded.activatedUserIds,
    ];
    await emptyId(
      'User (fixture + activated) residue',
      () =>
        prisma.user.findMany({ where: { id: { in: disposableUserIds } }, select: { id: true } }),
      disposableUserIds.length === 0,
    );
  } catch (error) {
    const className = error instanceof Error ? error.constructor.name : typeof error;
    throw new Error(
      `client-bookings.spec.ts afterAll residue verification failed (${className}). Recorded ids: ${JSON.stringify(
        recorded,
      )}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
});
