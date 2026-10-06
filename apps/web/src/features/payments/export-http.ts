import { NextResponse } from 'next/server';

import type { FinanceExportResult } from './export-service';

// Transport-level helpers for `POST /api/payments/exports` (D-061 Stage 3;
// D-063). The cross-site request policy lives here, next to the route that
// applies it. It is this endpoint's policy only: no other route is changed,
// and no authentication setting is touched.

/**
 * The application's own origin, taken from the server's `BETTER_AUTH_URL`
 * — the configured base URL this app is served from, required and
 * validated at start-up (lib/env.ts). It is the only source of trust here:
 * the request's `Host`, `X-Forwarded-*`, and `Referer` headers are never
 * consulted.
 */
export type TrustedOrigin = { scheme: 'http' | 'https'; hostname: string; port: number };

const DEFAULT_PORTS = { http: 80, https: 443 } as const;

export function trustedOriginFrom(configuredBaseUrl: string): TrustedOrigin {
  const url = new URL(configuredBaseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The configured application base URL must use http or https.');
  }
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  return {
    scheme,
    hostname: url.hostname,
    port: url.port === '' ? DEFAULT_PORTS[scheme] : Number(url.port),
  };
}

// A serialized origin exactly as a browser sends it: a lowercase scheme, a
// lowercase host (DNS labels, or a bracketed IPv6 literal), and an optional
// port with no leading zero. Nothing else — no path, not even a trailing
// slash, no credentials, query, or fragment, no surrounding space, and not
// two values. A value that does not have this form is refused as it
// stands; it is never repaired into one that does.
const ORIGIN_PATTERN =
  /^(https?):\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::([1-9][0-9]{0,4}))?$/;

/**
 * Whether a request's `Origin` header names the trusted origin exactly: the
 * same scheme, the same hostname, and the same effective port (an explicit
 * default port equals an omitted one). A missing header, the literal
 * `null`, a malformed value, and any other origin all return `false`.
 */
export function isTrustedOrigin(header: string | null, trusted: TrustedOrigin): boolean {
  if (header === null) return false;
  const match = ORIGIN_PATTERN.exec(header);
  if (!match) return false;
  const scheme = match[1] as 'http' | 'https';
  const hostname = match[2]!;
  const port = match[3] === undefined ? DEFAULT_PORTS[scheme] : Number(match[3]);
  if (port > 65535) return false;
  return scheme === trusted.scheme && hostname === trusted.hostname && port === trusted.port;
}

// `application/json`, alone or with the one standard parameter,
// `charset=utf-8`. JSON is UTF-8; any other charset or parameter is refused
// rather than ignored.
const JSON_CONTENT_TYPE_PATTERN =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i;

export function isJsonContentType(header: string | null): boolean {
  return header !== null && JSON_CONTENT_TYPE_PATTERN.test(header);
}

/**
 * The refusal for a request that does not come from the application's own
 * origin. Deliberately the same body the role guard returns for a
 * forbidden role, so a caller learns nothing about why it was refused.
 */
export function forbiddenResponse(): Response {
  return NextResponse.json(
    {
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have permission to access this resource.',
      },
    },
    { status: 403 },
  );
}

export function unsupportedMediaTypeResponse(): Response {
  return NextResponse.json(
    {
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'The request body must be sent as application/json.',
      },
    },
    { status: 415 },
  );
}

/**
 * The export file as a download (D-061 §4): the service's bytes exactly as
 * it produced them, never cached and never sniffed. The filename is the
 * service's own, built only from the dataset name, format version, date
 * range, and generation time.
 */
export function financeExportResponse(result: FinanceExportResult): Response {
  const body = new Uint8Array(result.content);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
