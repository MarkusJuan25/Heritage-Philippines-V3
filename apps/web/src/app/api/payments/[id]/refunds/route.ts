import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { refundPaymentSchema } from '@/features/payments/schemas';
import { refundPayment } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Finance/Accounting records a refund against a confirmed payment
// (D-054 §6), optionally linked to one allocation. The UI requires an
// explicit confirmation step first.
export const POST = withRole<RouteParams>(
  ['FINANCE_ACCOUNTING'],
  async (request, { user, params }) => {
    const body = await parseJsonBody(request, refundPaymentSchema, {
      paymentId: (await params).id,
    });
    if (!body.success) {
      return body.response;
    }

    return runPaymentAction(
      () => refundPayment(user, body.data),
      (result) => NextResponse.json(result),
    );
  },
);
