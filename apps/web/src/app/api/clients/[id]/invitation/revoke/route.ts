import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { clientIdParamSchema, revokeInvitationSchema } from '@/features/invitations/schemas';
import { revokeInvitation } from '@/features/invitations/service';
import {
  parseJsonBody,
  runInvitationAction,
  toInvitationResponse,
  validationErrorResponse,
} from '@/features/invitations/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Revoke (D-034 Sections 3, 9; admin-dashboard.md's "Destructive and
// Irreversible Actions" — requires an explicit reason). Idempotent no-op
// if already revoked.
export const POST = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = clientIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, revokeInvitationSchema);
    if (!body.success) {
      return body.response;
    }

    return runInvitationAction(
      () => revokeInvitation(user, idResult.data.id, body.data.reason),
      (invitation) => NextResponse.json({ invitation: toInvitationResponse(invitation) }),
    );
  },
);
