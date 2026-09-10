import { createHash, randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';
import { generateRandomString } from 'better-auth/crypto';

import { expect, test } from './support/fixtures';
import { createE2EPrismaRpcClient } from './support/test-database';

// D-047 §15 (Stage 6) — the real-Chromium, real isolated `heritage_v3_test`
// database, real admin surfaces, real activation flow, real signed-in
// CLIENT session E2E for the client proposal-review / response slice
// (`/client/my-journey`). Nothing below is mocked: no auth, session,
// component, route, service, repository, or persistence stub anywhere.
// Mirrors client-overview.spec.ts's / activation.spec.ts's established
// conventions exactly (one real TC fixture; RPC results runtime-narrowed
// before field access; sanitized cleanup/failure reporting; canary
// assertions as boolean predicates against EXACT captured strings, never a
// UUID regex; the opaque encrypted Server Action reference is never treated
// as an identifier match).
//
// Token-bearing throughout (the activation flow handles a raw invitation
// token) — like activation.spec.ts, trace/screenshot/video are disabled at
// file scope, stricter than playwright.config.ts's inherited defaults.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// D-046 / D-047 §15: zero-retry, stop-on-first-attempt-failure. No
// `test.describe.configure({ retries })` override — the config default
// (`retries: 0`) stands, and the first attempt is the only attempt.

const SLOW = { timeout: 45_000 } as const;
const PAGE_SIZE = 10;
const FILLER_COUNT = 9; // 3 admin proposals + 9 fillers => 12 current-visible => pages of 10 + 2.

const COPY = {
  pageHeading: 'My Journey',
  ackLabel: 'I understand this response is final for this proposal version.',
  submitLabel: 'Submit response',
  // The stable, server-rendered responded-state sentence — present in the
  // read-model card after revalidation and after a hard reload. The transient
  // useActionState confirmation ("Your response has been recorded.") is
  // deliberately NOT asserted: revalidatePath unmounts it before it can be
  // observed.
  immutabilityLine: "This response can't be changed for this version.",
  emptyState: 'No proposals to review yet. Your travel consultant will prepare one for you.',
  errorBoundary: 'Something went wrong while loading your proposals to review.',
} as const;

// D-047 read-model verb per response type (ProposalReviewCard RESPONSE_VERB);
// the phrase stops before the date so the assertion is locale/timing-stable.
const RESPONDED_PREFIX: Record<'ACCEPT' | 'DECLINE' | 'REQUEST_CHANGES', string> = {
  ACCEPT: 'You accepted this on',
  DECLINE: 'You declined this on',
  REQUEST_CHANGES: 'You requested changes to this on',
};

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
 * D-040 §8 "inline Flight/RSC payload inspection" — concatenate every inline
 * `self.__next_f.push(...)` script body; fall back to the whole HTML if none
 * are found so the isolation assertions can never be silently skipped.
 */
function extractInlineFlight(html: string): string {
  const matches = html.match(/self\.__next_f\.push\((?:[\s\S]*?)\)<\/script>/g);
  return matches && matches.length > 0 ? matches.join('\n') : html;
}

// --- RPC-result runtime narrowing (JSON transport does not preserve real
// Prisma return semantics — validate before any field access). ---
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function narrowIdRows(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context}: expected an array of id rows.`);
  return value.map((row, i) => {
    if (!isRecord(row) || typeof row.id !== 'string') {
      throw new Error(`${context}: malformed id row at index ${i}.`);
    }
    return row.id;
  });
}
function narrowClientProfileIdUser(value: unknown): { id: string; userId: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.userId !== 'string') {
    throw new Error('Malformed ClientProfile { id, userId } row.');
  }
  return { id: value.id, userId: value.userId };
}
function narrowIdOnly(value: unknown, context: string): { id: string } {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error(`${context}: malformed { id } row.`);
  }
  return { id: value.id };
}

function assertPrivateNoStoreCacheControl(raw: string | undefined, context: string): void {
  expect(raw, `${context}: Cache-Control must be present`).toBeTruthy();
  const directives = (raw ?? '').split(',').map((d) => d.trim().toLowerCase());
  expect(directives, `${context}: must include "private"`).toContain('private');
  expect(directives, `${context}: must include "no-store"`).toContain('no-store');
  expect(directives.includes('public'), `${context}: must not include "public"`).toBe(false);
  expect(
    directives.some((d) => d.startsWith('s-maxage')),
    `${context}: must not include "s-maxage"`,
  ).toBe(false);
  expect(
    directives.some((d) => {
      const m = /^max-age=(\d+)$/.exec(d);
      return m !== null && Number(m[1]) > 0;
    }),
    `${context}: must not assign max-age a positive value`,
  ).toBe(false);
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
function assertPresent(surfaces: string[], value: string, context: string): void {
  for (const surface of surfaces) {
    expect(surface.includes(value), `${context}: "${value}" must be present`).toBe(true);
  }
}

/**
 * The `E2E-MJ-FILLER-NN` indices actually rendered as proposal cards on the
 * current page, in DOM order. Reads only the rendered <article> text — never
 * `page.content()`, whose serialized HTML also carries the sibling page's
 * RSC / prefetch payload after a client-side <Link> navigation. Ascending
 * order here == newest-first (each filler's `createdAt` is `referenceTime -
 * i * 1h`), so an exact `toEqual` also pins the deterministic ordering.
 */
async function renderedFillerIndices(pageObject: Page): Promise<number[]> {
  const cardTexts = await pageObject.getByRole('article').allInnerTexts();
  const indices: number[] = [];
  for (const text of cardTexts) {
    const match = /E2E-MJ-FILLER-(\d{2})-/.exec(text);
    if (match) {
      indices.push(Number(match[1]));
    }
  }
  return indices;
}

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The signed-in client journey URL is always the identifier-free
 * `/client/my-journey` route with at most a canonical `?page=N` query, and
 * never carries a complete UUID / database identifier. `expectedSearch` is
 * the exact `URL.search` for the known state (`''` for page 1, `?page=N`
 * otherwise). Not used while the rejected `?page=` value is deliberately in
 * the address bar before fallback rendering.
 */
function expectClientJourneyUrl(pageObject: Page, expectedSearch: string): void {
  const url = new URL(pageObject.url());
  expect(url.pathname, 'client journey pathname').toBe('/client/my-journey');
  expect(url.search, 'client journey canonical query').toBe(expectedSearch);
  expect(url.href, 'client journey URL carries no database identifier').not.toMatch(UUID_ANYWHERE);
}

/**
 * Waits for a locator that only appears after a client-side RSC
 * `router.refresh()` resolves; reloads and retries if a refresh stalls
 * under the isolated server's small connection pool.
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

// --- Module-scoped recorded ids for the test.afterAll fixture-chain
// residue verification. ---
type Recorded = {
  tcUserId?: string;
  leadIds: string[];
  clientIds: string[];
  proposalIds: string[]; // admin-provisioned Proposals only (fixture-owned)
  versionIds: string[]; // admin-provisioned ProposalVersions only
  fillerProposalIds: string[]; // bridge-seeded — spec-owned cleanup
  activatedUserIds: string[];
  profileIds: string[];
  invitationIds: string[];
};
const recorded: Recorded = {
  leadIds: [],
  clientIds: [],
  proposalIds: [],
  versionIds: [],
  fillerProposalIds: [],
  activatedUserIds: [],
  profileIds: [],
  invitationIds: [],
};

type ResponseTarget = {
  key: 'ACCEPT' | 'DECLINE' | 'REQUEST_CHANGES';
  radioLabel: string;
  contentMarker: string;
};

type ProvisionedClient = {
  label: 'A' | 'B';
  nameCanary: string;
  email: string;
  clientPassword: string;
  leadId: string;
  clientId: string;
  proposalIds: string[];
  manualUrl: string;
  rawToken: string;
  targets: ResponseTarget[];
  xssCanary: string;
  // recovered after activation
  activatedUserId?: string;
  profileId?: string;
  invitationId?: string;
  versionIds?: string[];
  acceptanceIds?: string[];
  sessionCookie?: string;
};

// --- Focused validation for the D-047 §15 test-provisioning exception to
// the RPC bridge: the two added `create` methods accept ONLY a minimized
// scalar-only `{ data }`, and no other write, model, or malformed payload
// is reachable. Runs against the same live bridge as the journey below.
test('E2E RPC bridge write-validator: only scalar Proposal/ProposalVersion create is reachable; every other write, model, and malformed payload is rejected', async () => {
  const prisma = createE2EPrismaRpcClient();
  try {
    type AnyFn = (args: unknown) => Promise<unknown>;
    type MethodBag = {
      create: AnyFn;
      update: AnyFn;
      upsert: AnyFn;
      updateMany: AnyFn;
      findMany: AnyFn;
      deleteMany: AnyFn;
    };
    const b = prisma as unknown as {
      proposal: MethodBag;
      proposalVersion: MethodBag;
      proposalAcceptance: MethodBag;
      auditLog: MethodBag;
      session: MethodBag;
      account: MethodBag;
    };
    const uuid = () => randomUUID();
    const rej = (p: Promise<unknown>) => expect(p).rejects.toThrow();

    // Disallowed methods on otherwise-allowlisted models.
    await rej(b.proposal.update({ where: { id: uuid() }, data: {} }));
    await rej(b.proposal.upsert({ where: { id: uuid() }, create: {}, update: {} }));
    await rej(b.proposalVersion.update({ where: { id: uuid() }, data: {} }));
    await rej(b.proposalVersion.updateMany({ where: {}, data: {} }));
    await rej(b.proposalAcceptance.create({ data: { id: uuid() } }));
    await rej(b.auditLog.create({ data: { id: uuid() } }));

    // Disallowed models entirely.
    await rej(b.session.findMany({}));
    await rej(b.account.deleteMany({ where: {} }));

    // proposal.create — reject a non-UUID id/clientId, an extra `data` key,
    // a nested relation write, and an extra top-level arg key.
    await rej(b.proposal.create({ data: { id: 'not-a-uuid', clientId: uuid() } }));
    await rej(b.proposal.create({ data: { id: uuid(), clientId: 'not-a-uuid' } }));
    await rej(b.proposal.create({ data: { id: uuid(), clientId: uuid(), notes: 'x' } }));
    await rej(
      b.proposal.create({
        data: { id: uuid(), clientId: uuid(), versions: { create: { versionNumber: 1 } } },
      }),
    );
    await rej(b.proposal.create({ data: { id: uuid(), clientId: uuid() }, select: { id: true } }));

    // proposalVersion.create — reject a missing required scalar, a
    // `supersededAt` (would defeat "always current-visible"), a nested
    // relation write, an extra arg key, blank content, and a non-integer
    // versionNumber.
    const okVersion = {
      id: uuid(),
      proposalId: uuid(),
      versionNumber: 1,
      content: 'valid content',
      createdByUserId: uuid(),
      clientVisibleAt: new Date().toISOString(),
    };
    await rej(b.proposalVersion.create({ data: { ...okVersion, clientVisibleAt: undefined } }));
    await rej(
      b.proposalVersion.create({ data: { ...okVersion, supersededAt: new Date().toISOString() } }),
    );
    await rej(
      b.proposalVersion.create({
        data: { ...okVersion, acceptance: { create: { responseType: 'ACCEPT' } } },
      }),
    );
    await rej(b.proposalVersion.create({ data: { ...okVersion, content: '   ' } }));
    await rej(b.proposalVersion.create({ data: { ...okVersion, versionNumber: 1.5 } }));
    await rej(b.proposalVersion.create({ data: okVersion, include: { proposal: true } }));
  } finally {
    await prisma.$disconnect();
  }
});

test('D-047 §15: an activated client reads, responds to (Accept/Decline/Request Changes on separate versions), and paginates their proposals on /client/my-journey — with immutability, isolation, header, privacy, and artifact-safety guarantees', async ({
  tcAccount,
  browser,
  page,
  request,
}) => {
  test.setTimeout(600_000);
  const prisma = createE2EPrismaRpcClient();
  recorded.tcUserId = tcAccount.userId;
  const referenceTime = Date.now();
  const clients: ProvisionedClient[] = [];
  let primaryError: unknown;

  async function provisionClient(label: 'A' | 'B'): Promise<ProvisionedClient> {
    const nameCanary = `E2E MJ ${label} ${randomUUID()}`;
    const email = `e2e-mj-${label.toLowerCase()}-${randomUUID()}@example.test`;
    const clientPassword = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');
    const xssCanary = `<script>window.__mjPwned=${randomUUID().slice(0, 8)}</script> **not-bold** <img src=x onerror="window.__mjImg=1">`;

    const targets: ResponseTarget[] =
      label === 'A'
        ? [
            {
              key: 'ACCEPT',
              radioLabel: 'Accept',
              contentMarker: `E2E-MJ-CONTENT-A-ACCEPT-${randomUUID()} ${xssCanary} literal-tail`,
            },
            {
              key: 'DECLINE',
              radioLabel: 'Decline',
              contentMarker: `E2E-MJ-CONTENT-A-DECLINE-${randomUUID()}`,
            },
            {
              key: 'REQUEST_CHANGES',
              radioLabel: 'Request changes',
              contentMarker: `E2E-MJ-CONTENT-A-RC-${randomUUID()}`,
            },
          ]
        : [
            {
              key: 'ACCEPT',
              radioLabel: 'Accept',
              contentMarker: `E2E-MJ-CONTENT-B-ONLY-${randomUUID()}`,
            },
          ];

    // Lead.
    await page.goto('/admin/leads/new');
    await page.getByLabel('Full name').fill(nameCanary);
    await page.getByLabel('Source').fill('E2E client-proposal-review journey');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Create Lead' }).click();
    await expect(page.getByRole('status')).toContainText(`Lead ${nameCanary} was created.`, SLOW);
    await page.getByRole('link', { name: 'View Lead' }).click();
    await page.waitForURL((url) => /^\/admin\/leads\/[0-9a-fA-F-]{36}$/.test(url.pathname));
    const leadId = extractTrailingId(page.url());
    recorded.leadIds.push(leadId);
    await expect(page.getByText('Assigned Consultant:')).toBeVisible(SLOW);

    // NEW -> QUALIFIED.
    await page.getByLabel('Change status to').selectOption({ label: 'Qualified' });
    await page.getByRole('button', { name: 'Change Status' }).click();
    await expect(page.getByText('Status updated.')).toBeVisible(SLOW);

    // Convert to a new Client.
    await expectAfterRefresh(
      page,
      () => page.getByRole('heading', { name: 'Convert to Client' }),
      'Convert to Client panel after NEW -> QUALIFIED',
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

    // Create + publish one Proposal / ROS per response target.
    const proposalIds: string[] = [];
    for (const target of targets) {
      await page.goto(`/admin/clients/${clientId}`);
      await expect(page.getByLabel('Proposal content')).toBeVisible(SLOW);
      await page.getByLabel('Proposal content').fill(target.contentMarker);
      await page.getByRole('button', { name: 'Create Proposal / ROS' }).click();
      await page.waitForURL((url) => /^\/admin\/proposals\/[0-9a-fA-F-]{36}$/.test(url.pathname));
      const proposalId = extractTrailingId(page.url());
      proposalIds.push(proposalId);
      recorded.proposalIds.push(proposalId);
      await page.getByRole('button', { name: 'Publish Version 1' }).click();
      await expectAfterRefresh(
        page,
        () => page.getByRole('heading', { name: 'Record Client Response' }),
        `Record Client Response panel after publishing ${target.key} proposal`,
      );
    }

    // Invitation: Prepare -> Send -> capture the one-time link -> Confirm.
    await page.goto(`/admin/clients/${clientId}`);
    await page.getByRole('button', { name: 'Prepare Invitation' }).click();
    await expect(page.getByText('Invitation prepared.')).toBeVisible(SLOW);
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    await expect(page.getByText('Invitation sent.')).toBeVisible(SLOW);
    const manualUrl = await page.getByLabel('One-time invitation link').inputValue();
    const hashMatch = /#token=([A-Za-z0-9_-]{24})$/.exec(manualUrl);
    const rawToken = hashMatch?.[1];
    if (!rawToken) throw new Error('Could not extract the invitation token from the manual link.');
    await page.getByRole('button', { name: 'Confirm Manual Sent' }).click();
    await expect(page.getByText('Manual send confirmed.')).toBeVisible(SLOW);

    return {
      label,
      nameCanary,
      email,
      clientPassword,
      leadId,
      clientId,
      proposalIds,
      manualUrl,
      rawToken,
      targets,
      xssCanary,
    };
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

  try {
    // 1. Real TRAVEL_CONSULTANT login (once).
    await page.goto('/login');
    await page.getByLabel('Email').fill(tcAccount.email);
    await page.getByLabel('Password').fill(tcAccount.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 45_000 });

    // 2. Provision Client A (3 proposals, one carrying an XSS canary) and
    //    Client B (1 proposal, isolation control).
    const provisionedA = await provisionClient('A');
    clients.push(provisionedA);
    await page.waitForTimeout(1500);
    const provisionedB = await provisionClient('B');
    clients.push(provisionedB);

    // 3. Bridge-seed FILLER_COUNT extra current-client-visible proposals for
    //    Client A so A crosses the fixed 10-card pagination boundary. Each
    //    filler is a bare Proposal + one current-visible ProposalVersion,
    //    with a strictly-past `createdAt` so the 3 admin-provisioned
    //    proposals are always the newest (page 1) and filler ordering is
    //    fully deterministic (`Proposal.createdAt desc`). Bridge seeding
    //    never touches ProposalAcceptance / audit rows — those are produced
    //    ONLY by the real Server Action below.
    for (let i = 1; i <= FILLER_COUNT; i += 1) {
      const proposalId = randomUUID();
      const versionId = randomUUID();
      const createdAt = new Date(referenceTime - i * 3_600_000).toISOString();
      await prisma.proposal.create({
        data: { id: proposalId, clientId: provisionedA.clientId, createdAt },
      });
      await prisma.proposalVersion.create({
        data: {
          id: versionId,
          proposalId,
          versionNumber: 1,
          content: `E2E-MJ-FILLER-${String(i).padStart(2, '0')}-${randomUUID()}`,
          createdByUserId: tcAccount.userId,
          clientVisibleAt: new Date().toISOString(),
        },
      });
      recorded.fillerProposalIds.push(proposalId);
    }
    const fillerMarkerPrefix = 'E2E-MJ-FILLER-';
    // Page 1 = 3 admin proposals (newest) + the 7 newest fillers (i = 1..7).
    // Page 2 = the 2 oldest fillers (i = 8, 9). Fully deterministic: every
    // filler `createdAt` is a fixed strictly-past instant.
    const page1FillerIndices = Array.from({ length: PAGE_SIZE - 3 }, (_, k) => k + 1);
    const page2FillerIndices = Array.from(
      { length: FILLER_COUNT - (PAGE_SIZE - 3) },
      (_, k) => PAGE_SIZE - 3 + k + 1,
    );

    // 4. Unauthenticated `/client/my-journey` redirects (3xx) to `/login`.
    const anon = await request.get('/client/my-journey', { maxRedirects: 0 });
    expect(
      anon.status(),
      'unauthenticated GET /client/my-journey must be a 3xx',
    ).toBeGreaterThanOrEqual(300);
    expect(anon.status()).toBeLessThan(400);
    expect((anon.headers()['location'] ?? '').endsWith('/login')).toBe(true);

    // 5. Activate both accounts.
    await activateClient(provisionedA);
    await page.waitForTimeout(2000);
    await activateClient(provisionedB);
    await page.waitForTimeout(2000);

    // 6. Recover committed activation ids + the concrete ProposalVersion ids.
    async function recover(client: ProvisionedClient): Promise<void> {
      const profile = narrowClientProfileIdUser(
        await prisma.clientProfile.findUniqueOrThrow({
          where: { clientId: client.clientId },
          select: { id: true, userId: true },
        }),
      );
      client.profileId = profile.id;
      client.activatedUserId = profile.userId;
      client.invitationId = narrowIdOnly(
        await prisma.portalInvitation.findUniqueOrThrow({
          where: { clientId: client.clientId },
          select: { id: true },
        }),
        'PortalInvitation',
      ).id;
      client.versionIds = narrowIdRows(
        await prisma.proposalVersion.findMany({
          where: { proposalId: { in: client.proposalIds } },
          select: { id: true },
        }),
        `ProposalVersion(${client.label})`,
      );
      expect(client.versionIds).toHaveLength(client.proposalIds.length);
      recorded.activatedUserIds.push(client.activatedUserId);
      recorded.profileIds.push(client.profileId);
      recorded.invitationIds.push(client.invitationId);
      recorded.versionIds.push(...client.versionIds);
    }
    await recover(provisionedA);
    await recover(provisionedB);

    // 7. The main signed-in Client A journey.
    await page.waitForTimeout(3000);
    const contextA = await browser.newContext();
    let htmlA_page1 = '';
    let flightA_page1 = '';
    let htmlA_afterResponses = '';
    try {
      const a = await contextA.newPage();

      // Sign in, tolerating a transient stall in the /login -> /dashboard ->
      // /client chain under connection-pool pressure. Each attempt is a
      // genuine end-to-end sign-in.
      let signedIn = false;
      for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
        try {
          await a.goto('/login', { waitUntil: 'commit', timeout: 45_000 });
          await a.getByLabel('Email').fill(provisionedA.email);
          await a.getByLabel('Password').fill(provisionedA.clientPassword);
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

      // Capture the session cookie value (the replayable credential) for the
      // privacy assertions below.
      const cookies = await contextA.cookies();
      const sessionCookie = cookies.find((c) => /session/i.test(c.name) && c.value.length > 0);
      provisionedA.sessionCookie = sessionCookie?.value;
      expect(provisionedA.sessionCookie, 'a session cookie was set for Client A').toBeTruthy();

      // --- /client/my-journey page 1 ---
      const mjResponse = await a.goto('/client/my-journey', {
        waitUntil: 'commit',
        timeout: 60_000,
      });
      await expect(a.getByRole('heading', { level: 1, name: COPY.pageHeading })).toBeVisible(SLOW);
      await expect(a.locator('main')).toHaveCount(1, SLOW);
      await expect(a.getByText(COPY.emptyState)).toHaveCount(0);
      await expect(a.getByText(COPY.errorBoundary)).toHaveCount(0);

      // Exactly 10 cards on page 1.
      const cards = a.getByRole('article');
      await expect(cards).toHaveCount(PAGE_SIZE, SLOW);

      // Confirmed page-1 state: the identifier-free canonical route, empty query.
      expectClientJourneyUrl(a, '');

      // Live headers on the authenticated /client/my-journey response.
      expect(mjResponse, 'the /client/my-journey navigation must yield a response').not.toBeNull();
      expect(mjResponse!.status()).toBe(200);
      assertPrivateNoStoreCacheControl(
        mjResponse!.headers()['cache-control'],
        'authenticated GET /client/my-journey',
      );
      expect(mjResponse!.headers()['referrer-policy']).toBe('no-referrer');
      assertFrameworkRscVary(mjResponse!.headers()['vary'], 'authenticated GET /client/my-journey');

      // The 3 admin proposal content markers + the 7 newest fillers are on
      // page 1; the 2 oldest fillers are NOT.
      for (const target of provisionedA.targets) {
        await expect(a.getByText(target.contentMarker, { exact: false })).toBeVisible(SLOW);
      }
      // Partition + ordering asserted against the rendered cards only: page 1
      // shows exactly fillers 1..7, newest first, and neither page-2 filler.
      expect(
        await renderedFillerIndices(a),
        'page 1 renders exactly fillers 1..7, newest first',
      ).toEqual(page1FillerIndices);

      // --- XSS canary: markup-looking proposal content renders as literal
      //     text and is never interpreted or executed. ---
      const acceptTarget = provisionedA.targets.find((t) => t.key === 'ACCEPT')!;
      const canaryCard = a
        .getByRole('article')
        .filter({ hasText: acceptTarget.contentMarker.slice(0, 40) });
      await expect(canaryCard).toHaveCount(1);
      // The full literal string (script tags and all) is visible text.
      await expect(canaryCard).toContainText('<script>window.__mjPwned=');
      await expect(canaryCard).toContainText('literal-tail');
      // No live element was created from it, and no inline handler fired.
      await expect(canaryCard.locator('script')).toHaveCount(0);
      await expect(canaryCard.locator('img')).toHaveCount(0);
      expect(
        await a.evaluate(() => (window as unknown as Record<string, unknown>).__mjPwned),
      ).toBeUndefined();
      expect(
        await a.evaluate(() => (window as unknown as Record<string, unknown>).__mjImg),
      ).toBeUndefined();

      // --- Acknowledgement-gated submit on each of the 3 separate proposals. ---
      async function respond(target: ResponseTarget): Promise<void> {
        const card = a.getByRole('article').filter({ hasText: target.contentMarker.slice(0, 40) });
        await expect(card).toHaveCount(1);
        const form = card.locator('form');
        await expect(form).toHaveCount(1);
        const submit = form.getByRole('button', { name: COPY.submitLabel });

        // Disabled until BOTH a responseType and the acknowledgement are set.
        await expect(submit).toBeDisabled();
        await form.getByRole('radio', { name: target.radioLabel }).check();
        await expect(submit).toBeDisabled();
        await form.getByRole('checkbox', { name: COPY.ackLabel }).check();
        await expect(submit).toBeEnabled();

        await submit.click();

        // Success -> after the Server Action's revalidatePath the card is
        // re-rendered from the database in its stable, server-rendered
        // responded state: the response form is gone and the read-model shows
        // the response-type line + the immutability sentence. The transient
        // useActionState confirmation is intentionally not relied on.
        await expectAfterRefresh(
          a,
          () => card.getByText(RESPONDED_PREFIX[target.key], { exact: false }),
          `${target.key}: server-rendered responded line after revalidation`,
        );
        await expect(card.getByText(COPY.immutabilityLine, { exact: false })).toBeVisible(SLOW);
        await expect(card.locator('form')).toHaveCount(0);
      }
      await respond(acceptTarget);
      await respond(provisionedA.targets.find((t) => t.key === 'DECLINE')!);
      await respond(provisionedA.targets.find((t) => t.key === 'REQUEST_CHANGES')!);

      // Persistence + immutability after a hard reload: still responded, with
      // the response-type-specific read-model line, and no form is ever
      // offered again for those versions.
      await a.reload({ waitUntil: 'commit', timeout: 60_000 });
      await expect(a.getByRole('heading', { level: 1, name: COPY.pageHeading })).toBeVisible(SLOW);
      for (const target of provisionedA.targets) {
        const card = a.getByRole('article').filter({ hasText: target.contentMarker.slice(0, 40) });
        await expect(card).toHaveCount(1);
        await expect(card.getByText(RESPONDED_PREFIX[target.key], { exact: false })).toBeVisible(
          SLOW,
        );
        await expect(card.getByText(COPY.immutabilityLine, { exact: false })).toBeVisible(SLOW);
        await expect(card.locator('form')).toHaveCount(0);
      }
      await expect(a.getByRole('article')).toHaveCount(PAGE_SIZE, SLOW);

      htmlA_afterResponses = await a.content();

      // The real portal-path ProposalAcceptance rows now exist for A's 3
      // admin versions (produced ONLY by the Server Action / service).
      const acceptanceRows = narrowIdRows(
        await prisma.proposalAcceptance.findMany({
          where: { proposalVersionId: { in: provisionedA.versionIds! } },
          select: { id: true },
        }),
        'ProposalAcceptance(A)',
      );
      expect(acceptanceRows).toHaveLength(3);
      provisionedA.acceptanceIds = acceptanceRows;
      recorded.versionIds.push(...provisionedA.versionIds!);

      // --- Pagination: real in-app Next / Previous links. ---
      const nextLink = a.getByRole('link', { name: 'Next' });
      await expect(nextLink).toHaveAttribute('href', '/client/my-journey?page=2');
      await Promise.all([
        a.waitForURL((url) => url.pathname === '/client/my-journey' && url.search === '?page=2', {
          timeout: 45_000,
        }),
        nextLink.click(),
      ]);
      await expect(a.getByRole('article')).toHaveCount(2, SLOW);
      // Page 2 via the real in-app Next link: canonical `?page=2`, no identifier.
      expectClientJourneyUrl(a, '?page=2');
      // Partition + ordering asserted against the rendered cards only: page 2
      // shows exactly fillers 8..9, newest first, and no page-1 filler.
      expect(
        await renderedFillerIndices(a),
        'page 2 renders exactly fillers 8..9, newest first',
      ).toEqual(page2FillerIndices);
      // No admin proposal card appears on page 2.
      for (const target of provisionedA.targets) {
        await expect(
          a.getByRole('article').filter({ hasText: target.contentMarker.slice(0, 40) }),
        ).toHaveCount(0);
      }

      const prevLink = a.getByRole('link', { name: 'Previous' });
      await expect(prevLink).toHaveAttribute('href', '/client/my-journey');
      await Promise.all([
        a.waitForURL((url) => url.pathname === '/client/my-journey' && url.search === '', {
          timeout: 45_000,
        }),
        prevLink.click(),
      ]);
      await expect(a.getByRole('article')).toHaveCount(PAGE_SIZE, SLOW);
      // Back on page 1 via the real in-app Previous link: empty query, no identifier.
      expectClientJourneyUrl(a, '');

      // --- Invalid ?page= falls back to page 1 and is never surfaced to the
      //     user. The raw value may legitimately remain in Next's
      //     router-state / flight payload and the address bar — those are not
      //     asserted here; only rendered, user-observable output is. ---
      const rejectedPageValue = 'not-a-page-9e3-01';
      await a.goto(`/client/my-journey?page=${encodeURIComponent(rejectedPageValue)}`, {
        waitUntil: 'commit',
        timeout: 60_000,
      });
      // Fallback proof: the page-1 heading + exactly 10 rendered cards.
      await expect(a.getByRole('heading', { level: 1, name: COPY.pageHeading })).toBeVisible(SLOW);
      await expect(a.getByRole('article')).toHaveCount(PAGE_SIZE, SLOW);
      // Not in the rendered main content.
      const invalidPageMainText = await a.locator('main').innerText();
      expect(
        invalidPageMainText,
        'rejected ?page= value must not appear in the rendered main content',
      ).not.toContain(rejectedPageValue);
      // Not propagated into a rendered interactive-element target
      // (anchor href / form action).
      const invalidPageInteractiveTargets = await a
        .locator('main a[href], main form[action]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('href') ?? node.getAttribute('action') ?? ''),
        );
      for (const target of invalidPageInteractiveTargets) {
        expect(
          target,
          'rejected ?page= value must not be propagated into an href/action',
        ).not.toContain(rejectedPageValue);
      }

      // --- A valid ?page= beyond the last page redirects to the bare route. ---
      await a.goto('/client/my-journey?page=99', { waitUntil: 'commit', timeout: 60_000 });
      await a.waitForURL((url) => url.pathname === '/client/my-journey' && url.search === '', {
        timeout: 45_000,
      });
      await expect(a.getByRole('article')).toHaveCount(PAGE_SIZE, SLOW);

      // Capture page-1 surfaces for the identifier-absence / privacy checks.
      await a.goto('/client/my-journey', { waitUntil: 'commit', timeout: 60_000 });
      await expect(a.getByRole('article')).toHaveCount(PAGE_SIZE, SLOW);
      htmlA_page1 = await a.content();
      flightA_page1 = extractInlineFlight(htmlA_page1);
    } finally {
      await contextA.close();
    }

    // 8. Client B — sees ONLY B's proposal; never A's content or ids.
    await page.waitForTimeout(3000);
    const contextB = await browser.newContext();
    let htmlB = '';
    let flightB = '';
    try {
      const b = await contextB.newPage();
      let signedIn = false;
      for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
        try {
          await b.goto('/login', { waitUntil: 'commit', timeout: 45_000 });
          await b.getByLabel('Email').fill(provisionedB.email);
          await b.getByLabel('Password').fill(provisionedB.clientPassword);
          await b.getByRole('button', { name: 'Sign in' }).click();
          await b.waitForURL((url) => url.pathname === '/client', {
            timeout: 30_000,
            waitUntil: 'commit',
          });
          signedIn = true;
        } catch {
          await b.waitForTimeout(3000);
        }
      }
      expect(signedIn, 'Client B sign-in reached /client').toBe(true);

      await b.goto('/client/my-journey', { waitUntil: 'commit', timeout: 60_000 });
      await expect(b.getByRole('heading', { level: 1, name: COPY.pageHeading })).toBeVisible(SLOW);
      await expect(b.getByRole('article')).toHaveCount(provisionedB.proposalIds.length, SLOW);
      await expect(
        b.getByText(provisionedB.targets[0]!.contentMarker, { exact: false }),
      ).toBeVisible();
      // No pagination for a single page.
      await expect(b.getByRole('link', { name: 'Next' })).toHaveCount(0);
      await expect(b.getByRole('link', { name: 'Previous' })).toHaveCount(0);

      htmlB = await b.content();
      flightB = extractInlineFlight(htmlB);
    } finally {
      await contextB.close();
    }

    // 9. Identifier-absence + privacy (exact captured strings; never a UUID
    //    regex; the opaque encrypted Server Action reference is never a
    //    match for a plaintext id).
    const surfacesA = [htmlA_page1, flightA_page1, htmlA_afterResponses];
    const aSecrets = compact([
      provisionedA.clientId,
      provisionedA.profileId,
      provisionedA.activatedUserId,
      provisionedA.invitationId,
      provisionedA.sessionCookie,
      ...provisionedA.proposalIds,
      ...(provisionedA.versionIds ?? []),
      ...(provisionedA.acceptanceIds ?? []),
      ...recorded.fillerProposalIds,
    ]);
    assertAbsent(
      surfacesA,
      aSecrets,
      "Client A's own /client/my-journey surfaces — no DB identifier, ClientProfile id, or session credential",
    );
    // The client journey URL itself carries no database identifier — asserted
    // live against page `a` at each known state (page 1, ?page=2, back to
    // page 1) while contextA was open, above.
    // Positive control: the authorized owner legitimately sees the exact
    // seeded proposal content — it is NOT prohibited data.
    for (const target of provisionedA.targets) {
      assertPresent(
        [htmlA_page1],
        target.contentMarker.split(' <script>')[0]!.trim(),
        'A owner content',
      );
    }

    // 10. Cross-client isolation: Client B's surfaces carry none of Client
    //     A's content markers or identifiers, and vice versa.
    const surfacesB = [htmlB, flightB];
    assertAbsent(
      surfacesB,
      compact([
        ...provisionedA.targets.map((t) => t.contentMarker),
        provisionedA.xssCanary,
        provisionedA.clientId,
        provisionedA.profileId,
        provisionedA.activatedUserId,
        provisionedA.invitationId,
        ...provisionedA.proposalIds,
        ...(provisionedA.versionIds ?? []),
        ...(provisionedA.acceptanceIds ?? []),
        ...recorded.fillerProposalIds,
        `${fillerMarkerPrefix}01`,
      ]),
      "Client B's /client/my-journey surfaces vs Client A",
    );
    assertAbsent(
      surfacesA,
      compact([
        provisionedB.targets[0]!.contentMarker,
        provisionedB.clientId,
        provisionedB.profileId,
      ]),
      "Client A's surfaces vs Client B",
    );
  } catch (error) {
    primaryError = error;
  } finally {
    // --- Spec-owned cleanup — runs BEFORE the tcAccount fixture's own
    // cleanupTestChain (which deletes the Client rows and would fail on
    // ProposalAcceptance / ClientProfile / PortalInvitation onDelete:
    // Restrict FKs, or on the bridge-seeded filler Proposals that carry no
    // TC audit trail, if they still existed). The admin Lead/Client/
    // Proposal/Version/Acceptance/assignment/TC chain is the fixture's
    // responsibility; only the portal-produced rows and the bridge-seeded
    // fillers are removed here. Sanitized: a failure throws only a safe
    // class name + non-secret ids. ---
    try {
      const clientIds = compact(clients.map((c) => c.clientId));
      const activatedUserIds = compact(clients.map((c) => c.activatedUserId));
      const invitationIds = compact(clients.map((c) => c.invitationId));
      const profileIds = compact(clients.map((c) => c.profileId));
      const tokenHashes = clients.map((c) => sha256Hex(c.rawToken));
      const auditOr = [
        ...invitationIds.map((id) => ({ entityId: id })),
        ...activatedUserIds.map((id) => ({ actorId: id })),
      ];

      // 1. Portal ProposalAcceptance rows (real, Server-Action-produced).
      const adminVersionIds = compact(clients.flatMap((c) => c.versionIds ?? []));
      if (adminVersionIds.length > 0) {
        await prisma.proposalAcceptance.deleteMany({
          where: { proposalVersionId: { in: adminVersionIds } },
        });
      }

      // 2. Activation + PROPOSAL_RESPONSE_RECORDED AuditLog rows (client
      //    actor / invitation entity — never the TC actor).
      if (auditOr.length > 0) {
        await prisma.auditLog.deleteMany({ where: { OR: auditOr } });
      }

      // 3. ClientProfile before its Client / User (onDelete: Restrict), then
      //    PortalInvitation.
      if (clientIds.length > 0) {
        await prisma.clientProfile.deleteMany({ where: { clientId: { in: clientIds } } });
        await prisma.portalInvitation.deleteMany({ where: { clientId: { in: clientIds } } });
      }

      // 4. Bridge-seeded filler ProposalVersions + Proposals (no audit
      //    trail; the fixture cleanup can't see them, and Client deletion
      //    would otherwise be blocked).
      if (recorded.fillerProposalIds.length > 0) {
        await prisma.proposalVersion.deleteMany({
          where: { proposalId: { in: recorded.fillerProposalIds } },
        });
        await prisma.proposal.deleteMany({ where: { id: { in: recorded.fillerProposalIds } } });
      }

      // 5. Activated CLIENT users (Account cascade-deletes with each).
      if (activatedUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: activatedUserIds } } });
      }

      // 6. RateLimitBucket rows this run's real activation HTTP requests
      //    created.
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

      // 7. In-test residue checks by recorded id (no time predicate).
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
      if (recorded.fillerProposalIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.proposal.findMany({
              where: { id: { in: recorded.fillerProposalIds } },
              select: { id: true },
            }),
            'filler Proposal residue',
          ),
        ).toEqual([]);
      }
      if (adminVersionIds.length > 0) {
        expect(
          narrowIdRows(
            await prisma.proposalAcceptance.findMany({
              where: { proposalVersionId: { in: adminVersionIds } },
              select: { id: true },
            }),
            'portal ProposalAcceptance residue',
          ),
        ).toEqual([]);
      }
      if (auditOr.length > 0) {
        expect(
          narrowIdRows(
            await prisma.auditLog.findMany({ where: { OR: auditOr }, select: { id: true } }),
            'activation / response AuditLog residue',
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
        fillerProposalIds: recorded.fillerProposalIds,
      };
      const wrapped = new Error(
        `client-proposal-review E2E cleanup failed (${className}). Manual remediation may be required for: ${JSON.stringify(safeIds)}.`,
      );
      if (!primaryError) primaryError = wrapped;
      else console.error(`[client-proposal-review-e2e] cleanup also failed (${className}).`);
    } finally {
      await prisma.$disconnect();
    }
  }

  if (primaryError) throw primaryError;
});

// After the test body and the tcAccount fixture's cleanupTestChain have both
// run, verify the fixture-owned chain is gone (its own RPC client;
// $disconnect in finally; recorded ids; filter(Boolean) before every `in`).
test.afterAll(async () => {
  const prisma = createE2EPrismaRpcClient();
  try {
    const leadIds = compact(recorded.leadIds);
    const clientIds = compact(recorded.clientIds);
    const proposalIds = compact(recorded.proposalIds);
    const versionIds = compact(recorded.versionIds);
    const fillerProposalIds = compact(recorded.fillerProposalIds);
    const disposableUserIds = compact([recorded.tcUserId, ...recorded.activatedUserIds]);

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
      'Client residue',
      () => prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true } }),
      clientIds.length === 0,
    );
    await emptyId(
      'Proposal residue (admin + filler)',
      () =>
        prisma.proposal.findMany({
          where: { id: { in: [...proposalIds, ...fillerProposalIds] } },
          select: { id: true },
        }),
      proposalIds.length === 0 && fillerProposalIds.length === 0,
    );
    await emptyId(
      'ProposalVersion residue',
      () =>
        prisma.proposalVersion.findMany({
          where: { proposalId: { in: [...proposalIds, ...fillerProposalIds] } },
          select: { id: true },
        }),
      proposalIds.length === 0 && fillerProposalIds.length === 0,
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
      `client-proposal-review E2E afterAll residue verification failed (${className}). Recorded ids: ${JSON.stringify(
        {
          leadIds: compact(recorded.leadIds),
          clientIds: compact(recorded.clientIds),
          proposalIds: compact(recorded.proposalIds),
          fillerProposalIds: recorded.fillerProposalIds,
          activatedUserIds: compact(recorded.activatedUserIds),
        },
      )}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
});
