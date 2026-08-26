import { NextResponse } from 'next/server';
import type { z } from 'zod';

import { InvitationError } from './errors';
import type { InvitationRecord } from './repository';
import { idempotencyKeySchema } from './schemas';
import type { SendResult } from './service';

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
 * (.claude/rules/backend.md's "Consistent Error Responses"). Mirrors
 * features/staff/http.ts and features/assignments/http.ts identically.
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
 * Strips `tokenHash` from an invitation record before it is ever
 * serialized into an API response (Stage 3 Correction and Security
 * Review Pass 1 §5: `tokenHash` is not itself the raw, replayable token —
 * it's a one-way SHA-256 digest — but the review explicitly requires it
 * excluded from every response regardless, as defense-in-depth: it serves
 * no purpose to a staff caller and reducing what leaves the server is
 * strictly better than not. Every route in this feature must pass its
 * response through this function (or `toNullableInvitationResponse`/
 * `toSendResultResponse` below) rather than serializing a raw
 * `InvitationRecord` directly.
 */
export function toInvitationResponse(
  record: InvitationRecord,
): Omit<InvitationRecord, 'tokenHash'> {
  // An explicit allow-list, not a destructure-and-omit — mirrors
  // features/invitations/audit.ts's `sanitizeInvitationSnapshot` and
  // features/staff/audit.ts's `sanitizeAccountSnapshot`: naming every
  // field that IS returned means a future field added to
  // `InvitationRecord` is excluded by default, never leaked by omission.
  return {
    id: record.id,
    clientId: record.clientId,
    status: record.status,
    expiresAt: record.expiresAt,
    destinationEmail: record.destinationEmail,
    deliveryMethod: record.deliveryMethod,
    deliveryState: record.deliveryState,
    sendOperationId: record.sendOperationId,
    providerMessageId: record.providerMessageId,
    deliveryConfirmedAt: record.deliveryConfirmedAt,
    deliveryConfirmedByStaffId: record.deliveryConfirmedByStaffId,
    sentAt: record.sentAt,
    openedAt: record.openedAt,
    activatedAt: record.activatedAt,
    revokedAt: record.revokedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** `toInvitationResponse`, null-safe — for `GET /api/clients/[id]/invitation`, where "no invitation yet" (blueprint Section 7.1's "Not Invited") is a legitimate `null`, not an error. */
export function toNullableInvitationResponse(
  record: InvitationRecord | null,
): Omit<InvitationRecord, 'tokenHash'> | null {
  return record ? toInvitationResponse(record) : null;
}

/** The same `tokenHash` stripping, applied to a `sendInvitation`/`resendInvitation` result — `manualInvitationUrl`, when present, passes through unchanged (it is the one authorized exception, D-034 Stage 3 Correction Pass 1 §2). */
export function toSendResultResponse(
  result: SendResult,
): Omit<SendResult, 'invitation'> & { invitation: Omit<InvitationRecord, 'tokenHash'> } {
  return { ...result, invitation: toInvitationResponse(result.invitation) };
}

export function invitationErrorResponse(error: InvitationError): Response {
  return NextResponse.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}

type ParsedBody<Schema extends z.ZodTypeAny> =
  { success: true; data: z.infer<Schema> } | { success: false; response: Response };

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

type ParsedIdempotencyKey =
  { success: true; value: string } | { success: false; response: Response };

/**
 * Reads and validates the `Idempotency-Key` header required on every
 * send/resend request (D-034 Stage 3 Section 5). Missing or malformed
 * (not a UUID) both produce the standard VALIDATION_ERROR envelope, never
 * a silently-generated fallback key — the caller is the one source of
 * truth for "is this the same deliberate action being retried."
 */
export function parseIdempotencyKeyHeader(request: Request): ParsedIdempotencyKey {
  const raw = request.headers.get('Idempotency-Key');
  if (!raw) {
    return {
      success: false,
      response: validationErrorResponse([
        { path: ['Idempotency-Key'], message: 'Idempotency-Key header is required.' },
      ]),
    };
  }
  const result = idempotencyKeySchema.safeParse(raw);
  if (!result.success) {
    return { success: false, response: validationErrorResponse(result.error.issues) };
  }
  return { success: true, value: result.data };
}

/**
 * Runs an invitation-management service call and shapes its outcome into a
 * Response: `onSuccess(result)` on success, or the standard InvitationError
 * envelope on a known domain error. Any other error is rethrown so the
 * outer `withRole` wrapper's generic 500 handling still applies. Mirrors
 * features/assignments/http.ts's `runAssignmentAction` exactly.
 */
export async function runInvitationAction<T>(
  action: () => Promise<T>,
  onSuccess: (result: T) => Response,
): Promise<Response> {
  try {
    const result = await action();
    return onSuccess(result);
  } catch (error) {
    if (error instanceof InvitationError) {
      return invitationErrorResponse(error);
    }
    throw error;
  }
}
