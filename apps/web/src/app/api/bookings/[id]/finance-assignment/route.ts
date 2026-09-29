import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import {
  assignmentTargetIdParamSchema,
  endAssignmentSchema,
  setAssignmentSchema,
} from '@/features/assignments/schemas';
import {
  endBookingFinanceAssignment,
  setBookingFinanceAssignment,
} from '@/features/assignments/service';
import {
  parseJsonBody,
  runAssignmentAction,
  validationErrorResponse,
} from '@/features/assignments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// D-056 §1: Admin/Manager sets, replaces, or ends a Booking's
// Finance/Accounting assignment. The service owns eligibility, the reason
// rules, idempotent no-ops, and the distinct BOOKING_FINANCE_ASSIGNMENT_*
// audit actions; it never touches the Travel Consultant assignment, which
// keeps its own `PUT /api/bookings/[id]/assignment`.
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
    () =>
      setBookingFinanceAssignment(
        user,
        idResult.data.id,
        body.data.assignedStaffId,
        body.data.reason,
      ),
    (assignment) => NextResponse.json({ assignment }),
  );
});

// Ending requires a reason and, in the UI, an explicit confirmation step
// (D-056 §1; .claude/rules/admin-dashboard.md). `assignment` is null when
// none was active.
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
      () => endBookingFinanceAssignment(user, idResult.data.id, body.data.reason),
      (assignment) => NextResponse.json({ assignment }),
    );
  },
);
