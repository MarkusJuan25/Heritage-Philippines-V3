import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { issueReceiptSchema } from '@/features/payments/schemas';
import { issueReceipt } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Finance/Accounting issues the receipt for a confirmed payment, or gets
// the existing one back (D-054 §17 Rule 3).
export const POST = withRole<RouteParams>(
  ['FINANCE_ACCOUNTING'],
  async (request, { user, params }) => {
    const body = await parseJsonBody(request, issueReceiptSchema, { paymentId: (await params).id });
    if (!body.success) {
      return body.response;
    }

    return runPaymentAction(
      () => issueReceipt(user, body.data),
      (result) => NextResponse.json(result),
    );
  },
);
