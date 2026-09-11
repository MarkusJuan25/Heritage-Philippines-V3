import { describe, expect, it } from 'vitest';

import {
  bookingIdParamSchema,
  createBookingSchema,
  isValidClientBookingReference,
  listBookingsQuerySchema,
  parseClientBookingListPageParam,
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

describe('isValidClientBookingReference (D-049 §3)', () => {
  it('accepts the canonical HPB- plus 20 uppercase hex characters form', () => {
    expect(isValidClientBookingReference(`HPB-${'0'.repeat(20)}`)).toBe(true);
    expect(isValidClientBookingReference(`HPB-${'A'.repeat(20)}`)).toBe(true);
    expect(isValidClientBookingReference('HPB-0123456789ABCDEF0123')).toBe(true);
  });

  it('rejects a value with the wrong total length', () => {
    expect(isValidClientBookingReference(`HPB-${'A'.repeat(19)}`)).toBe(false);
    expect(isValidClientBookingReference(`HPB-${'A'.repeat(21)}`)).toBe(false);
  });

  it('rejects lowercase hexadecimal characters', () => {
    expect(isValidClientBookingReference(`HPB-${'a'.repeat(20)}`)).toBe(false);
    expect(isValidClientBookingReference('HPB-0123456789abcdef0123')).toBe(false);
  });

  it('rejects non-hexadecimal characters', () => {
    expect(isValidClientBookingReference(`HPB-${'G'.repeat(20)}`)).toBe(false);
    expect(isValidClientBookingReference('HPB-0123456789ABCDEFGHIJ')).toBe(false);
  });

  it('rejects a wrong or missing prefix', () => {
    expect(isValidClientBookingReference(`XXX-${'A'.repeat(20)}`)).toBe(false);
    expect(isValidClientBookingReference('A'.repeat(20))).toBe(false);
    expect(isValidClientBookingReference(`hpb-${'A'.repeat(20)}`)).toBe(false);
  });

  it('rejects extra whitespace, even a single trailing or leading character', () => {
    expect(isValidClientBookingReference(` HPB-${'A'.repeat(20)}`)).toBe(false);
    expect(isValidClientBookingReference(`HPB-${'A'.repeat(20)} `)).toBe(false);
    expect(isValidClientBookingReference(`HPB-${'A'.repeat(20)}\n`)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidClientBookingReference('')).toBe(false);
  });
});

describe('parseClientBookingListPageParam (D-049 §4)', () => {
  it('treats an absent value as page 1', () => {
    expect(parseClientBookingListPageParam(undefined)).toBe(1);
  });

  it('accepts a canonical positive-decimal string as that page', () => {
    expect(parseClientBookingListPageParam('1')).toBe(1);
    expect(parseClientBookingListPageParam('2')).toBe(2);
    expect(parseClientBookingListPageParam('10')).toBe(10);
    expect(parseClientBookingListPageParam('11')).toBe(11);
    expect(parseClientBookingListPageParam('999')).toBe(999);
  });

  it('normalizes every non-canonical lexical form to page 1 without echoing the input', () => {
    for (const value of [
      '0',
      '-1',
      '+1',
      '01',
      '007',
      ' 1',
      '1 ',
      '1 2',
      '1\n',
      '\t1',
      '1.0',
      '1.5',
      '1e3',
      '1E3',
      '0x1',
      'abc',
      '1a',
      'one',
      '',
      ' ',
    ]) {
      expect(parseClientBookingListPageParam(value)).toBe(1);
    }
  });

  it('treats a repeated query param (string array) as page 1', () => {
    expect(parseClientBookingListPageParam(['1', '2'])).toBe(1);
    expect(parseClientBookingListPageParam([])).toBe(1);
  });

  it('accepts exactly Number.MAX_SAFE_INTEGER', () => {
    expect(parseClientBookingListPageParam(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('rejects a value one above Number.MAX_SAFE_INTEGER', () => {
    expect(parseClientBookingListPageParam('9007199254740992')).toBe(1);
  });

  it('rejects an extremely long digit string without an unsafe Number() conversion', () => {
    expect(parseClientBookingListPageParam('9'.repeat(50))).toBe(1);
  });
});
