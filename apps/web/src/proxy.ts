import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

// Layer 1 of D-023 §2's defense-in-depth authorization for the /admin
// namespace: an optimistic, cookie-presence-only check (Next.js's own
// documented "optimistic check" pattern for Proxy) — no database query, no
// role value is read or trusted. This alone is never authoritative;
// app/admin/layout.tsx (Layer 2) and each /admin/leads/** page (Layer 3)
// independently re-verify the real, database-backed session and role.
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
