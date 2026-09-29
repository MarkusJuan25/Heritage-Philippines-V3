import type { BookingStatus, PaymentStatus } from '@/generated/prisma/client';

// Display labels for the statuses the schema defines — never an invented
// state (.claude/rules/admin-dashboard.md). Kept as this feature's own copy,
// matching the per-feature label maps in admin/bookings.
export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  DRAFT: 'Draft',
  PENDING_CONFIRMATION: 'Pending Confirmation',
  CONFIRMED: 'Confirmed',
  IN_PREPARATION: 'In Preparation',
  DOCUMENTS_REQUIRED: 'Documents Required',
  VISA_PROCESSING: 'Visa Processing',
  READY_FOR_TRAVEL: 'Ready for Travel',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
  REVERSED: 'Reversed',
  REFUNDED: 'Refunded',
};

// D-057's active states; a withdrawn plan is never the Booking's plan.
export const PLAN_STATUS_LABELS = {
  PROPOSED: 'Proposed — awaiting Finance approval',
  APPROVED: 'Approved',
} as const;

// The list filter's plan states (listPaymentBookingsSchema).
export const PLAN_FILTER_LABELS = {
  none: 'No plan',
  proposed: 'Proposed',
  approved: 'Approved',
  withdrawn: 'Withdrawn only',
} as const;
