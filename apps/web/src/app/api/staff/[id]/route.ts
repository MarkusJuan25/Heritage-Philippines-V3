import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { changeStaffRoleSchema, staffAccountIdParamSchema } from '@/features/staff/schemas';
import { changeStaffRole, getStaffAccountById } from '@/features/staff/service';
import { parseJsonBody, runStaffAction, validationErrorResponse } from '@/features/staff/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// A single staff account's details, and its role assignment (blueprint
// Section 4.1: "assign roles to staff accounts"). System Administrator
// only — see docs/HERITAGE_V3_DECISIONS_LOG.md D-012.
export const GET = withRole<RouteParams>(['SYSTEM_ADMINISTRATOR'], async (_request, { params }) => {
  const idResult = staffAccountIdParamSchema.safeParse(await params);
  if (!idResult.success) {
    return validationErrorResponse(idResult.error.issues);
  }

  return runStaffAction(
    () => getStaffAccountById(idResult.data.id),
    (account) => NextResponse.json({ account }),
  );
});

export const PATCH = withRole<RouteParams>(
  ['SYSTEM_ADMINISTRATOR'],
  async (request, { user, params }) => {
    const idResult = staffAccountIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, changeStaffRoleSchema);
    if (!body.success) {
      return body.response;
    }

    return runStaffAction(
      () => changeStaffRole(user, idResult.data.id, body.data.role),
      (account) => NextResponse.json({ account }),
    );
  },
);
