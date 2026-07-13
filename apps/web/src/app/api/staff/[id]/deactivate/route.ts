import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { deactivateStaffAccountSchema, staffAccountIdParamSchema } from '@/features/staff/schemas';
import { deactivateStaffAccount } from '@/features/staff/service';
import { parseJsonBody, runStaffAction, validationErrorResponse } from '@/features/staff/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Deactivates a staff account (blueprint Section 4.1: "deactivate platform
// user accounts"). A dedicated action endpoint, not an overloaded PATCH,
// so an admin-dashboard confirmation step (admin-dashboard.md's
// "Destructive and Irreversible Actions") can target it directly and so
// its required `reason` field has an unambiguous single purpose. System
// Administrator only.
export const POST = withRole<RouteParams>(
  ['SYSTEM_ADMINISTRATOR'],
  async (request, { user, params }) => {
    const idResult = staffAccountIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, deactivateStaffAccountSchema);
    if (!body.success) {
      return body.response;
    }

    return runStaffAction(
      () => deactivateStaffAccount(user, idResult.data.id, body.data.reason),
      (account) => NextResponse.json({ account }),
    );
  },
);
