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

// --- Client booking reference validation (docs/HERITAGE_V3_DECISIONS_LOG.md
// D-049 §3) ---
// `bookingReference` is always server-generated
// (features/bookings/service.ts's `generateBookingReference`): the literal
// prefix `HPB-` followed by 20 uppercase hexadecimal characters, total
// length exactly 24. This is the canonical form a client-supplied route
// value must match lexically before it may reach any Booking repository
// lookup (D-049 §3) — a value that does not match is rejected here and
// never queried. A plain exported constant + function, not a Zod schema,
// mirroring `parseProposalReviewPageParam`'s precedent below: the caller
// wants a boolean outcome, and the rejected value is never returned,
// logged, or echoed by this function.
export const CLIENT_BOOKING_REFERENCE_PATTERN = /^HPB-[0-9A-F]{20}$/;

export function isValidClientBookingReference(value: string): boolean {
  return CLIENT_BOOKING_REFERENCE_PATTERN.test(value);
}

// --- Client booking list page query (docs/HERITAGE_V3_DECISIONS_LOG.md
// D-049 §4) ---
// Mirrors features/proposals/schemas.ts's `parseProposalReviewPageParam`
// exactly (D-047 §5/§17.1), reused here per D-049 §4's "mirrors D-047 §5/§17
// exactly." The `/client/bookings` list route accepts one optional URL
// query, `page=N`, that carries no database identifier. A value is accepted
// ONLY when it is a single string in the canonical positive-decimal form
// `/^[1-9][0-9]*$/` that also represents a positive safe integer
// (`<= Number.MAX_SAFE_INTEGER`), decided without an unsafe `Number()`
// conversion first. Every other input — a non-string (a repeated `?page=`
// arrives as an array), a leading sign, whitespace, a decimal point,
// exponent notation, `0`, a negative value, an empty value, a leading-zero
// form, or any value above `Number.MAX_SAFE_INTEGER` (including an
// arbitrarily long digit string) — normalizes to `1`. The rejected input is
// never returned, logged, or echoed.
export function parseClientBookingListPageParam(raw: string | string[] | undefined): number {
  if (typeof raw !== 'string') {
    return 1;
  }
  if (!/^[1-9][0-9]*$/.test(raw) || /[^0-9]/.test(raw)) {
    return 1;
  }
  if (raw.length > 16 || BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER)) {
    return 1;
  }
  return Number(raw);
}
