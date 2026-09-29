import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { recordPaymentSchema } from '@/features/payments/schemas';
import { recordPayment } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

// Finance/Accounting records a payment received outside this system
// (D-054 §6). Idempotent by the caller's key (D-054 §17 Rule 6).
export const POST = withRole(['FINANCE_ACCOUNTING'], async (request, { user }) => {
  const body = await parseJsonBody(request, recordPaymentSchema);
  if (!body.success) {
    return body.response;
  }

  return runPaymentAction(
    () => recordPayment(user, body.data),
    (result) => NextResponse.json({ payment: result }, { status: 201 }),
  );
});
