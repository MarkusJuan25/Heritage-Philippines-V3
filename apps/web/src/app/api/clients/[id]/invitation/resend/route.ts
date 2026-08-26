import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { clientIdParamSchema, resendInvitationSchema } from '@/features/invitations/schemas';
import { resendInvitation } from '@/features/invitations/service';
import {
  parseIdempotencyKeyHeader,
  parseJsonBody,
  runInvitationAction,
  toSendResultResponse,
  validationErrorResponse,
} from '@/features/invitations/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Explicit resend/reissue (D-034 Sections 4, 9) — from INVITATION_SENT,
// INVITATION_OPENED, or INVITATION_EXPIRED; always rotates the token.
// Requires a fresh `Idempotency-Key` header UUID for this new deliberate
// action (D-034 Stage 3 Section 5) — never the same key used for an
// earlier send/resend. Also requires `expectedCurrentSendOperationId` and
// `expectedUpdatedAt` in the body (Stage 3 Correction and Security Review
// Pass 1 §3) — the exact `sendOperationId`/`updatedAt` the caller last
// observed via `GET /api/clients/[id]/invitation` — so a delayed retry of
// a superseded resend is rejected with a stable 409
// (INVITATION_SEND_OPERATION_STALE) instead of silently rotating the
// token again or clobbering a newer resend's delivery evidence.
export const POST = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = clientIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const idempotencyKey = parseIdempotencyKeyHeader(request);
    if (!idempotencyKey.success) {
      return idempotencyKey.response;
    }

    const body = await parseJsonBody(request, resendInvitationSchema);
    if (!body.success) {
      return body.response;
    }

    return runInvitationAction(
      () =>
        resendInvitation(
          user,
          idResult.data.id,
          {
            deliveryMethod: body.data.deliveryMethod,
            idempotencyKey: idempotencyKey.value,
          },
          {
            expectedCurrentSendOperationId: body.data.expectedCurrentSendOperationId,
            expectedUpdatedAt: new Date(body.data.expectedUpdatedAt),
          },
        ),
      (result) => NextResponse.json(toSendResultResponse(result)),
    );
  },
);
