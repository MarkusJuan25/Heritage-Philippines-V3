import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { staffAccountIdParamSchema } from '@/features/staff/schemas';
import { reactivateStaffAccount } from '@/features/staff/service';
import { runStaffAction, validationErrorResponse } from '@/features/staff/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Reactivates a previously deactivated staff account. System
// Administrator only.
export const POST = withRole<RouteParams>(
  ['SYSTEM_ADMINISTRATOR'],
  async (_request, { user, params }) => {
    const idResult = staffAccountIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    return runStaffAction(
      () => reactivateStaffAccount(user, idResult.data.id),
      (account) => NextResponse.json({ account }),
    );
  },
);
