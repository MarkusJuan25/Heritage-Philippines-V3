import { ActivationForm } from './_components/ActivationForm';

// D-038 Section 3 (superseding D-037 Sections 3, 5, 14): GET /activate is
// a fixed, static, tokenless activation shell. It performs no
// `PortalInvitation` lookup, no `RateLimitBucket` write, and calls none of
// `headers()`, `resolveRequestSource()`, `checkSourceRateLimit()`, or
// `getActivationPageState()` (removed as dead code, D-038 Section 8) — no
// per-request server work of any kind, since the raw token now travels
// only in a URL fragment (D-038 Section 2), which this Server Component
// never receives and could not read even if it wanted to (a fragment is
// never part of any HTTP request, RFC 3986 §3.5). It always renders the
// identical, fixed, non-enumerating Continue state; every other
// determination (missing/malformed/expired/revoked/already-activated
// token) is made client-side, only once the user actually invokes
// Continue or Activate (`ActivationForm`). `Cache-Control: no-store` and
// `Referrer-Policy: no-referrer` are set unconditionally by
// `next.config.ts`'s own scoped `headers()` matcher for this exact path —
// not by this component. This route's output never varies by request, so
// — unlike the removed `/activate/[token]` route — it declares no
// `dynamic`/`runtime` export and may be statically rendered (D-038
// Section 3's own named, structural relaxation).
export default function ActivatePage() {
  return (
    <main>
      <h1>Activate your account</h1>
      <ActivationForm />
    </main>
  );
}
