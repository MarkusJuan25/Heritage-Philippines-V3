import { createHash, randomUUID } from 'node:crypto';

import { generateRandomString } from 'better-auth/crypto';

import { expect, test } from './support/fixtures';
import { createE2EPrismaRpcClient, type E2EPrismaRpcClient } from './support/test-database';

// D-034 Stage 5e (D-037 Sections 4, 10, 11, 13, 15): the required
// live-HTTP evidence gates — real Cache-Control/Referrer-Policy headers
// for all three activation surfaces, and a live proof the raw token is
// absent from the real rendered response — plus the full browser-driven
// activation happy path, kept together in the single file D-037 Section
// 16 names. Mirrors lead-to-booking-flow.spec.ts's established
// conventions: one real TC fixture, no mocked auth/session/component/
// route/service/repository/persistence anywhere below.

// Mirrors features/activation/rate-limit.ts's own SOURCE_WINDOW_MS
// constant exactly. That module cannot be imported here — it transitively
// imports @/lib/db, which constructs the generated Prisma client;
// e2e/support/test-database.ts's own doc comment documents in detail why
// that import fails reproducibly under Playwright's own loader. Duplicated
// as a plain literal instead of re-derived.
const SOURCE_WINDOW_MS = 15 * 60 * 1000;

/** Mirrors features/invitations/token.ts's hashInvitationToken exactly — duplicated rather than imported, for the same reason as above. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function currentSourceWindowStart(): Date {
  const now = Date.now();
  return new Date(Math.floor(now / SOURCE_WINDOW_MS) * SOURCE_WINDOW_MS);
}

/** A syntactically valid, never-persisted 24-character token — the exact shape/alphabet generateInvitationToken() produces, via the identical primitive fixtures.ts already imports safely. */
function generateSyntheticToken(): string {
  return generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');
}

function extractTrailingId(url: string): string {
  const match = /\/([0-9a-fA-F-]{36})\/?(?:\?.*)?$/.exec(new URL(url).pathname);
  const id = match?.[1];
  if (!id) {
    throw new Error(`Could not extract a UUID from URL: ${url}`);
  }
  return id;
}

// --- Runtime narrowing for the RPC bridge's `unknown` transported results
// (Stage 2 Correction Pass 2's established discipline, mirrored from
// lead-to-booking-flow.spec.ts and fixtures.ts exactly). ---

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

type NarrowInvitation = { id: string; status: string };
function narrowInvitation(value: unknown): NarrowInvitation {
  const record = asRecord(value, 'PortalInvitation');
  return {
    id: asString(record, 'id', 'PortalInvitation'),
    status: asString(record, 'status', 'PortalInvitation'),
  };
}

type NarrowClientProfile = {
  id: string;
  userId: string;
  userRole: string;
  userEmail: string;
  hasCredentialAccount: boolean;
};
function narrowClientProfile(value: unknown): NarrowClientProfile {
  const record = asRecord(value, 'ClientProfile');
  const user = asRecord(record.user, 'ClientProfile.user');
  const accounts = user.accounts;
  if (!Array.isArray(accounts)) {
    throw new Error('Expected an array for ClientProfile.user.accounts.');
  }
  const hasCredentialAccount = accounts.some((account) => {
    const accountRecord = asRecord(account, 'ClientProfile.user.accounts[]');
    return accountRecord.providerId === 'credential';
  });
  return {
    id: asString(record, 'id', 'ClientProfile'),
    userId: asString(record, 'userId', 'ClientProfile'),
    userRole: asString(user, 'role', 'ClientProfile.user'),
    userEmail: asString(user, 'email', 'ClientProfile.user'),
    hasCredentialAccount,
  };
}

const CLIENT_PROFILE_VERIFICATION_SELECT = {
  id: true,
  userId: true,
  user: {
    select: {
      id: true,
      role: true,
      email: true,
      accounts: { select: { providerId: true } },
    },
  },
} as const;

/**
 * D-037 Section 13: parses Cache-Control as composite, comma-separated
 * directives (case-insensitively) rather than asserting an exact string —
 * a dynamically-rendered Next.js response can compose this header from
 * more than one source. Accepts both a bare "no-store" and any composite
 * value that still satisfies every individual requirement.
 */
