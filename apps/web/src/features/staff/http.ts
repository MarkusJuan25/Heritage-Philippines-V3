import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { StaffManagementError } from './errors';

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
 * field-by-field").
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

export function staffManagementErrorResponse(error: StaffManagementError): Response {
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
 * Malformed JSON and schema violations both return the same
 * VALIDATION_ERROR envelope rather than letting either throw past this
 * boundary.
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
 * to `parseJsonBody`.
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
 * Runs a staff-management service call and shapes its outcome into a
 * Response: `onSuccess(result)` on success, or the standard
 * StaffManagementError envelope on a known domain error. Any other error
 * is rethrown so the outer `withRole` wrapper's generic 500 handling
 * (.claude/rules/backend.md's "No secret or sensitive-error exposure")
 * still applies — this only special-cases the named business-rule
 * outcomes.
 */
export async function runStaffAction<T>(
  action: () => Promise<T>,
  onSuccess: (result: T) => Response,
): Promise<Response> {
  try {
    const result = await action();
    return onSuccess(result);
  } catch (error) {
    if (error instanceof StaffManagementError) {
      return staffManagementErrorResponse(error);
    }
    throw error;
  }
}
