import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getSessionCookieMock } = vi.hoisted(() => ({ getSessionCookieMock: vi.fn() }));
vi.mock('better-auth/cookies', () => ({ getSessionCookie: getSessionCookieMock }));

import { proxy } from './proxy';

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
});
