import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import {
  assignmentTargetIdParamSchema,
  endAssignmentSchema,
  setAssignmentSchema,
} from '@/features/assignments/schemas';
import { endLeadAssignment, setLeadAssignment } from '@/features/assignments/service';
import {
  parseJsonBody,
  runAssignmentAction,
  validationErrorResponse,
} from '@/features/assignments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Assigns or reassigns the Travel Consultant responsible for a Lead
// (blueprint Section 6.4). Admin / Manager only — Section 4.2 grants lead
// assignment management to Admin / Manager; System Administrator does not
// automatically receive this operational capability (blueprint Section
// 4.1's explicit boundary — see docs/HERITAGE_V3_DECISIONS_LOG.md D-009).
// PUT (not POST): this endpoint sets/replaces the state of a singleton
// sub-resource — "the Lead's current assignment" — rather than creating a
// new top-level resource each call.
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
    () => setLeadAssignment(user, idResult.data.id, body.data.assignedStaffId, body.data.reason),
    (assignment) => NextResponse.json({ assignment }),
  );
});

// Ends a Lead's active assignment, preserving it as history (`endedAt` set,
// never deleted). Admin / Manager only. Idempotent: if nothing is
// currently active, this returns `{ assignment: null }` rather than an
// error, and never writes a duplicate audit entry.
export const DELETE = withRole<RouteParams>(
  ['ADMIN_MANAGER'],
  async (request, { user, params }) => {
    const idResult = assignmentTargetIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, endAssignmentSchema);
    if (!body.success) {
      return body.response;
    }

    return runAssignmentAction(
      () => endLeadAssignment(user, idResult.data.id, body.data.reason),
      (assignment) => NextResponse.json({ assignment }),
    );
  },
);
