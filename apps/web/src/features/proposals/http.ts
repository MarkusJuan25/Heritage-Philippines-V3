import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { ProposalError } from './errors';

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
 * The project-standard `{ error: { code, message } }` envelope
 * (.claude/rules/backend.md's "Consistent Error Responses"), with an
 * additional field-level `details` array for validation failures
 * (frontend.md's "Surface server-side validation errors clearly,
 * field-by-field"). Mirrors features/bookings/http.ts's,
 * features/clients/http.ts's, and features/leads/http.ts's
 * identically-named function exactly.
 */
export function validationErrorResponse(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Response {
  return NextResponse.json(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: toValidationIssues(issues),
      },
    },
    { status: 400 },
  );
}

/**
 * Translates a `ProposalError` into the standard `{ error: { code,
 * message } }` envelope, using the status `errors.ts` already computed for
 * that code (D-027 §6's full controlled-error-code-to-status map) — this
 * function never duplicates or recomputes that status map itself.
 */
export function proposalErrorResponse(error: ProposalError): Response {
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}

type ParsedBody<Schema extends z.ZodTypeAny> =
  { success: true; data: z.infer<Schema> } | { success: false; response: Response };

/**
 * Parses and validates a JSON request body against `schema`
 * (.claude/rules/backend.md's "Schema Validation at External Boundaries").
 * Malformed JSON and schema violations both return the identical
 * `VALIDATION_ERROR` envelope rather than letting either throw past this
 * boundary — mirrors features/bookings/http.ts's/features/clients/http.ts's
 * `parseJsonBody` exactly, including never leaking the raw JSON parse
 * exception's own message.
 */
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
 * Parses `URLSearchParams` against `schema` — the query-string counterpart
 * to `parseJsonBody`, mirroring features/bookings/http.ts's/
 * features/clients/http.ts's `parseQuery` exactly. Used only by
 * `GET /api/proposals`'s pagination query (D-027 §6 names no other
 * query-string endpoint).
 */
export function parseQuery<Schema extends z.ZodTypeAny>(
  searchParams: URLSearchParams,
  schema: Schema,
): ParsedBody<Schema> {
  const result = schema.safeParse(Object.fromEntries(searchParams));
  if (!result.success) {
    return { success: false, response: validationErrorResponse(result.error.issues) };
  }
  return { success: true, data: result.data };
}

/**
 * Runs a Proposal service call and shapes its outcome into a Response:
 * `onSuccess(result)` on success, or the standard `ProposalError` envelope
 * on a known domain error (D-027 §6's twelve controlled codes, including
 * the anti-enumeration `PROPOSAL_NOT_FOUND`/`PROPOSAL_FORBIDDEN` and
 * `PROPOSAL_VERSION_NOT_FOUND`/`PROPOSAL_VERSION_FORBIDDEN` pairs, which
 * this function passes through completely unchanged rather than
 * collapsing). Any other error is rethrown so the outer `withRole`
 * wrapper's generic 500 handling (.claude/rules/backend.md's "No secret or
 * sensitive-error exposure") still applies — this function never inspects,
 * wraps, or logs the raw error itself, and never leaks a stack trace,
 * database detail, raw Zod internals, Proposal `content`, response
 * `evidenceReference`, or any other sensitive value into a response.
 * Mirrors features/bookings/http.ts's `runBookingAction` and
 * features/clients/http.ts's `runClientAction` exactly.
 */
export async function runProposalAction<T>(
  action: () => Promise<T>,
  onSuccess: (result: T) => Response,
): Promise<Response> {
  try {
    const result = await action();
    return onSuccess(result);
  } catch (error) {
    if (error instanceof ProposalError) {
      return proposalErrorResponse(error);
    }
    throw error;
  }
}
