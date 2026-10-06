import { z } from 'zod';

import { PaymentStatus } from '@/generated/prisma/client';
import { isValidClientBookingReference } from '@/features/bookings/schemas';

import { isRealCalendarDate } from './schemas';

// Request shape for a basic finance export (D-061 §5, as clarified by
// D-062). Filters are validated per dataset: a filter a dataset does not
// take is a validation error, never something silently ignored — each
// member is `.strict()`, so an unknown or inapplicable key is refused.

export const FINANCE_EXPORT_FORMAT_VERSION = 'v1';
export const FINANCE_EXPORT_ROW_LIMIT = 10_000;
export const FINANCE_EXPORT_MAX_RANGE_DAYS = 366;

export const FINANCE_EXPORT_DATASETS = [
  'bookings',
  'payments',
  'refunds',
  'allocations',
  'installments',
] as const;
export type FinanceExportDataset = (typeof FINANCE_EXPORT_DATASETS)[number];

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const calendarDaySchema = z
  .string()
  .refine(isRealCalendarDate, 'must be a real calendar date in YYYY-MM-DD form');

// The existing booking-reference format validator (D-049 §3). The rejected
// value is never echoed.
const bookingReferenceSchema = z
  .string()
  .refine(isValidClientBookingReference, 'bookingReference is not a valid booking reference');

const datedFilters = {
  from: calendarDaySchema.optional(),
  to: calendarDaySchema.optional(),
  bookingReference: bookingReferenceSchema.optional(),
};

/** The number of calendar days in an inclusive range; both endpoints count (D-062 clause 6). */
export function countInclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / MILLISECONDS_PER_DAY) + 1;
}

export const financeExportRequestSchema = z
  .discriminatedUnion('dataset', [
    z
      .object({
        dataset: z.literal('bookings'),
        bookingReference: bookingReferenceSchema.optional(),
      })
      .strict(),
    z
      .object({
        dataset: z.literal('payments'),
        ...datedFilters,
        status: z.enum(PaymentStatus).optional(),
      })
      .strict(),
    z.object({ dataset: z.literal('refunds'), ...datedFilters }).strict(),
    z.object({ dataset: z.literal('allocations'), ...datedFilters }).strict(),
    z.object({ dataset: z.literal('installments'), ...datedFilters }).strict(),
  ])
  .superRefine((request, context) => {
    // `bookings` takes no date range; unfiltered it is a current snapshot.
    if (request.dataset === 'bookings') return;

    const hasFrom = request.from !== undefined;
    const hasTo = request.to !== undefined;
    if (hasFrom !== hasTo) {
      context.addIssue({
        code: 'custom',
        path: [hasFrom ? 'to' : 'from'],
        message: 'A date range needs both from and to.',
      });
      return;
    }
    if (!hasFrom && request.bookingReference === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'This dataset needs a date range, a booking reference, or both.',
      });
      return;
    }
    if (request.from === undefined || request.to === undefined) return;
    // Both are validated `YYYY-MM-DD` strings, which sort chronologically.
    if (request.from > request.to) {
      context.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'from must not be after to.',
      });
      return;
    }
    if (countInclusiveDays(request.from, request.to) > FINANCE_EXPORT_MAX_RANGE_DAYS) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: `A date range may cover at most ${FINANCE_EXPORT_MAX_RANGE_DAYS} days.`,
      });
    }
  });

export type FinanceExportRequest = z.infer<typeof financeExportRequestSchema>;

/**
 * Raised by `generateFinanceExport` when its input does not satisfy
 * `financeExportRequestSchema`. `issues` has the shape
 * `http.ts`'s `validationErrorResponse` takes, so a route can answer with
 * the standard `VALIDATION_ERROR` envelope. The message never repeats the
 * rejected input.
 */
export class FinanceExportRequestError extends Error {
  readonly issues: readonly { path: PropertyKey[]; message: string }[];

  constructor(issues: readonly { path: PropertyKey[]; message: string }[]) {
    super('The finance export request did not pass validation.');
    this.name = 'FinanceExportRequestError';
    this.issues = issues.map((issue) => ({ path: [...issue.path], message: issue.message }));
  }
}
