import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { listEligibleTravelConsultantsQuerySchema } from '@/features/assignments/schemas';
import { listEligibleTravelConsultants } from '@/features/assignments/service';
import { parseQuery, runAssignmentAction } from '@/features/assignments/http';

export const runtime = 'nodejs';

// Eligible-assignee read for the Lead assignment picker (D-023 §6).
// ADMIN_MANAGER only — SYSTEM_ADMINISTRATOR is deliberately excluded from
// this operational read (blueprint Section 4.1; D-009(c)). The service
// layer (listEligibleTravelConsultants's assertAssignmentActor)
// independently re-checks the actor's role rather than relying solely on
// this route guard. Read-only: does not alter assignment mutation
// behavior (PUT/DELETE /api/leads/[id]/assignment remain unchanged).
export const GET = withRole(['ADMIN_MANAGER'], async (request, { user }) => {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams, listEligibleTravelConsultantsQuerySchema);
  if (!query.success) {
    return query.response;
  }

  return runAssignmentAction(
    () => listEligibleTravelConsultants(user, query.data),
    (result) => NextResponse.json(result),
  );
});
