import { headers } from 'next/headers';

import { activationTokenSchema } from '@/features/activation/schemas';
import { getActivationPageState } from '@/features/activation/service';
import { checkSourceRateLimit } from '@/features/activation/rate-limit';
import { resolveRequestSource } from '@/features/activation/source';

import { ActivationForm } from './_components/ActivationForm';

export const runtime = 'nodejs';
// D-037 Section 13: prevents this token-bearing route from ever being
// statically prerendered or cached at build/ISR time — a second,
// independent layer alongside the `Cache-Control: no-store` header
// `next.config.ts` sets for this same path.
export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ token: string }> };

// The public, unauthenticated, token-bearing GET (D-034 Section 5; D-037
// Sections 3, 4, 5, 11). Safe: performs no mutation of any kind. Reads the
// route param directly, server-side, to decide which UI state to render —
// this is the ONLY place server-side code touches the raw token; its
// output crossing into the Client Component below is a non-sensitive
// state label, never the token itself (D-037 Section 4 — see
// ActivationForm's own doc comment for how it independently re-derives
// the token from the browser URL at action time, never as a prop).
export default async function ActivatePage({ params }: PageProps) {
  // D-037 Section 3: a SOURCE-dimension rate-limit check, run as
  // operational bookkeeping only, before any other work — no
  // TOKEN-dimension check on this route at all. A Server Component has no
  // `Request` object; `next/headers`'s `headers()` provides the same
  // request headers `resolveRequestSource` needs.
  const requestHeaders = await headers();
  const source = resolveRequestSource(requestHeaders, {});
  const isThrottled = await checkSourceRateLimit(source);
  if (isThrottled) {
    // Fixed, generic — HTTP 200, never 429 (a Server Component page render
    // has no supported mechanism to emit an arbitrary non-2xx/3xx status
    // without introducing middleware solely to manufacture one). The
    // request never reads or mutates PortalInvitation, AuditLog, User, or
    // ClientProfile past this point.
    return (
      <main>
        <h1>Activate your account</h1>
        <p role="status">Too many attempts. Please try again later.</p>
        <p>
          <a href="/login">Go to sign in</a>
        </p>
      </main>
    );
  }

  const { token } = await params;

  const shapeResult = activationTokenSchema.safeParse(token);
  const state = shapeResult.success ? await getActivationPageState(shapeResult.data) : 'not-found';

  if (state === 'not-found') {
    return (
      <main>
        <h1>Activate your account</h1>
        <p role="status">This invitation link is no longer valid.</p>
        <p>
          <a href="/login">Go to sign in</a>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Activate your account</h1>
      <ActivationForm initialState={state === 'eligible-opened' ? 'opened' : 'not-opened'} />
    </main>
  );
}
