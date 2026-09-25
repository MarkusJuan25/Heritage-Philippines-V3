import { describe, expect, it } from 'vitest';

import { PaymentError } from './errors';

describe('PaymentError', () => {
  it.each([
    ['ROLE_NOT_PERMITTED', 403],
    ['BOOKING_NOT_FOUND', 404],
    ['BOOKING_FORBIDDEN', 403],
    ['PAYMENT_PLAN_NOT_FOUND', 404],
    ['PAYMENT_PLAN_FORBIDDEN', 403],
    ['PAYMENT_PLAN_CONFLICT', 409],
    ['PAYMENT_NOT_FOUND', 404],
    ['PAYMENT_FORBIDDEN', 403],
    ['INVALID_PAYMENT_TRANSITION', 409],
    ['PAYMENT_CONFLICT', 409],
    ['ALLOCATION_NOT_PERMITTED', 409],
    ['ALLOCATION_REVERSAL_NOT_PERMITTED', 409],
    ['REFUND_EXCEEDS_REMAINING', 409],
    ['RECEIPT_NOT_PERMITTED', 409],
    ['IDEMPOTENCY_KEY_CONFLICT', 409],
    ['BOOKING_CURRENCY_NOT_SET', 409],
  ] as const)('maps %s to status %d', (code, status) => {
    const error = new PaymentError(code, 'message');
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.name).toBe('PaymentError');
    expect(error.message).toBe('message');
    expect(error).toBeInstanceOf(Error);
  });
});
