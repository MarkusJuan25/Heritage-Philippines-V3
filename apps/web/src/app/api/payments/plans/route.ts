import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { proposePaymentPlanSchema } from '@/features/payments/schemas';
import { proposePaymentPlan } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

// D-054 §6 / Stage 3: a Travel Consultant proposes a Booking's payment
// plan. The service enforces the Booking assignment, the financials
// prerequisite, the installment structure, and active-plan uniqueness.
export const POST = withRole(['TRAVEL_CONSULTANT'], async (request, { user }) => {
  const body = await parseJsonBody(request, proposePaymentPlanSchema);
  if (!body.success) {
    return body.response;
  }

  return runPaymentAction(
    () => proposePaymentPlan(user, body.data),
    (result) => NextResponse.json({ plan: result }, { status: 201 }),
  );
});
