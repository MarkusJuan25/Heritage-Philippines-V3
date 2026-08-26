import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { clientIdParamSchema, sendInvitationSchema } from '@/features/invitations/schemas';
import { sendInvitation } from '@/features/invitations/service';
import {
  parseIdempotencyKeyHeader,
  parseJsonBody,
  runInvitationAction,
  toSendResultResponse,
  validationErrorResponse,
} from '@/features/invitations/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// First send (D-034 Sections 2, 4, 9) — only from INVITATION_PREPARED.
// Requires a client-supplied `Idempotency-Key` header (a validated UUID,
// D-034 Stage 3 Section 5): the caller generates one UUID per deliberate
// send action and reuses that exact value only when retrying that same
// action.
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

    const body = await parseJsonBody(request, sendInvitationSchema);
    if (!body.success) {
      return body.response;
    }

    return runInvitationAction(
      () =>
        sendInvitation(user, idResult.data.id, {
          deliveryMethod: body.data.deliveryMethod,
          idempotencyKey: idempotencyKey.value,
        }),
      (result) => NextResponse.json(toSendResultResponse(result)),
    );
  },
);
