import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { clientIdParamSchema } from '@/features/invitations/schemas';
import { confirmManualSend } from '@/features/invitations/service';
import {
  parseIdempotencyKeyHeader,
  runInvitationAction,
  toInvitationResponse,
  validationErrorResponse,
} from '@/features/invitations/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Confirm-manual-sent (D-034 Sections 2(c), 9, 10) — the explicit, separate
// staff action attesting a manually-copied invitation link was actually
// emailed. No body: the confirming identity and timestamp come from the
// authenticated actor and the server clock, never from the request.
// Requires a client-supplied `Idempotency-Key` header (a validated UUID,
// Stage 3 Correction and Security Review Pass 1 §2), stored as this
// confirmation's own `sendOperationId`. Idempotent no-op if already
// confirmed, regardless of which key a retry supplies.
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

    return runInvitationAction(
      () => confirmManualSend(user, idResult.data.id, idempotencyKey.value),
      (invitation) => NextResponse.json({ invitation: toInvitationResponse(invitation) }),
    );
  },
);
