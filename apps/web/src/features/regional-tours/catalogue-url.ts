// D-052 Stage 2 (docs/HERITAGE_V3_DECISIONS_LOG.md D-052 §5): the pure,
// server-only resolver for the V2 public tour-catalogue link that the client
// portal's Regional Tours page (a later D-052 stage) will render.
//
// The page reads `process.env.APP_V2_PUBLIC_SITE_URL` at request time and
// passes the raw value here. The variable is deliberately NOT part of the
// validated required-environment schema (`@/lib/env`): `getServerEnv()`
// throws for the whole application when any schema field is invalid, and an
// optional, non-critical link value must never be able to fail
// authentication, database access, or any other server code. This module
// therefore imports nothing at all — no Prisma, authentication, session, or
// environment-schema module — performs no I/O (no network, no filesystem,
// no reachability check), and never reads the environment itself.
//
// Contract (D-052 §5). Input is `unknown`. Any input that is not a string —
// `undefined`, `null`, a number, a boolean, an object, an array, or anything
// else — is unavailable, and is never coerced or stringified. For a string,
// these rules apply in this order:
//   (1) an empty or whitespace-only string is unavailable;
//   (2) trim leading and trailing ASCII whitespace, then any remaining
//       whitespace, ASCII control character, or backslash is unavailable;
//   (3) parse with the WHATWG `URL` constructor — a parse failure (which
//       includes a scheme-less or protocol-relative value) is unavailable;
//   (4) the parsed protocol must be exactly `https:`;
//   (5) a non-empty username or password (embedded credentials) is
//       unavailable;
//   (6) an empty hostname is unavailable (see `HAS_EXPLICIT_AUTHORITY`);
//   (7) normalize to `URL.origin` — a supplied path, query, or fragment is
//       ignored, not rejected; a default `:443` is dropped and a non-default
//       explicit port is preserved;
//   (8) the returned `href` is the origin plus the fixed application-owned
//       path `V2_CATALOGUE_PATH`, never a path taken from configuration.
// The result never contains credentials, a path other than `/tour`, a query,
// or a fragment, and the resolver never throws for any input.

/** V2's public tour-catalogue route. Never `/packages` (V2's separate planner). */
export const V2_CATALOGUE_PATH = '/tour';

export type V2CatalogueLinkResult =
  { status: 'available'; href: string } | { status: 'unavailable' };

// A fresh object per call so a caller can never mutate a shared result.
function unavailable(): V2CatalogueLinkResult {
  return { status: 'unavailable' };
}

// WHATWG "ASCII whitespace": TAB, LF, FF, CR, and SPACE. Only these are
// trimmed (rule 2); every other whitespace character — including Unicode
// spaces such as U+00A0, and VT — is rejected if it remains.
const ASCII_WHITESPACE = new Set(['\t', '\n', '\f', '\r', ' ']);

// Any Unicode whitespace character (JS `\s`), tested one character at a time.
const WHITESPACE_CHARACTER = /\s/;

// Rule 6's "empty hostname" test on the raw text. The WHATWG parser is
// lenient for special schemes: `https:///path` parses as host `path`, and
// `https:example.test` / `https:/example.test` parse as host `example.test`.
// D-052 §11 lists `https:///path` as a malformed value, so the raw text must
// carry an explicit `//` authority whose first character is not `/`, `?`, or
// `#` (i.e. a non-empty authority actually follows the `//`).
const HAS_EXPLICIT_AUTHORITY = /^https:\/\/[^/?#]/i;

function trimAsciiWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && ASCII_WHITESPACE.has(value.charAt(start))) {
    start += 1;
  }
  while (end > start && ASCII_WHITESPACE.has(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

// Rule 2's character screen. Written as a character-code loop (not a
// control-character regular expression) so it is explicit and lint-clean.
function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // ASCII control characters (U+0000–U+001F and U+007F), which include
    // an inner TAB, LF, or CR.
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
    // Backslash.
    if (code === 0x5c) {
      return true;
    }
    if (WHITESPACE_CHARACTER.test(value.charAt(index))) {
      return true;
    }
  }
  return false;
}

function resolve(rawValue: unknown): V2CatalogueLinkResult {
  // Non-string input is unavailable and is never coerced or stringified.
  if (typeof rawValue !== 'string') {
    return unavailable();
  }

  // Rule 1.
  if (rawValue.trim() === '') {
    return unavailable();
  }

  // Rule 2.
  const value = trimAsciiWhitespace(rawValue);
  if (value === '' || hasForbiddenCharacter(value)) {
    return unavailable();
  }

  // Rule 3.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return unavailable();
  }

  // Rule 4.
  if (url.protocol !== 'https:') {
    return unavailable();
  }

  // Rule 5.
  if (url.username !== '' || url.password !== '') {
    return unavailable();
  }

  // Rule 6.
  if (url.hostname === '' || !HAS_EXPLICIT_AUTHORITY.test(value)) {
    return unavailable();
  }

  // Rule 7. For an `https:` URL the origin is `https://<host>[:<port>]`; a
  // value of "null" would mean an opaque origin and is refused defensively.
  const origin = url.origin;
  if (origin === 'null') {
    return unavailable();
  }

  // Rule 8.
  return { status: 'available', href: `${origin}${V2_CATALOGUE_PATH}` };
}

/**
 * Resolves the configured V2 public-site value to the Regional Tours
 * outbound link. Pure, synchronous, and total: it accepts `unknown`, returns
 * exactly `{ status: 'available'; href }` or `{ status: 'unavailable' }`,
 * and never throws.
 */
export function resolveV2CatalogueLink(rawValue: unknown): V2CatalogueLinkResult {
  try {
    return resolve(rawValue);
  } catch {
    // Defense in depth: nothing above is expected to throw, but this
    // resolver's contract is "never throws for any input".
    return unavailable();
  }
}
