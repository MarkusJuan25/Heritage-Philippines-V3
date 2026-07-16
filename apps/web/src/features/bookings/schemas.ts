import { z } from 'zod';

import { BookingStatus } from '@/generated/prisma/client';

// Booking-creation contract for this checkpoint (blueprint Sections 5, 5.1,
// 5.2, 9). The client supplies only the accepted ProposalVersion to create
// from — `bookingReference` is always server-generated (never accepted from
// a request body; see features/bookings/service.ts's
// `generateBookingReference`), and no editable Booking snapshot field
// (destination, travel dates, notes, etc.) is accepted yet — those remain
// deferred to a later checkpoint alongside Booking-detail-update behavior.
// Status transitions are covered separately below.
//
// `.strict()`: an unrecognized property (most importantly a caller-supplied
// `bookingReference`, but any other field too) fails validation with a 400
// rather than being silently stripped. A silently-stripped-but-otherwise-
// valid request would look, from the caller's side, like their
// `bookingReference` was accepted and then ignored — `.strict()` makes that
// impossible to misread: the request is rejected outright instead.
export const createBookingSchema = z
  .object({
    proposalVersionId: z.string().uuid('proposalVersionId must be a valid UUID'),
  })
  .strict();
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const bookingIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

// The status-transition contract (docs/HERITAGE_V3_DECISIONS_LOG.md D-014).
// `expectedStatus` is the caller's optimistic-concurrency check — the
// service rejects with BOOKING_CONFLICT if the Booking's actual current
// status no longer matches it (features/bookings/service.ts's
// `updateBookingStatus`) — not merely documentation of intent. `.strict()`,
// matching `createBookingSchema`: no `reason` field is accepted in this
// checkpoint (D-014 explicitly defers it), and no other property is
// silently accepted or stripped.
const bookingStatusSchema = z.nativeEnum(BookingStatus);

export const updateBookingStatusSchema = z
  .object({
    expectedStatus: bookingStatusSchema,
    newStatus: bookingStatusSchema,
  })
  .strict();
export type UpdateBookingStatusInput = z.infer<typeof updateBookingStatusSchema>;

// Pagination only, mirroring features/staff/schemas.ts's
// `listStaffAccountsQuerySchema` page/pageSize convention. No status filter
// or free-text search is introduced here — this checkpoint does not
// implement status transitions, and no other filter is specified anywhere
// in the repository documentation for this list, so none is invented.
export const listBookingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
