// D-037 Section 12: the default-deny request-source resolver for
// activation rate limiting. Every proxy-supplied header (`X-Forwarded-For`,
// `X-Real-IP`, or any other) is ignored unconditionally unless
// `trustConfig.trustedHeaderName` is explicitly set — which no caller in
// this codebase does yet, in any environment. The two Section 12
// deployment gates (verified Hostinger proxy-hop behavior; verified
// access-log behavior for `/activate/*`) remain open, so activation must
// not be exposed in staging or production regardless of this stage's
// completion.

export type ResolvedSource = { trusted: true; identifier: string } | { trusted: false };

export type SourceTrustConfig = {
  trustedHeaderName?: string;
  trustedProxyHopCount?: number;
};

// Only the one method this module needs — deliberately not the full DOM
// `Headers` type, so both a Route Handler's `Request.headers` and a Server
// Component's `await headers()` from `next/headers` (a `ReadonlyHeaders`,
// structurally compatible but not nominally the same type) satisfy this
// without a cast. D-037 Section 12 illustrates `resolveRequestSource`
// taking a `Request` directly; `/activate/[token]`'s Server Component has
// no `Request` object available at all (Next.js's App Router convention),
// so this narrower parameter type is this implementation's necessary,
// deliberate adaptation of that illustrative signature — not a silent
// deviation.
export type HeadersLike = { get(name: string): string | null };

const IPV6_ZONE_PATTERN = /%.*$/;
const IPV4_MAPPED_IPV6_PATTERN = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/**
 * Normalizes a resolved source identifier before it is ever used as an
 * HMAC input (D-037 Section 12): lowercased; an IPv6 zone identifier
 * stripped (`fe80::1%eth0` -> `fe80::1`); an IPv4-mapped IPv6 form
 * collapsed to its IPv4 equivalent (`::ffff:203.0.113.7` -> `203.0.113.7`).
 */
export function normalizeSourceIdentifier(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  const withoutZone = lowered.replace(IPV6_ZONE_PATTERN, '');
  const mapped = IPV4_MAPPED_IPV6_PATTERN.exec(withoutZone);
  // Capture group 1 always exists whenever the whole pattern matches — the
  // group is not optional in IPV4_MAPPED_IPV6_PATTERN.
  return mapped ? mapped[1]! : withoutZone;
}

/**
 * Resolves the request's source identifier under a strictly caller-supplied
 * trust configuration (D-037 Section 12). `trustConfig` is never derived
 * from `process.env.NODE_ENV`, a header, or any other request-controlled
 * value — a request can never flip its own trust — so test code exercises
 * the trusted branch only by passing an explicit permissive configuration
 * directly, exactly mirroring how production callers would once a verified
 * configuration exists (not authorized by this entry).
 *
 * When a trusted header is configured, `trustedProxyHopCount` (default 0)
 * is the number of trusted proxies presumed to have appended their own
 * entry to a comma-separated header (e.g. `X-Forwarded-For`, which appends
 * each hop's own address after the original client value). The entry
 * `trustedProxyHopCount` positions from the end of that list is the
 * client-controlled identifier to trust. A single-valued header with the
 * default hop count of 0 returns that one value directly. A hop count
 * that exceeds the number of entries present fails closed to
 * `{ trusted: false }` rather than guessing at a value.
 */
export function resolveRequestSource(
  headers: HeadersLike,
  trustConfig: SourceTrustConfig,
): ResolvedSource {
  if (!trustConfig.trustedHeaderName) {
    return { trusted: false };
  }

  const headerValue = headers.get(trustConfig.trustedHeaderName);
  if (!headerValue) {
    return { trusted: false };
  }

  const parts = headerValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return { trusted: false };
  }

  const hopCount = trustConfig.trustedProxyHopCount ?? 0;
  const index = parts.length - 1 - hopCount;
  if (index < 0 || index >= parts.length) {
    return { trusted: false };
  }

  // Bounds already verified above.
  return { trusted: true, identifier: normalizeSourceIdentifier(parts[index]!) };
}
