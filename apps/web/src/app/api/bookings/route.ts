import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { createBookingSchema, listBookingsQuerySchema } from '@/features/bookings/schemas';
import { createBooking, listBookings } from '@/features/bookings/service';
import { parseJsonBody, parseQuery, runBookingAction } from '@/features/bookings/http';

export const runtime = 'nodejs';

// Staff-only Booking creation and listing (blueprint Sections 5, 5.1, 5.2,
// 8, 9, 13.4). ADMIN_MANAGER has unconditional access; TRAVEL_CONSULTANT is
// further scoped, inside the service/repository layer, to Clients they are
// actively assigned to — every other role (including CLIENT) is rejected
// here by `withRole` before either handler body runs. No client-portal
// Booking access exists yet (deferred; see docs/HERITAGE_V3_TASK_BOARD.md).
export const GET = withRole(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'], async (request, { user }) => {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams, listBookingsQuerySchema);
  if (!query.success) {
    return query.response;
  }

  const result = await listBookings(user, query.data);
  return NextResponse.json(result);
});

// Creates a Booking from an accepted ProposalVersion (blueprint Section
// 5.1's explicit-staff-action rule). Returns 201 for a newly created
// Booking and 200 when the request was an idempotent replay for a
// ProposalVersion that already has one — see
// features/bookings/service.ts's `createBooking` for the full
// idempotency/concurrency behavior.
export const POST = withRole(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'], async (request, { user }) => {
  const body = await parseJsonBody(request, createBookingSchema);
  if (!body.success) {
    return body.response;
  }

  return runBookingAction(
    () => createBooking(user, body.data),
    ({ booking, created }) => NextResponse.json({ booking }, { status: created ? 201 : 200 }),
  );
});
