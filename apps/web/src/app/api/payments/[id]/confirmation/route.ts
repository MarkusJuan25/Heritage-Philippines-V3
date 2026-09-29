import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { confirmPaymentSchema } from '@/features/payments/schemas';
import { confirmPayment } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Finance/Accounting confirms a PENDING payment (D-054 §6), idempotent
// by the caller's key.
export const POST = withRole<RouteParams>(
  ['FINANCE_ACCOUNTING'],
  async (request, { user, params }) => {
    const body = await parseJsonBody(request, confirmPaymentSchema, {
      paymentId: (await params).id,
    });
    if (!body.success) {
      return body.response;
    }

    return runPaymentAction(
      () => confirmPayment(user, body.data),
      (result) => NextResponse.json({ payment: result }),
    );
  },
);
