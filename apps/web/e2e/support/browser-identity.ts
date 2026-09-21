import type { Browser, BrowserContext } from '@playwright/test';

// D-051 Stage 5B — a test-only client identity for browser contexts that
// sign in, so the isolated E2E server's Better Auth rate limiter (buckets
// keyed by client IP + request path) no longer sees every browser in the
// whole harness run as ONE client.
//
// Why this exists (confirmed by runtime evidence, not assumed): the E2E
// server runs `NODE_ENV=production`, where Better Auth enables its default
// limiter — `/sign-in/*` allows 3 requests, and the count only resets once
// more than 10 seconds pass since the last ALLOWED request. Every browser
// context here reaches the server from the same loopback address (Next's
// production server fills `x-forwarded-for` from the socket when the
// header is absent), so all sign-ins across every spec share one bucket.
// Four sign-ins whose successive gaps are each under 10 seconds — routine
// when `client-bookings` runs immediately before `client-overview` —
// produce a real `429 "Too many requests"` on the fourth. Giving each
// signing-in browser context its own single-value `x-forwarded-for` makes
// each one a distinct client to the limiter, exactly as distinct real
// users behind a proxy would be. The limiter stays ENABLED and unchanged;
// no application, auth, proxy, or limit configuration is touched.
//
// Addresses: RFC 5737 TEST-NET-3 (203.0.113.0/24) — documentation-only
// addresses that are never routable and never a real host. They are
// assigned deterministically: a fixed base per spec plus an index, so no
// two identities collide across specs or within a spec, and nothing is
// random, credential-bearing, or derived from the environment. A single
// IPv4 value (never a list) is required: Better Auth discards an
// `x-forwarded-for` containing more than one entry, and Next only fills
// the header from the socket when it is absent (`??=`), so this value
// reaches the limiter unchanged.
//
// Scope: only contexts that submit the login form need an identity
// (activation-only and unauthenticated contexts do not sign in). The app's
// own activation limiter (features/activation/source.ts) ignores every
// forwarding header unconditionally, so this never affects its
// `unknown-source` bucket or any spec's expectations about it.

const DOCUMENTATION_ADDRESS_PREFIX = '203.0.113';

// One 10-address block per spec: 203.0.113.<base>..<base + 9>.
const SPEC_ADDRESS_BASE = {
  activation: 10,
  'client-bookings': 20,
  'client-overview': 30,
  'client-proposal-review': 40,
  'client-support': 50,
  'lead-to-booking-flow': 60,
} as const;

export type E2EIdentitySpec = keyof typeof SPEC_ADDRESS_BASE;

const IDENTITIES_PER_SPEC = 10;

/**
 * Index convention: `0` is the spec's default `page` fixture context (the
 * fixture Travel Consultant's login), applied via a file-level
 * `test.use({ extraHTTPHeaders: e2eIdentityHeaders(spec, 0) })`. Indexes
 * `1..9` are the spec's additional `browser.newContext()` sign-in contexts,
 * created through `newIdentifiedContext`.
 */
export function e2eIdentityAddress(spec: E2EIdentitySpec, index: number): string {
  // Runtime own-property guard: the `E2EIdentitySpec` union is erased at
  // runtime (Playwright transpiles without type checking), so it cannot be
  // the only defense. Without this, an unknown name would look up
  // `undefined` and produce a malformed `203.0.113.NaN`, and an inherited
  // name such as `constructor` or `toString` would resolve to a function
  // instead of an allocation. Only keys OWNED by the allocation map pass.
  // The error lists the allowed identifiers and never echoes the rejected
  // value.
  if (typeof spec !== 'string' || !Object.prototype.hasOwnProperty.call(SPEC_ADDRESS_BASE, spec)) {
    throw new Error(
      `E2E browser identity spec must be one of: ${Object.keys(SPEC_ADDRESS_BASE).join(', ')}.`,
    );
  }
  if (!Number.isInteger(index) || index < 0 || index >= IDENTITIES_PER_SPEC) {
    throw new Error(
      `E2E browser identity index must be an integer from 0 to ${IDENTITIES_PER_SPEC - 1}.`,
    );
  }
  return `${DOCUMENTATION_ADDRESS_PREFIX}.${SPEC_ADDRESS_BASE[spec] + index}`;
}

/** The single-value `x-forwarded-for` header for one deterministic identity. */
export function e2eIdentityHeaders(
  spec: E2EIdentitySpec,
  index: number,
): { 'x-forwarded-for': string } {
  return { 'x-forwarded-for': e2eIdentityAddress(spec, index) };
}

/**
 * A `browser.newContext()` that carries one deterministic identity.
 * `browser.newContext()` inside Playwright Test still applies the
 * project's default context options (notably `baseURL`); only
 * `extraHTTPHeaders` is overridden here.
 */
export function newIdentifiedContext(
  browser: Browser,
  spec: E2EIdentitySpec,
  index: number,
): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: e2eIdentityHeaders(spec, index) });
}
