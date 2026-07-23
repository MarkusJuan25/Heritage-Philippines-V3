import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { leadIdParamSchema, updateLeadSchema } from '@/features/leads/schemas';
import { getLeadById, updateLead } from '@/features/leads/service';
import { parseJsonBody, runLeadAction, validationErrorResponse } from '@/features/leads/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Staff-only single-Lead retrieval — see the collection route's doc
// comment for the same role/scoping rationale. A TRAVEL_CONSULTANT
// requesting a Lead they are not assigned to receives the identical
// response a nonexistent id would produce (403 LEAD_FORBIDDEN), never a
// 404, so no id's existence can be inferred (D-022 §8;
// features/leads/errors.ts's LeadError doc comment).
export const GET = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = leadIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    return runLeadAction(
      () => getLeadById(user, idResult.data.id),
      (lead) => NextResponse.json({ lead }),
    );
  },
);

// Edits a Lead's ordinary fields (D-022 §3). Rejected with LEAD_LOCKED once
// the Lead is CONVERTED_TO_CLIENT. Duplicate-match fields are present in
// the response only when the patch touched `email`/`phone` (see
// features/leads/service.ts's `updateLead`).
export const PATCH = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = leadIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, updateLeadSchema);
    if (!body.success) {
      return body.response;
    }

    return runLeadAction(
      () => updateLead(user, idResult.data.id, body.data),
      ({ lead, duplicateMatches, restrictedMatchDetected }) =>
        NextResponse.json(
          duplicateMatches !== undefined
            ? { lead, duplicateMatches, restrictedMatchDetected }
            : { lead },
        ),
    );
  },
);
