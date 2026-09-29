import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { withdrawPaymentPlanSchema } from '@/features/payments/schemas';
import { withdrawPaymentPlan } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// D-057: the Booking's assigned Travel Consultant or Finance/Accounting
// user withdraws an unapproved plan, with a reason.
export const POST = withRole<RouteParams>(
  ['TRAVEL_CONSULTANT', 'FINANCE_ACCOUNTING'],
  async (request, { user, params }) => {
    const body = await parseJsonBody(request, withdrawPaymentPlanSchema, {
      paymentPlanId: (await params).id,
    });
    if (!body.success) {
      return body.response;
    }

    return runPaymentAction(
      () => withdrawPaymentPlan(user, body.data),
      (result) => NextResponse.json({ plan: result }),
    );
  },
);
