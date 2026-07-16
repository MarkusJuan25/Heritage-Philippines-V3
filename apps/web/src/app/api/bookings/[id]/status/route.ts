import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { bookingIdParamSchema, updateBookingStatusSchema } from '@/features/bookings/schemas';
import { updateBookingStatus } from '@/features/bookings/service';
import { parseJsonBody, runBookingAction, validationErrorResponse } from '@/features/bookings/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Transitions a Booking's status (docs/HERITAGE_V3_DECISIONS_LOG.md D-014).
// ADMIN_MANAGER (unconditional) and TRAVEL_CONSULTANT (only through the
// existing active-Client-assignment authorization, enforced inside
// updateBookingStatus/repository.ts) — every other role is rejected here by
// `withRole` before the handler body ever runs. PUT (not PATCH): sets the
// state of a singleton sub-resource — "this Booking's current status" —
// matching this codebase's `/api/clients/[id]/assignment` and
// `/api/leads/[id]/assignment` convention. No `reason` field is accepted
// (D-014 explicitly defers it).
export const PUT = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = bookingIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, updateBookingStatusSchema);
    if (!body.success) {
      return body.response;
    }

    return runBookingAction(
      () => updateBookingStatus(user, idResult.data.id, body.data),
      (booking) => NextResponse.json({ booking }),
    );
  },
);
