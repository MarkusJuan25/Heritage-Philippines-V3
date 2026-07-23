import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { leadIdParamSchema, updateLeadStatusSchema } from '@/features/leads/schemas';
import { updateLeadStatus } from '@/features/leads/service';
import { parseJsonBody, runLeadAction, validationErrorResponse } from '@/features/leads/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Transitions a Lead's status (D-022 §6/§7). ADMIN_MANAGER (unconditional)
// and TRAVEL_CONSULTANT (only through the existing `canAccessLead`
// authorization) — every other role is rejected here by `withRole` before
// the handler body ever runs. PUT (not PATCH): sets the state of a
// singleton sub-resource — "this Lead's current status" — matching this
// codebase's `/api/bookings/[id]/status` and
// `/api/leads/[id]/assignment` convention.
export const PUT = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = leadIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, updateLeadStatusSchema);
    if (!body.success) {
      return body.response;
    }

    return runLeadAction(
      () => updateLeadStatus(user, idResult.data.id, body.data),
      (lead) => NextResponse.json({ lead }),
    );
  },
);
