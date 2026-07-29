import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { convertLeadSchema, leadIdParamSchema } from '@/features/leads/schemas';
import { convertLead } from '@/features/leads/service';
import { parseJsonBody, runLeadAction, validationErrorResponse } from '@/features/leads/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Converts a QUALIFIED Lead to a Client (D-024). ADMIN_MANAGER
// (unconditional) and TRAVEL_CONSULTANT (only through the existing
// `canAccessLead`/`canAccessClient` authorization `convertLead` already
// enforces — never duplicated here) — every other role is rejected by
// `withRole` before the handler body ever runs. POST (not PUT): unlike
// `/status`, which sets the state of a singleton sub-resource, the
// create-new path here creates a new top-level Client resource, matching
// this codebase's POST-for-creation convention (`POST /api/leads`) rather
// than PUT's set-singleton-state convention (D-024 §9's "the dedicated
// conversion workflow", distinct from `PUT /api/leads/[id]/status`).
export const POST = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = leadIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, convertLeadSchema);
    if (!body.success) {
      return body.response;
    }

    return runLeadAction(
      () => convertLead(user, idResult.data.id, body.data),
      ({ lead, client, clientCreated }) => NextResponse.json({ lead, client, clientCreated }),
    );
  },
);
