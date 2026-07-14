import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import {
  assignmentTargetIdParamSchema,
  endAssignmentSchema,
  setAssignmentSchema,
} from '@/features/assignments/schemas';
import { endClientAssignment, setClientAssignment } from '@/features/assignments/service';
import {
  parseJsonBody,
  runAssignmentAction,
  validationErrorResponse,
} from '@/features/assignments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Assigns or reassigns the Travel Consultant responsible for a Client
// (blueprint Section 13.3's "Assigned staff member"). Admin / Manager
// only — see the Lead assignment route's doc comment for the same
// System-Administrator-boundary and PUT-semantics rationale
// (blueprint Sections 4.1, 4.2; docs/HERITAGE_V3_DECISIONS_LOG.md D-009).
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
    () => setClientAssignment(user, idResult.data.id, body.data.assignedStaffId, body.data.reason),
    (assignment) => NextResponse.json({ assignment }),
  );
});

// Ends a Client's active assignment, preserving it as history. Admin /
// Manager only. Idempotent — see the Lead assignment route's DELETE doc
// comment.
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
      () => endClientAssignment(user, idResult.data.id, body.data.reason),
      (assignment) => NextResponse.json({ assignment }),
    );
  },
);
