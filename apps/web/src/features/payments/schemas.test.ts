import { describe, expect, it } from 'vitest';

import {
  approvePaymentPlanSchema,
  confirmPaymentSchema,
  createAllocationSchema,
  issueReceiptSchema,
  positiveMoneyAmountSchema,
  proposePaymentPlanSchema,
  recordPaymentSchema,
  refundPaymentSchema,
  reverseAllocationSchema,
  reversePaymentSchema,
} from './schemas';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('positiveMoneyAmountSchema', () => {
  it.each(['0.01', '1.00', '150.00', '9999999999999.99'])('accepts %s', (value) => {
    expect(positiveMoneyAmountSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    '0.00',
    '-1.00',
    '1',
    '1.0',
    '1.000',
    '01.00',
    '1e2',
    '',
    ' 1.00',
    '1.00 ',
    'abc',
    '1,00.00',
  ])('rejects %s', (value) => {
    expect(positiveMoneyAmountSchema.safeParse(value).success).toBe(false);
  });

  it('never accepts a JavaScript number', () => {
    expect(positiveMoneyAmountSchema.safeParse(150).success).toBe(false);
  });
});

describe('proposePaymentPlanSchema', () => {
  const validInstallment = {
    sequenceNumber: 1,
    isDeposit: true,
    amount: '500.00',
    dueDate: '2026-10-01',
  };

  it('accepts a valid proposal with one or more installments', () => {
    const result = proposePaymentPlanSchema.safeParse({
      bookingId: UUID_A,
      installments: [validInstallment],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty installments array', () => {
    const result = proposePaymentPlanSchema.safeParse({ bookingId: UUID_A, installments: [] });
    expect(result.success).toBe(false);
  });

  it('accepts a plan with no deposit installment at all (D-019: a deposit is optional)', () => {
    const result = proposePaymentPlanSchema.safeParse({
      bookingId: UUID_A,
      installments: [
        { ...validInstallment, isDeposit: false },
        { ...validInstallment, isDeposit: false, sequenceNumber: 2 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    [
      'duplicate sequence numbers',
      [validInstallment, { ...validInstallment, isDeposit: false }],
      ['installments', 1, 'sequenceNumber'],
    ],
    [
      'more than one deposit',
      [validInstallment, { ...validInstallment, sequenceNumber: 2 }],
      ['installments', 1, 'isDeposit'],
    ],
    [
      'a deposit that is not sequence number 1 (D-019)',
      [
        { ...validInstallment, isDeposit: false },
        { ...validInstallment, sequenceNumber: 2 },
      ],
      ['installments', 1, 'sequenceNumber'],
    ],
  ])('rejects %s with a field-level issue', (_label, installments, path) => {
    const result = proposePaymentPlanSchema.safeParse({ bookingId: UUID_A, installments });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(path);
    }
  });

  it.each(['2026-02-31', '2026-13-01', '2026-00-10', '2025-02-29'])(
    'rejects the well-shaped but impossible due date %s',
    (dueDate) => {
      const result = proposePaymentPlanSchema.safeParse({
        bookingId: UUID_A,
        installments: [{ ...validInstallment, dueDate }],
      });
      expect(result.success).toBe(false);
    },
  );

  it('accepts a real leap-day due date', () => {
    const result = proposePaymentPlanSchema.safeParse({
      bookingId: UUID_A,
      installments: [{ ...validInstallment, dueDate: '2028-02-29' }],
    });
    expect(result.success).toBe(true);
  });

  it('defaults isDeposit to false when omitted', () => {
    const result = proposePaymentPlanSchema.safeParse({
      bookingId: UUID_A,
      installments: [{ sequenceNumber: 1, amount: '500.00', dueDate: '2026-10-01' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.installments[0]?.isDeposit).toBe(false);
    }
  });

  it('rejects a malformed dueDate', () => {
    const result = proposePaymentPlanSchema.safeParse({
      bookingId: UUID_A,
      installments: [{ ...validInstallment, dueDate: '10/01/2026' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized property (.strict())', () => {
    const result = proposePaymentPlanSchema.safeParse({
      bookingId: UUID_A,
      installments: [validInstallment],
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid bookingId', () => {
    const result = proposePaymentPlanSchema.safeParse({
      bookingId: 'not-a-uuid',
      installments: [validInstallment],
    });
    expect(result.success).toBe(false);
  });
});

describe('approvePaymentPlanSchema', () => {
  it('accepts only paymentPlanId, no idempotencyKey field', () => {
    expect(approvePaymentPlanSchema.safeParse({ paymentPlanId: UUID_A }).success).toBe(true);
    expect(
      approvePaymentPlanSchema.safeParse({ paymentPlanId: UUID_A, idempotencyKey: 'x' }).success,
    ).toBe(false);
  });
});

describe('recordPaymentSchema', () => {
  it('accepts bookingId and amount, no idempotencyKey field', () => {
    const result = recordPaymentSchema.safeParse({ bookingId: UUID_A, amount: '150.00' });
    expect(result.success).toBe(true);
    expect(
      recordPaymentSchema.safeParse({ bookingId: UUID_A, amount: '150.00', idempotencyKey: 'x' })
        .success,
    ).toBe(false);
  });

  it('rejects a zero or negative amount', () => {
    expect(recordPaymentSchema.safeParse({ bookingId: UUID_A, amount: '0.00' }).success).toBe(
      false,
    );
    expect(recordPaymentSchema.safeParse({ bookingId: UUID_A, amount: '-5.00' }).success).toBe(
      false,
    );
  });
});

describe('confirmPaymentSchema / reversePaymentSchema', () => {
  it('require paymentId, reason, and idempotencyKey', () => {
    const valid = { paymentId: UUID_A, reason: 'Verified bank transfer', idempotencyKey: 'idem-1' };
    expect(confirmPaymentSchema.safeParse(valid).success).toBe(true);
    expect(reversePaymentSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty reason', () => {
    const result = confirmPaymentSchema.safeParse({
      paymentId: UUID_A,
      reason: '',
      idempotencyKey: 'idem-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty idempotencyKey', () => {
    const result = confirmPaymentSchema.safeParse({
      paymentId: UUID_A,
      reason: 'Verified',
      idempotencyKey: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('refundPaymentSchema', () => {
  it('accepts a refund without an allocationId (unapplied-credit refund)', () => {
    const result = refundPaymentSchema.safeParse({
      paymentId: UUID_A,
      amount: '25.00',
      reason: 'Partial refund',
      idempotencyKey: 'idem-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a refund with an allocationId', () => {
    const result = refundPaymentSchema.safeParse({
      paymentId: UUID_A,
      amount: '25.00',
      reason: 'Partial refund',
      idempotencyKey: 'idem-1',
      allocationId: UUID_B,
    });
    expect(result.success).toBe(true);
  });
});

describe('issueReceiptSchema', () => {
  it('accepts only paymentId', () => {
    expect(issueReceiptSchema.safeParse({ paymentId: UUID_A }).success).toBe(true);
  });
});

describe('createAllocationSchema / reverseAllocationSchema', () => {
  it('createAllocationSchema requires paymentId, installmentId, amount, idempotencyKey', () => {
    const result = createAllocationSchema.safeParse({
      paymentId: UUID_A,
      installmentId: UUID_B,
      amount: '50.00',
      idempotencyKey: 'idem-1',
    });
    expect(result.success).toBe(true);
  });

  it('reverseAllocationSchema requires allocationId, reason, idempotencyKey', () => {
    const result = reverseAllocationSchema.safeParse({
      allocationId: UUID_A,
      reason: 'Misallocated',
      idempotencyKey: 'idem-1',
    });
    expect(result.success).toBe(true);
  });
});
