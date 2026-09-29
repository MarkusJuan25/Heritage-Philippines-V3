import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { approvePaymentPlanSchema } from '@/features/payments/schemas';
import { approvePaymentPlan } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Finance/Accounting approves a proposed plan (D-054 §6; D-057 §4). The
// plan id comes from the URL only.
export const POST = withRole<RouteParams>(
  ['FINANCE_ACCOUNTING'],
  async (request, { user, params }) => {
    const body = await parseJsonBody(request, approvePaymentPlanSchema, {
      paymentPlanId: (await params).id,
    });
    if (!body.success) {
      return body.response;
    }

    return runPaymentAction(
      () => approvePaymentPlan(user, body.data),
      (result) => NextResponse.json({ plan: result }),
    );
  },
);
