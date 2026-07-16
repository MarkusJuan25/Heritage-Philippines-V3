import { describe, expect, it } from 'vitest';

import {
  bookingIdParamSchema,
  createBookingSchema,
  listBookingsQuerySchema,
  updateBookingStatusSchema,
} from './schemas';

describe('createBookingSchema', () => {
  it('accepts a valid proposalVersionId UUID', () => {
    const result = createBookingSchema.safeParse({
      proposalVersionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID proposalVersionId', () => {
    const result = createBookingSchema.safeParse({ proposalVersionId: 'not-a-uuid' });

    expect(result.success).toBe(false);
  });

  it('rejects a missing proposalVersionId', () => {
    const result = createBookingSchema.safeParse({});

    expect(result.success).toBe(false);
  });

  it('rejects a body that includes a caller-supplied bookingReference, rather than silently stripping it', () => {
    const result = createBookingSchema.safeParse({
      proposalVersionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD',
    });

    expect(result.success).toBe(false);
  });

  it('rejects any other unrecognized property', () => {
    const result = createBookingSchema.safeParse({
      proposalVersionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      status: 'CONFIRMED',
      totalPrice: 100,
    });

    expect(result.success).toBe(false);
  });

  it('accepts a body containing only proposalVersionId', () => {
    const result = createBookingSchema.safeParse({
      proposalVersionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ proposalVersionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' });
    }
  });
});

describe('bookingIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(
      bookingIdParamSchema.safeParse({ id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }).success,
    ).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(bookingIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('listBookingsQuerySchema', () => {
  it('defaults page to 1 and pageSize to 20 when omitted', () => {
    const result = listBookingsQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ page: 1, pageSize: 20 });
    }
  });

  it('coerces string query-param values to numbers', () => {
    const result = listBookingsQuerySchema.safeParse({ page: '3', pageSize: '50' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ page: 3, pageSize: 50 });
    }
  });

  it('rejects a pageSize above 100', () => {
    expect(listBookingsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });

  it('rejects a page below 1', () => {
    expect(listBookingsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });
});

describe('updateBookingStatusSchema', () => {
  it('accepts a valid expectedStatus/newStatus pair', () => {
    const result = updateBookingStatusSchema.safeParse({
      expectedStatus: 'DRAFT',
      newStatus: 'PENDING_CONFIRMATION',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ expectedStatus: 'DRAFT', newStatus: 'PENDING_CONFIRMATION' });
    }
  });

  it('rejects an invalid status string for either field', () => {
    expect(
      updateBookingStatusSchema.safeParse({ expectedStatus: 'NOT_A_STATUS', newStatus: 'DRAFT' })
        .success,
    ).toBe(false);
    expect(
      updateBookingStatusSchema.safeParse({ expectedStatus: 'DRAFT', newStatus: 'NOT_A_STATUS' })
        .success,
    ).toBe(false);
  });

  it('rejects a missing expectedStatus', () => {
    expect(updateBookingStatusSchema.safeParse({ newStatus: 'DRAFT' }).success).toBe(false);
  });

  it('rejects a missing newStatus', () => {
    expect(updateBookingStatusSchema.safeParse({ expectedStatus: 'DRAFT' }).success).toBe(false);
  });

  it('rejects a body containing a reason field — not implemented in this checkpoint', () => {
    const result = updateBookingStatusSchema.safeParse({
      expectedStatus: 'DRAFT',
      newStatus: 'CANCELLED',
      reason: 'Client requested cancellation',
    });

    expect(result.success).toBe(false);
  });

  it('rejects any other unrecognized property', () => {
    const result = updateBookingStatusSchema.safeParse({
      expectedStatus: 'DRAFT',
      newStatus: 'PENDING_CONFIRMATION',
      bookingReference: 'HPB-DEADBEEFDEADBEEFDEAD',
    });

    expect(result.success).toBe(false);
  });
});
