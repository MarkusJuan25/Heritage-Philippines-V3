import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { getServerEnv } from '@/lib/env';

import { ActivationError } from './errors';

// This feature's own request/response helpers, mirroring
// `features/invitations/http.ts`, `features/staff/http.ts`, and
// `features/assignments/http.ts`'s identical `{ error: { code, message } }`
// envelope convention (.claude/rules/backend.md's "Consistent Error
// Responses") — each feature owns its own small copy of this shape rather
// than a shared utility, matching this repository's established
// precedent. D-034 Stage 5d (D-037 Section 10): Origin, media-type, and
// bounded-body processing now implemented here; rate-limit checks
// themselves live in `./rate-limit.ts` and `./source.ts`, wired in by the
// two POST routes only, in the exact order D-037 Section 10 requires —
// this module only provides the individual gate functions and their fixed
// response envelopes. The GET page performs no rate-limit check of any
// kind (D-038 Section 3).

type ValidationIssue = { path: string; message: string };

function toValidationIssues(
  issues: readonly { path: PropertyKey[]; message: string }[],
): ValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Every response this feature returns carries `Cache-Control: no-store`
 * and `Referrer-Policy: no-referrer` (D-034 Section 5; D-037 Section 13) —
 * applied here, once, so every route in this feature passes its response
 * through this function rather than risking an inconsistent header set on
 * one code path.
 */
function withActivationHeaders(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export function jsonResponse(body: unknown, status: number): NextResponse {
  return withActivationHeaders(NextResponse.json(body, { status }));
}

export function validationErrorResponse(
  issues: readonly { path: PropertyKey[]; message: string }[],
): NextResponse {
  return jsonResponse(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: toValidationIssues(issues),
      },
    },
    400,
  );
}

/** D-037 Section 3's fixed Origin-rejection envelope, verbatim. */
export function forbiddenResponse(): NextResponse {
  return jsonResponse({ error: { code: 'FORBIDDEN', message: 'Request rejected.' } }, 403);
}

/** D-037 Section 3's fixed rate-limit-rejection envelope, verbatim. */
export function rateLimitedResponse(): NextResponse {
  return jsonResponse(
    { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } },
    429,
  );
}

export function activationErrorResponse(error: ActivationError): NextResponse {
  return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
}

type GateResult = { ok: true } | { ok: false; response: NextResponse };

/**
 * D-037 Section 10, step (1)-(2): requires an `Origin` header and compares
 * it, both sides parsed via `new URL(...).origin`, against this
 * environment's own `BETTER_AUTH_URL`. A missing, malformed, or mismatched
 * Origin is rejected identically — before any database or rate-limit
 * table access of any kind (this function performs no I/O itself; callers
 * are responsible for running it first).
 */
export function checkOrigin(request: Request): GateResult {
  const originHeader = request.headers.get('origin');
  if (!originHeader) {
    return { ok: false, response: forbiddenResponse() };
  }

  let expectedOrigin: string;
  let actualOrigin: string;
  try {
    expectedOrigin = new URL(getServerEnv().BETTER_AUTH_URL).origin;
    actualOrigin = new URL(originHeader).origin;
  } catch {
    return { ok: false, response: forbiddenResponse() };
  }

  if (actualOrigin !== expectedOrigin) {
    return { ok: false, response: forbiddenResponse() };
  }
  return { ok: true };
}

// Case-insensitive `application/json`, with either no parameter or exactly
// one `charset` parameter (D-037 Section 10, step 3).
const CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=[\w-]+)?$/i;

/** D-037 Section 10, step (3). */
export function checkContentType(request: Request): GateResult {
  const contentType = request.headers.get('content-type');
  if (!contentType || !CONTENT_TYPE_PATTERN.test(contentType.trim())) {
    return {
      ok: false,
      response: validationErrorResponse([
        { path: [], message: 'Content-Type must be application/json.' },
      ]),
    };
  }
  return { ok: true };
}

// One 24-character token plus two passwords capped at 200 characters each,
// with ample headroom for JSON structural overhead (D-037 Section 10).
export const MAX_BODY_BYTES = 4096;

/**
 * D-037 Section 10, step (4): a declared `Content-Length` that is
 * malformed, negative, non-numeric, or greater than `MAX_BODY_BYTES` is
 * rejected without reading any body bytes. An absent header is allowed
 * here — `readBoundedBody` below enforces the real cap on actual bytes
 * regardless of what (or whether) `Content-Length` claims.
 */
export function checkDeclaredContentLength(request: Request): GateResult {
  const raw = request.headers.get('content-length');
  if (raw === null) {
    return { ok: true };
  }
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      response: validationErrorResponse([
        { path: [], message: 'Content-Length must be a valid non-negative integer.' },
      ]),
    };
  }
  const declared = Number(raw);
  if (!Number.isSafeInteger(declared) || declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: validationErrorResponse([
        { path: [], message: `Request body must not exceed ${MAX_BODY_BYTES} bytes.` },
      ]),
    };
  }
  return { ok: true };
}

type BoundedBodyResult = { ok: true; text: string } | { ok: false; response: NextResponse };

/**
 * D-037 Section 10, step (6): reads the body via a manual byte-counting
 * stream reader enforcing an actual `MAX_BODY_BYTES` cap, effective
 * regardless of whether `Content-Length` was present, absent,
 * understated, or the request used chunked transfer encoding — the read
 * is aborted and the request rejected the instant cumulative bytes
 * exceed the cap.
 */
export async function readBoundedBody(request: Request): Promise<BoundedBodyResult> {
  if (!request.body) {
    return { ok: true, text: '' };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          return {
            ok: false,
            response: validationErrorResponse([
              { path: [], message: `Request body must not exceed ${MAX_BODY_BYTES} bytes.` },
            ]),
          };
        }
        chunks.push(value);
      }
    }
  } catch {
    return {
      ok: false,
      response: validationErrorResponse([
        { path: [], message: 'Request body must be valid JSON.' },
      ]),
    };
  }

  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return { ok: true, text };
}

type ParsedBody<Schema extends z.ZodTypeAny> =
  { success: true; data: z.infer<Schema> } | { success: false; response: NextResponse };

/**
 * D-037 Section 10, step (7): parses and structurally validates
 * already-read, already-bounded body text (`readBoundedBody`'s output) —
 * this function performs no I/O and no longer reads the request itself,
 * so the byte cap above is always enforced first regardless of caller.
 */
export function parseJsonBody<Schema extends z.ZodTypeAny>(
  text: string,
  schema: Schema,
): ParsedBody<Schema> {
  let json: unknown;
  try {
    json = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    return {
      success: false,
      response: validationErrorResponse([
        { path: [], message: 'Request body must be valid JSON.' },
      ]),
    };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    return { success: false, response: validationErrorResponse(result.error.issues) };
  }
  return { success: true, data: result.data };
}

/**
 * Runs an activation service call and shapes its outcome into a Response
 * — `onSuccess(result)` on success, or the standard `ActivationError`
 * envelope on the one domain error this feature ever throws. Any other
 * error is rethrown so Next.js's own default error handling applies —
 * this feature has no `withRole`-style outer wrapper, since every one of
 * its routes is deliberately unauthenticated.
 */
export async function runActivationAction<T>(
  action: () => Promise<T>,
  onSuccess: (result: T) => NextResponse,
): Promise<NextResponse> {
  try {
    const result = await action();
    return onSuccess(result);
  } catch (error) {
    if (error instanceof ActivationError) {
      return activationErrorResponse(error);
    }
    throw error;
  }
}
