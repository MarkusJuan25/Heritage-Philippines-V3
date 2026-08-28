import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { ActivationError } from './errors';

// This feature's own request/response helpers, mirroring
// `features/invitations/http.ts`, `features/staff/http.ts`, and
// `features/assignments/http.ts`'s identical `{ error: { code, message } }`
// envelope convention (.claude/rules/backend.md's "Consistent Error
// Responses") — each feature owns its own small copy of this shape rather
// than a shared utility, matching this repository's established
// precedent. Deliberately omits Origin/media-type/body-size gating and
// rate-limit handling here — both belong to D-034 Stage 5d
// (docs/HERITAGE_V3_DECISIONS_LOG.md D-037 Section 17), not this stage.

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

export function activationErrorResponse(error: ActivationError): NextResponse {
  return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
}

type ParsedBody<Schema extends z.ZodTypeAny> =
  { success: true; data: z.infer<Schema> } | { success: false; response: NextResponse };

export async function parseJsonBody<Schema extends z.ZodTypeAny>(
  request: Request,
  schema: Schema,
): Promise<ParsedBody<Schema>> {
  let json: unknown;
  try {
    json = await request.json();
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
