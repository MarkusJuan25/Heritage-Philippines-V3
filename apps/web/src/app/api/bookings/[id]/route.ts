import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { bookingIdParamSchema } from '@/features/bookings/schemas';
import { getBookingById } from '@/features/bookings/service';
import { runBookingAction, validationErrorResponse } from '@/features/bookings/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Staff-only single-Booking retrieval — see the collection route's doc
// comment for the same role/scoping rationale. A TRAVEL_CONSULTANT
// requesting a Booking they are not assigned to receives the identical
// response a nonexistent id would produce (403 BOOKING_FORBIDDEN), never a
// 404, so no id's existence can be inferred (see
// features/bookings/errors.ts's BookingError doc comment).
export const GET = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = bookingIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    return runBookingAction(
      () => getBookingById(user, idResult.data.id),
      (booking) => NextResponse.json({ booking }),
    );
  },
);
