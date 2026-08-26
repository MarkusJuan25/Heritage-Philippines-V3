import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { clientIdParamSchema } from '@/features/invitations/schemas';
import { getInvitationForClient, prepareInvitation } from '@/features/invitations/service';
import {
  runInvitationAction,
  toInvitationResponse,
  toNullableInvitationResponse,
  validationErrorResponse,
} from '@/features/invitations/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

const STAFF_INVITATION_ROLES = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'] as const;

// Read the current invitation state for a Client (D-034 Stage 3
// authorization: staff-facing invitation routes). Returns
// `{ invitation: null }` for a Client with no invitation row yet —
// "Not Invited" (blueprint Section 7.1) is a legitimate, non-error state,
// not a 404.
export const GET = withRole<RouteParams>(
  [...STAFF_INVITATION_ROLES],
  async (_request, { user, params }) => {
    const idResult = clientIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    return runInvitationAction(
      () => getInvitationForClient(user, idResult.data.id),
      (invitation) => NextResponse.json({ invitation: toNullableInvitationResponse(invitation) }),
    );
  },
);

// Prepare (D-034 Section 3): creates the invitation record with no token
// yet generated. Idempotent no-op if one already exists in
// INVITATION_PREPARED — see features/invitations/service.ts.
export const POST = withRole<RouteParams>(
  [...STAFF_INVITATION_ROLES],
  async (_request, { user, params }) => {
    const idResult = clientIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    return runInvitationAction(
      () => prepareInvitation(user, idResult.data.id),
      (invitation) =>
        NextResponse.json({ invitation: toInvitationResponse(invitation) }, { status: 201 }),
    );
  },
);
