import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { createAllocationSchema } from '@/features/payments/schemas';
import { createAllocation } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

// Finance/Accounting allocates part of a confirmed payment to an
// installment of the Booking's approved plan (D-054 §4; D-057 §3).
export const POST = withRole(['FINANCE_ACCOUNTING'], async (request, { user }) => {
  const body = await parseJsonBody(request, createAllocationSchema);
  if (!body.success) {
    return body.response;
  }

  return runPaymentAction(
    () => createAllocation(user, body.data),
    (result) => NextResponse.json({ allocation: result }, { status: 201 }),
  );
});
