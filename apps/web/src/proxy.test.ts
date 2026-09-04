import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getSessionCookieMock } = vi.hoisted(() => ({ getSessionCookieMock: vi.fn() }));
vi.mock('better-auth/cookies', () => ({ getSessionCookie: getSessionCookieMock }));

import { config, proxy } from './proxy';

// Layer 1 of D-023 §2's defense-in-depth authorization for the /admin
// namespace (proxy.ts's own doc comment): a pure cookie-presence check —
// no database query, no role value read or trusted. `getSessionCookie` is
// this module's only dependency, mocked directly above; proxy.ts imports no
// `@/lib/db` module at all (confirmed by inspection), so no separate
// database-access mock is needed to prove this suite never touches a
// database — there is nothing here that could reach one.
describe('proxy', () => {
  it('redirects to /login when no session cookie is present, without touching a database', () => {
    getSessionCookieMock.mockReturnValue(null);
    const request = new NextRequest('https://example.test/admin/leads');

    const response = proxy(request);

    expect(getSessionCookieMock).toHaveBeenCalledWith(request);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.test/login');
  });

  it('returns NextResponse.next() when a session cookie is present, without touching a database', () => {
    getSessionCookieMock.mockReturnValue('a-session-cookie-value');
    const request = new NextRequest('https://example.test/admin/leads');

    const response = proxy(request);

    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
    // The precise, documented signature Next.js's own NextResponse.next()
    // sets internally — confirms this is genuinely the pass-through
    // response, not merely an ordinary 200.
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  // D-040 §2: the real exported matcher config is what Next.js uses to
  // decide which requests invoke `proxy` at all — `proxy(request)` itself
  // never inspects the path — so this asserts the actual `config.matcher`
  // export, not merely `proxy`'s behavior. It must gain `/client/:path*`
  // (which the `:path*` glob applies to `/client` and every `/client/**`
  // nested path) while preserving the existing `/admin/:path*` entry.
  it('exports a matcher covering both the /admin and /client namespaces, and nothing else', () => {
    expect(config.matcher).toEqual(['/admin/:path*', '/client/:path*']);
    expect(config.matcher).toContain('/admin/:path*');
    expect(config.matcher).toContain('/client/:path*');
  });

  // Layer 1 for the client portal is the identical cookie-presence-only
  // check — still no database, still no role read.
  it('redirects the exact base route /client to /login (307) when no session cookie is present', () => {
    getSessionCookieMock.mockReturnValue(null);
    const request = new NextRequest('https://example.test/client');

    const response = proxy(request);

    expect(getSessionCookieMock).toHaveBeenCalledWith(request);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://example.test/login');
  });

  it('returns NextResponse.next() for /client when a session cookie is present, without touching a database', () => {
    getSessionCookieMock.mockReturnValue('a-session-cookie-value');
    const request = new NextRequest('https://example.test/client');

    const response = proxy(request);

    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
