import { z } from 'zod';

// Booking-creation contract for this checkpoint (blueprint Sections 5, 5.1,
// 5.2, 9). The client supplies only the accepted ProposalVersion to create
// from — `bookingReference` is always server-generated (never accepted from
// a request body; see features/bookings/service.ts's
// `generateBookingReference`), and no editable Booking snapshot field
// (destination, travel dates, notes, etc.) is accepted yet — those remain
// deferred to a later checkpoint alongside status-transition and
// Booking-detail-update behavior.
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
