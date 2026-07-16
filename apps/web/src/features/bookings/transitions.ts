import { BookingStatus } from '@/generated/prisma/client';

// The confirmed Booking status-transition matrix
// (docs/HERITAGE_V3_DECISIONS_LOG.md D-014). Deliberately kept separate from
// repository.ts (.claude/rules/backend.md's "Service-Level Business Rules":
// status-lifecycle transitions are service-layer policy, not persistence) —
// repository.ts only ever writes whatever transition this module has
// already approved; it never decides which transitions are legal.
//
// `DOCUMENTS_REQUIRED` and `VISA_PROCESSING` are coarse overall
// booking-stage indicators only, not a model of the genuinely parallel
// document/visa workflows blueprint Section 8 describes — see D-014's
// rationale. `COMPLETED` and `CANCELLED` are terminal: an empty array, not
// an omitted key, so every status has an explicit (possibly empty) entry
// here rather than an implicit "anything not listed is disallowed" default.
const TRANSITION_MATRIX: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  [BookingStatus.DRAFT]: [BookingStatus.PENDING_CONFIRMATION, BookingStatus.CANCELLED],
  [BookingStatus.PENDING_CONFIRMATION]: [BookingStatus.CONFIRMED, BookingStatus.CANCELLED],
  [BookingStatus.CONFIRMED]: [BookingStatus.IN_PREPARATION, BookingStatus.CANCELLED],
  [BookingStatus.IN_PREPARATION]: [
    BookingStatus.DOCUMENTS_REQUIRED,
    BookingStatus.VISA_PROCESSING,
    BookingStatus.READY_FOR_TRAVEL,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.DOCUMENTS_REQUIRED]: [
    BookingStatus.VISA_PROCESSING,
    BookingStatus.READY_FOR_TRAVEL,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.VISA_PROCESSING]: [
    BookingStatus.DOCUMENTS_REQUIRED,
    BookingStatus.READY_FOR_TRAVEL,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.READY_FOR_TRAVEL]: [BookingStatus.IN_PROGRESS, BookingStatus.CANCELLED],
  [BookingStatus.IN_PROGRESS]: [BookingStatus.COMPLETED, BookingStatus.CANCELLED],
  [BookingStatus.COMPLETED]: [],
  [BookingStatus.CANCELLED]: [],
};

/**
 * Whether `current -> next` is an allowed transition per D-014's matrix.
 * Does not special-case `current === next` — that is always `false` here
 * (no status lists itself as a valid target), and is handled by the
 * service layer as an idempotent no-op *before* this function is ever
 * consulted (service.ts's `updateBookingStatus`), never as a transition
 * this module approves.
 */
export function isTransitionAllowed(current: BookingStatus, next: BookingStatus): boolean {
  return TRANSITION_MATRIX[current].includes(next);
}
