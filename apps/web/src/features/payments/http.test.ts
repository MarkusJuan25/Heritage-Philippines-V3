import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PaymentError } from './errors';
import { parseJsonBody, runPaymentAction } from './http';

const schema = z.object({ paymentId: z.string().uuid(), reason: z.string().min(1) }).strict();
const PAYMENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';

function request(body: string): Request {
  return new Request('http://localhost/api/payments', { method: 'POST', body });
}

describe('parseJsonBody', () => {
  it('merges path values over the body, so the URL decides the target', async () => {
    const result = await parseJsonBody(
      request(JSON.stringify({ reason: 'Verified', paymentId: OTHER_ID })),
      schema,
      { paymentId: PAYMENT_ID },
    );
    expect(result).toEqual({ success: true, data: { paymentId: PAYMENT_ID, reason: 'Verified' } });
  });

  it.each([
    ['malformed JSON', '{'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a schema violation', JSON.stringify({ reason: '' })],
    ['an unknown field', JSON.stringify({ reason: 'r', status: 'CONFIRMED' })],
  ])('returns a 400 VALIDATION_ERROR for %s', async (_label, body) => {
    const result = await parseJsonBody(request(body), schema, { paymentId: PAYMENT_ID });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
    expect((await result.response.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('runPaymentAction', () => {
  it('shapes a PaymentError into its code and status', async () => {
    const response = await runPaymentAction(
      async () => {
        throw new PaymentError(
          'PAYMENT_PLAN_CONFLICT',
          'An approved payment plan cannot be withdrawn.',
        );
      },
      () => new Response(null),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'PAYMENT_PLAN_CONFLICT',
        message: 'An approved payment plan cannot be withdrawn.',
      },
    });
  });

  it('rethrows any other error for the generic 500 handling', async () => {
    const unexpected = new Error('database detail');
    await expect(
      runPaymentAction(
        async () => {
          throw unexpected;
        },
        () => new Response(null),
      ),
    ).rejects.toBe(unexpected);
  });
});
