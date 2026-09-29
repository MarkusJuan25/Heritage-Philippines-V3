import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { PaymentError } from './errors';

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
 * (.claude/rules/backend.md's "Consistent Error Responses"), with a
 * field-level `details` array for validation failures. Mirrors
 * features/bookings/http.ts's identically-named function (D-054 §10: a
 * dedicated payments `http.ts`, mirroring `bookings/http.ts`).
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

export function paymentErrorResponse(error: PaymentError): Response {
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}

type ParsedBody<Schema extends z.ZodTypeAny> =
  { success: true; data: z.infer<Schema> } | { success: false; response: Response };

/**
 * Parses a JSON request body and validates it against `schema`
 * (.claude/rules/backend.md's "Schema Validation at External Boundaries").
 * `pathValues` — route parameters such as a plan or payment id — are merged
 * over the body before validation, so `schema` validates them too and a
 * body can never substitute a different target id for the one in the URL.
 * Malformed
 * JSON, a non-object body, and schema violations all return the same
 * VALIDATION_ERROR envelope.
 */
export async function parseJsonBody<Schema extends z.ZodTypeAny>(
  request: Request,
  schema: Schema,
  pathValues: Record<string, string> = {},
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

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return {
      success: false,
      response: validationErrorResponse([
        { path: [], message: 'Request body must be a JSON object.' },
      ]),
    };
  }

  const result = schema.safeParse({ ...json, ...pathValues });
  if (!result.success) {
    return { success: false, response: validationErrorResponse(result.error.issues) };
  }
  return { success: true, data: result.data };
}

/**
 * Runs a payments service call and shapes its outcome into a Response:
 * `onSuccess(result)` on success, or the standard PaymentError envelope on a
 * known domain error. Any other error — including a CHECK-constraint
 * violation, which stays a generic error (D-055) — is rethrown so the outer
 * `withRole` wrapper's generic 500 handling still applies.
 */
export async function runPaymentAction<T>(
  action: () => Promise<T>,
  onSuccess: (result: T) => Response,
): Promise<Response> {
  try {
    const result = await action();
    return onSuccess(result);
  } catch (error) {
    if (error instanceof PaymentError) {
      return paymentErrorResponse(error);
    }
    throw error;
  }
}
