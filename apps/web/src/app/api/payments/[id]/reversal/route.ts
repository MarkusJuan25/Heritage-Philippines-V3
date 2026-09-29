import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { reversePaymentSchema } from '@/features/payments/schemas';
import { reversePayment } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Finance/Accounting reverses an erroneous confirmation with a reason
// (D-054 §6). The UI requires an explicit confirmation step first.
export const POST = withRole<RouteParams>(
  ['FINANCE_ACCOUNTING'],
  async (request, { user, params }) => {
    const body = await parseJsonBody(request, reversePaymentSchema, {
      paymentId: (await params).id,
    });
    if (!body.success) {
      return body.response;
    }

    return runPaymentAction(
      () => reversePayment(user, body.data),
      (result) => NextResponse.json({ payment: result }),
    );
  },
);
