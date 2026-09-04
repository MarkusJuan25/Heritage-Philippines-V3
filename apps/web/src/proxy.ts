import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

// Layer 1 of D-023 §2's / D-040 §2's defense-in-depth authorization for the
// authenticated /admin and /client namespaces: an optimistic,
// cookie-presence-only check (Next.js's own documented "optimistic check"
// pattern for Proxy) — no database query, no role value is read or trusted.
// This alone is never authoritative; the matching Server Component layout
// (Layer 2 — app/admin/layout.tsx, app/client/layout.tsx) and each page
// (Layer 3) independently re-verify the real, database-backed session and
// role. For /client specifically, D-040 §2 adds Layer 4: each owning-feature
// CLIENT-safe read re-checks canAccessClient before returning any row.
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/client/:path*'],
};
