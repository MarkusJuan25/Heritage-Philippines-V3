import { NextResponse } from 'next/server';

import { handleResendWebhookEvent } from '@/features/invitations/service';

export const runtime = 'nodejs';

// Public webhook receiver (D-034 Section 2(b); Stage 3 Section 6/8
// correction) — authenticated by Svix signature verification, never by
// session (no `withRole`: there is no staff session on an inbound
// provider request). Reads the RAW request body via `request.text()`
// before any parsing — signature verification is computed over the exact
// bytes Resend sent; parsing to JSON first would break it.
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json(
      { error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Missing Svix signature headers.' } },
      { status: 401 },
    );
  }

  const result = await handleResendWebhookEvent(rawBody, {
    id: svixId,
    timestamp: svixTimestamp,
    signature: svixSignature,
  });

  if (result.status === 401) {
    return NextResponse.json(
      {
        error: {
          code: 'WEBHOOK_SIGNATURE_INVALID',
          message: 'Webhook signature verification failed.',
        },
      },
      { status: 401 },
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
