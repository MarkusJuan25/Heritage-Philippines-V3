import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // D-034 Section 5; D-037 Section 13: the public activation page has no
  // framework-native way to set outgoing response headers from within a
  // Server Component — `next/headers`'s `headers()` is read-only for the
  // incoming request. This scoped `headers()` config is the mechanism
  // that route requires; the two activation API routes set the identical
  // headers directly on their own `NextResponse` instead
  // (features/activation/http.ts's `jsonResponse`).
  async headers() {
    return [
      {
        source: '/activate/:token*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
