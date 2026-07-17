import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { assignmentTargetIdParamSchema, setAssignmentSchema } from '@/features/assignments/schemas';
import { setBookingAssignment } from '@/features/assignments/service';
import {
  parseJsonBody,
  runAssignmentAction,
  validationErrorResponse,
} from '@/features/assignments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Assigns or reassigns the Travel Consultant responsible for a Booking
// (blueprint Section 4.2's "manage staff accounts' operational role
// assignments and lead/client/booking assignments"). Admin / Manager only
// — see the Lead/Client assignment routes' doc comments for the same
// System-Administrator-boundary and PUT-semantics rationale (blueprint
// Sections 4.1, 4.2; docs/HERITAGE_V3_DECISIONS_LOG.md D-009). Independent
// of any Client-level assignment on this Booking's Client — the assignee
// need not already hold the Client assignment, and no cascade applies in
// either direction (see the Booking-assignment decision). No DELETE
// endpoint exists here: removal without a replacement is out of scope for
// this checkpoint.
export const PUT = withRole<RouteParams>(['ADMIN_MANAGER'], async (request, { user, params }) => {
  const idResult = assignmentTargetIdParamSchema.safeParse(await params);
  if (!idResult.success) {
    return validationErrorResponse(idResult.error.issues);
  }

  const body = await parseJsonBody(request, setAssignmentSchema);
  if (!body.success) {
    return body.response;
  }

  return runAssignmentAction(
    () => setBookingAssignment(user, idResult.data.id, body.data.assignedStaffId, body.data.reason),
    (assignment) => NextResponse.json({ assignment }),
  );
});
