import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { setBookingFinancialsSchema } from '@/features/payments/schemas';
import { setBookingFinancials } from '@/features/payments/service';
import { parseJsonBody, runPaymentAction } from '@/features/payments/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// D-056 §2 (placement corrected September 28, 2026): the Booking's assigned
// Finance/Accounting user sets or corrects its total and currency.
// `setBookingFinancials` decides everything else — the assignment, the
// cancelled-Booking block, the currency list and precision, the reason for
// a change, the lock, and the audit record. Identical values are a no-op.
export const PUT = withRole<RouteParams>(
  ['FINANCE_ACCOUNTING'],
  async (request, { user, params }) => {
    const body = await parseJsonBody(request, setBookingFinancialsSchema, {
      bookingId: (await params).id,
    });
    if (!body.success) {
      return body.response;
    }

    return runPaymentAction(
      () => setBookingFinancials(user, body.data),
      (financials) => NextResponse.json({ financials }),
    );
  },
);
