import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // D-034 Section 5; D-037 Section 13; D-038 Section 3/§7 (matcher
  // narrowed from `/activate/:token*` to the exact static path
  // `/activate`, since the route no longer takes a dynamic segment — the
  // raw token now travels only in a URL fragment, D-038 Section 2): the
  // public activation page has no framework-native way to set outgoing
  // response headers from within a Server Component — `next/headers`'s
  // `headers()` is read-only for the incoming request. This scoped
  // `headers()` config is the mechanism that route requires; the two
  // activation API routes set the identical headers directly on their
  // own `NextResponse` instead (features/activation/http.ts's
  // `jsonResponse`).
  async headers() {
    return [
      {
        source: '/activate',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      // D-040 §8: the authenticated /client portal is recomputed per request
      // from the caller's own session (layout.tsx / page.tsx also declare
      // `dynamic = 'force-dynamic'` / `revalidate = 0`). A Server Component
      // cannot set outgoing response headers from within itself, so this
      // scoped matcher is the framework-native mechanism — exactly as used
      // for /activate above. Sets only `Cache-Control: private, no-store`
      // and `Referrer-Policy: no-referrer`; no `Vary` key is set — the App
      // Router runtime appends its own framework-managed RSC `Vary` for
      // dynamic responses, and `private, no-store` makes a `Vary: Cookie`
      // token unnecessary for shared-cache isolation.
      {
        source: '/client/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