function assertNoStoreCacheControl(rawHeader: string | undefined, context: string): void {
  expect(rawHeader, `${context}: Cache-Control header must be present`).toBeTruthy();
  const directives = (rawHeader ?? '')
    .split(',')
    .map((directive) => directive.trim().toLowerCase());
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
 * Removes only the exact disposable RateLimitBucket rows this spec's own
 * real HTTP requests created — the shared "unknown-source" SOURCE bucket
 * for the current fixed window (a fixed, application-wide key every
 * unauthenticated activation request increments, per D-037 Section 11/12),
 * and the TOKEN buckets keyed by the exact tokens this run used. Run both
 * before and after each test, so inherited state from a prior run in the
 * same 15-minute window can never produce a false throttle, and this run's
 * own contribution never leaks into whatever runs next.
 */
async function cleanupActivationRateLimitState(
  prisma: E2EPrismaRpcClient,
  tokens: readonly string[],
): Promise<void> {
  const windowStart = currentSourceWindowStart();
  await prisma.rateLimitBucket.deleteMany({
    where: { dimension: 'SOURCE', bucketKey: 'unknown-source', windowStart },
  });
  if (tokens.length > 0) {
    await prisma.rateLimitBucket.deleteMany({
      where: { dimension: 'TOKEN', bucketKey: { in: tokens.map(sha256Hex) } },
    });
  }
}

type ActivationChainIds = {
  clientId: string;
  invitationId: string | null;
  activatedUserId: string | null;
  usedTokens: readonly string[];
};

/**
 * FK-safe cleanup for everything this spec's own activation flow creates,
 * beyond the shared tcAccount fixture's own Lead/Client/TC teardown
 * (fixtures.ts's cleanupTestChain, unaffected and untouched here — that
 * fixture cannot discover these rows at all, since neither the anonymous
 * PORTAL_INVITATION_OPENED audit row nor the newly activated CLIENT
 * user's own PORTAL_INVITATION_ACTIVATED row is attributed to the TC
 * actor). Rediscovers invitationId/activatedUserId from the stable
 * clientId anchor whenever they were never assigned — a failure partway
 * through the browser journey must not prevent whatever *was* actually
 * committed from being found and removed (mirrors fixtures.ts's own
 * established "never assume every mid-test variable was assigned"
 * discipline exactly).
 */
async function cleanupActivationChain(
  prisma: E2EPrismaRpcClient,
  ids: ActivationChainIds,
): Promise<void> {
  let invitationId = ids.invitationId;
  let activatedUserId = ids.activatedUserId;

  try {
    if (!invitationId) {
      try {
        const invitation = narrowInvitation(
          await prisma.portalInvitation.findUniqueOrThrow({
            where: { clientId: ids.clientId },
            select: { id: true, status: true },
          }),
        );
        invitationId = invitation.id;
      } catch {
        invitationId = null;
      }
    }

    if (!activatedUserId) {
      try {
        const profile = narrowClientProfile(
          await prisma.clientProfile.findUniqueOrThrow({
            where: { clientId: ids.clientId },
            select: CLIENT_PROFILE_VERIFICATION_SELECT,
          }),
        );
        activatedUserId = profile.userId;
      } catch {
        activatedUserId = null;
      }
    }

    // 1. RateLimitBucket rows this test's own real HTTP requests created.
    await cleanupActivationRateLimitState(prisma, ids.usedTokens);

    // 2. AuditLog rows for this exact disposable invitation/user —
    // PORTAL_INVITATION_OPENED (ANONYMOUS/null actorId) and
    // PORTAL_INVITATION_ACTIVATED (USER/the new client's own actorId)
    // both carry entityType 'PortalInvitation', entityId: invitationId;
    // anchored by both identifiers together, matching the exact ordering
    // this stage's own authorization specifies.
    const auditConditions: Record<string, unknown>[] = [];
    if (invitationId) auditConditions.push({ entityId: invitationId });
    if (activatedUserId) auditConditions.push({ actorId: activatedUserId });
    if (auditConditions.length > 0) {
      await prisma.auditLog.deleteMany({ where: { OR: auditConditions } });
    }

    // 3. ClientProfile — onDelete: Restrict on both its User and Client
    // relations (schema.prisma), so it must be deleted before either.
    await prisma.clientProfile.deleteMany({ where: { clientId: ids.clientId } });

    // 4. PortalInvitation.
    await prisma.portalInvitation.deleteMany({ where: { clientId: ids.clientId } });

    // 5. The activated User — Account cascade-deletes automatically
    // (onDelete: Cascade, schema.prisma; already fixtures.ts's own
    // established assumption for the identical relation).
    if (activatedUserId) {
      await prisma.user.deleteMany({ where: { id: activatedUserId } });
    }

    // 6. The remaining Lead/Client/TC chain is the shared tcAccount
    // fixture's own responsibility — intentionally not duplicated here.
  } catch (error) {
    const className = error instanceof Error ? error.constructor.name : typeof error;
    throw new Error(
      `Activation E2E cleanup failed (${className}). Manual remediation may be required for ` +
        `clientId=${ids.clientId}, invitationId=${invitationId ?? '(unknown)'}, ` +
        `activatedUserId=${activatedUserId ?? '(unknown)'}.`,
    );
  }
}

// D-037 Section 15: no retention policy for trace/screenshot/video can be
// made consistent with never persisting a captured secret — stricter than
// this file's inherited global defaults (screenshot: 'only-on-failure',
// video: 'retain-on-failure' in playwright.config.ts). This spec is
// token-bearing throughout; both tests below apply. Must be declared at
// file top level, not inside test.describe — Playwright's own runner
// rejects a project-config override (trace/screenshot/video) declared
// inside a describe group, since honoring it there would require forcing
// a new worker.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test.describe('portal activation — live evidence (D-037 Stage 5e)', () => {
  test('activation surfaces set Cache-Control: no-store and Referrer-Policy: no-referrer over real HTTP', async ({
    request,
    baseURL,
  }) => {
    const syntheticToken = generateSyntheticToken();
    const prisma = createE2EPrismaRpcClient();

    try {
      // GET /activate — D-038 Section 3: a fixed, static, tokenless shell
      // that always renders the identical Continue state. The
      // header-setting mechanism (next.config.ts's headers() matcher) is
      // unconditional on the exact static path alone, so no real
      // invitation is needed for this specific check.
      const getResponse = await request.get('/activate');
      assertNoStoreCacheControl(getResponse.headers()['cache-control'], 'GET /activate');
      expect(getResponse.headers()['referrer-policy']).toBe('no-referrer');

      const continueResponse = await request.post('/api/activation/continue', {
        headers: { Origin: baseURL ?? '', 'Content-Type': 'application/json' },
        data: { token: syntheticToken },
      });
      assertNoStoreCacheControl(
        continueResponse.headers()['cache-control'],
        'POST /api/activation/continue',
      );
      expect(continueResponse.headers()['referrer-policy']).toBe('no-referrer');

      const activateResponse = await request.post('/api/activation/activate', {
        headers: { Origin: baseURL ?? '', 'Content-Type': 'application/json' },
        data: {
          token: syntheticToken,
          password: 'irrelevant-for-header-check-1',
          confirmPassword: 'irrelevant-for-header-check-2',
        },
      });
      assertNoStoreCacheControl(
        activateResponse.headers()['cache-control'],
        'POST /api/activation/activate',
      );
      expect(activateResponse.headers()['referrer-policy']).toBe('no-referrer');
    } finally {
      try {
        await cleanupActivationRateLimitState(prisma, [syntheticToken]);
      } finally {
        await prisma.$disconnect();
      }
    }
  });

  test('full browser-driven activation happy path: prepare, send, confirm, continue, activate', async ({
    page,
    browser,
    request,
    tcAccount,
    baseURL,
  }) => {
    const leadFullName = `E2E Activation Lead ${randomUUID()}`;
    const leadSource = 'E2E activation automated journey';
    const leadEmail = `e2e-activation-lead-${randomUUID()}@example.test`;
    const clientPassword = generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');

    const prisma = createE2EPrismaRpcClient();
    let clientId: string | null = null;
    let invitationId: string | null = null;
    let activatedUserId: string | null = null;
    const usedTokens: string[] = [];
    let primaryError: unknown;

    try {
      // 1. Real TRAVEL_CONSULTANT login.
      await page.goto('/login');
      await page.getByLabel('Email').fill(tcAccount.email);
      await page.getByLabel('Password').fill(tcAccount.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => url.pathname === '/admin');

      // 2. Create a Lead.
      await page.getByRole('link', { name: 'Leads', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/admin/leads');
      await page.getByRole('link', { name: 'New Lead' }).click();
      await page.waitForURL((url) => url.pathname === '/admin/leads/new');
      await page.getByLabel('Full name').fill(leadFullName);
      await page.getByLabel('Source').fill(leadSource);
      await page.getByLabel('Email').fill(leadEmail);
      await page.getByRole('button', { name: 'Create Lead' }).click();
      await expect(page.getByRole('status')).toContainText(`Lead ${leadFullName} was created.`);
      await page.getByRole('link', { name: 'View Lead' }).click();
      await page.waitForURL((url) => /^\/admin\/leads\/[0-9a-fA-F-]{36}$/.test(url.pathname));

      // 3. Change the Lead from NEW to QUALIFIED — ConvertToClientPanel
      // only renders once a Lead reaches this status (mirrors
      // lead-to-booking-flow.spec.ts's own established sequence exactly).
      await page.getByLabel('Change status to').selectOption({ label: 'Qualified' });
      await page.getByRole('button', { name: 'Change Status' }).click();
      await expect(page.getByText('Status updated.')).toBeVisible();

      // 4. Convert the Lead to a new Client.
      await expect(page.getByRole('heading', { name: 'Convert to Client' })).toBeVisible();
      await page.getByLabel('Create a new Client').check();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Confirm' }).click();
      await expect(
        page.getByText(`Converted. A new client, "${leadFullName}", was created.`),
      ).toBeVisible();

      await page.getByRole('link', { name: 'Clients', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/admin/clients');
      await page.getByLabel('Search').fill(leadFullName);
      await page.getByRole('button', { name: 'Apply filters' }).click();
      await page.locator('a:visible', { hasText: leadFullName }).click();
      await page.waitForURL((url) => /^\/admin\/clients\/[0-9a-fA-F-]{36}$/.test(url.pathname));
      clientId = extractTrailingId(page.url());
      await expect(page.getByRole('heading', { name: leadFullName })).toBeVisible();

      // 5. Prepare, MANUAL_EMAIL send, and explicitly confirm the
      // invitation through the real admin surface (D-034 Stage 4).
      await page.getByRole('button', { name: 'Prepare Invitation' }).click();
      await expect(page.getByText('Invitation prepared.')).toBeVisible();
      // MANUAL_EMAIL is PortalInvitationPanel's own default selected
      // value — never changed.
      await page.getByRole('button', { name: 'Send Invitation' }).click();
      await expect(page.getByText('Invitation sent.')).toBeVisible();

      const manualUrl = await page.getByLabel('One-time invitation link').inputValue();
      // D-038 Section 2: the token now travels in the URL fragment
      // (`#token=<24-character-token>`), not the path — extracted here via
      // the identical shape ActivationForm's own TOKEN_HASH_PATTERN
      // matches, never by assuming a path segment.
      const hashMatch = /^#token=([A-Za-z0-9_-]{24})$/.exec(new URL(manualUrl, baseURL).hash);
      const rawToken = hashMatch?.[1];
      if (!rawToken) {
        throw new Error('Could not extract the invitation token from the manual link.');
      }
      usedTokens.push(rawToken);

      await page.getByRole('button', { name: 'Confirm Manual Sent' }).click();
      await expect(page.getByText('Manual send confirmed.')).toBeVisible();

      // 6. Live evidence against the real, eligible invitation, before the
      // browser ever visits it: headers + the token-absence gate, over a
      // real HTTP response. `manualUrl` is fragment-shaped
      // (`/activate#token=...`); a URL fragment is never transmitted to
      // any server (RFC 3986 Section 3.5), so the actual HTTP request this
      // client issues carries no token in its path or query string either
      // — this call is itself live proof of that, not an assumption.
      const eligibleGet = await request.get(manualUrl);
      assertNoStoreCacheControl(eligibleGet.headers()['cache-control'], 'GET /activate (eligible)');
      expect(eligibleGet.headers()['referrer-policy']).toBe('no-referrer');
      const eligibleBody = await eligibleGet.text();
      // D-038 Section 1/3/8: a boolean predicate, never an equality check
      // that could print the token in a failure diff. Prior to D-038, this
      // exact assertion failed for real against the path-based
      // `/activate/[token]` route — Next.js's own RSC hydration payload
      // (the inline `self.__next_f.push([...])` script embedding the
      // current route's dynamic segment values) serialized the raw token
      // into the response body. Under the fragment-based route the token
      // is never part of any request the server receives at all, so this
      // response can never contain it — structurally guaranteed, not
      // merely observed — and this assertion is retained, unweakened, as
      // defense-in-depth regression proof rather than as the primary
      // evidence of the fix (D-038's own required evidence is exactly
      // this: the assertion flips from its previously reproducible
      // failure to a genuine pass).
      expect(eligibleBody.includes(rawToken)).toBe(false);

      // 7. A fresh, unauthenticated browser context — the TC's own
      // session cookie must never reach the public activation flow.
      const clientContext = await browser.newContext();
      try {
        const clientPage = await clientContext.newPage();
        await clientPage.goto(manualUrl);
        await clientPage.getByRole('button', { name: 'Continue' }).click();
        // Playwright strict mode: a plain getByLabel('Password') matches
        // both "Password" and "Confirm password" (the latter contains the
        // former as a substring under getByLabel's default matching) —
        // exact: true disambiguates each field to the one it names.
        await clientPage.getByLabel('Password', { exact: true }).fill(clientPassword);
        await clientPage.getByLabel('Confirm password', { exact: true }).fill(clientPassword);
        await clientPage.getByRole('button', { name: 'Activate account' }).click();
        await clientPage.waitForURL(
          (url) => url.pathname === '/login' && url.searchParams.get('activated') === '1',
        );
        // D-034 Section 14; D-037 Section 14: activation never signs the
        // client in automatically, and Stage 6 (CLIENT login routing,
        // /client) is explicitly out of scope for this stage — this spec
        // stops here, at the login page's own success banner, and never
        // submits real client credentials.
        await expect(
          clientPage.getByText('Your account has been activated. Sign in to continue.'),
        ).toBeVisible();
      } finally {
        await clientContext.close();
      }

      // 8. Verify committed database state via the narrowly allowlisted
      // RPC surface — the one E2E-specific proof that the real activation
      // transaction committed, beyond what the UI displayed.
      const invitation = narrowInvitation(
        await prisma.portalInvitation.findUniqueOrThrow({
          where: { clientId },
          select: { id: true, status: true },
        }),
      );
      invitationId = invitation.id;
      expect(invitation.status).toBe('ACCOUNT_ACTIVATED');

      const profile = narrowClientProfile(
        await prisma.clientProfile.findUniqueOrThrow({
          where: { clientId },
          select: CLIENT_PROFILE_VERIFICATION_SELECT,
        }),
      );
      activatedUserId = profile.userId;
      expect(profile.userRole).toBe('CLIENT');
      expect(profile.userEmail).toBe(leadEmail);
      expect(profile.hasCredentialAccount).toBe(true);
    } catch (error) {
      primaryError = error;
    } finally {
      if (clientId) {
        try {
          await cleanupActivationChain(prisma, {
            clientId,
            invitationId,
            activatedUserId,
            usedTokens,
          });
        } catch (cleanupError) {
          if (!primaryError) {
            // Nothing else failed — the cleanup failure IS the test's own
            // failure; let it surface normally.
            primaryError = cleanupError;
          } else {
            // A real test failure is already in flight — report the
            // cleanup failure without letting it mask that original
            // failure (never silently dropped either).
            const className =
              cleanupError instanceof Error ? cleanupError.constructor.name : typeof cleanupError;
            // Deliberate, sanitized diagnostic line; see doc comment above.
            console.error(
              `[activation-e2e] cleanup also failed after the primary test failure (${className}).`,
            );
          }
        }
      }
      await prisma.$disconnect();
    }

    if (primaryError) {
      throw primaryError;
    }
  });
});
