import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { leadIdParamSchema, listLeadStatusHistoryQuerySchema } from '@/features/leads/schemas';
import { getLeadStatusHistory } from '@/features/leads/service';
import { parseQuery, runLeadAction, validationErrorResponse } from '@/features/leads/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Paginated Lead status-history read (D-023 §8). Authorized identically to
// GET /api/leads/[id]: ADMIN_MANAGER (unconditional) and TRAVEL_CONSULTANT
// (only through the existing canAccessLead), preserving the identical
// LEAD_NOT_FOUND/LEAD_FORBIDDEN anti-enumeration split (D-022 §8). Every
// other role is rejected here by `withRole` before the handler body ever
// runs. Deliberately excludes the transition `reason` — see
// features/leads/service.ts's `getLeadStatusHistory` doc comment.
export const GET = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = leadIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const url = new URL(request.url);
    const query = parseQuery(url.searchParams, listLeadStatusHistoryQuerySchema);
    if (!query.success) {
      return query.response;
    }

    return runLeadAction(
      () => getLeadStatusHistory(user, idResult.data.id, query.data),
      (result) => NextResponse.json(result),
    );
  },
);
