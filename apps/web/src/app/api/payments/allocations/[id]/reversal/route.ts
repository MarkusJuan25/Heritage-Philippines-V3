import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { reverseAllocationSchema } from '@/features/payments/schemas';
import { reverseAllocation } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Finance/Accounting reverses one allocation with a reason (D-054 §13).
export const POST = withRole<RouteParams>(
  ['FINANCE_ACCOUNTING'],
  async (request, { user, params }) => {
    const body = await parseJsonBody(request, reverseAllocationSchema, {
      allocationId: (await params).id,
    });
    if (!body.success) {
      return body.response;
    }

    return runPaymentAction(
      () => reverseAllocation(user, body.data),
      (result) => NextResponse.json({ reversal: result }),
    );
  },
);
