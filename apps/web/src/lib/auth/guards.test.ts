import { beforeEach, describe, expect, it, vi } from 'vitest';

// `./auth` eagerly validates env vars and constructs the Prisma/Better Auth
// clients at import time (see auth.ts), so it must be mocked before
// `./guards` is imported — vi.mock calls are hoisted above imports, and
// vi.hoisted() is required to reference `getSessionMock` from inside the
// (also hoisted) mock factory below.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock('./auth', () => ({
  auth: { api: { getSession: getSessionMock } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

import { getCurrentSession, getCurrentUser, withRole, type AuthenticatedUser } from './guards';

const CLIENT_USER = {
  id: 'user-1',
  email: 'client@example.test',
  name: 'Client User',
  role: 'CLIENT' as const,
};

const ADMIN_USER = {
  id: 'user-2',
  email: 'admin@example.test',
  name: 'Admin User',
  role: 'ADMIN_MANAGER' as const,
};

function request(): Request {
  return new Request('http://localhost/api/test');
}

// What Next.js's App Router actually passes as a route handler's second
// argument for a route with no dynamic segments — an empty params object,
// not the absence of a second argument at all (see guards.ts's
// `RouteContext` doc comment).
function staticContext(): { params: Promise<Record<string, never>> } {
  return { params: Promise.resolve({}) };
}

describe('withRole', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it('returns a 401 error envelope and never calls the handler when unauthenticated', async () => {
    getSessionMock.mockResolvedValue(null);
    const handler = vi.fn();

    const response = await withRole(undefined, handler)(request(), staticContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns a 403 error envelope and never calls the handler when authenticated but not in allowedRoles', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER });
    const handler = vi.fn();

    const response = await withRole(['ADMIN_MANAGER'], handler)(request(), staticContext());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'FORBIDDEN', message: 'You do not have permission to access this resource.' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes the handler with the authenticated user when authorized, given a static route context shaped as { params: Promise<{}> }', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_USER });
    // This handler ignores route context entirely (only destructures
    // `user`) — the same shape as the project's real non-dynamic route
    // handlers (e.g. api/me/route.ts, api/staff/route.ts). It must keep
    // working unchanged even though `withRole` now always receives a real
    // `{ params }` context from Next.js.
    const handler = vi.fn(async (_request: Request, { user }: { user: AuthenticatedUser }) =>
      Response.json({ receivedRole: user.role }),
    );

    const response = await withRole(['ADMIN_MANAGER'], handler)(request(), staticContext());

    expect(handler).toHaveBeenCalledTimes(1);
    const [, context] = handler.mock.calls[0] as [
      Request,
      { user: AuthenticatedUser; params: Promise<Record<string, never>> },
    ];
    expect(context.user).toEqual(ADMIN_USER);
    await expect(context.params).resolves.toEqual({});
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ receivedRole: 'ADMIN_MANAGER' });
  });

  it('returns a consistent 500 error envelope — never the raw error — when the handler throws unexpectedly', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_USER });
    const handler = vi.fn(async () => {
      throw new Error('boom: internal detail that must never reach the client');
    });

    const response = await withRole(undefined, handler)(request(), staticContext());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
  });

  it('forwards a dynamic route context (e.g. { params: Promise<{ id: string }> }) to the handler alongside user', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_USER });
    const handler = vi.fn(
      async (
        _request: Request,
        { user, params }: { user: AuthenticatedUser; params: Promise<{ id: string }> },
      ) => Response.json({ receivedRole: user.role, id: (await params).id }),
    );

    const guarded = withRole<{ id: string }>(['ADMIN_MANAGER'], handler);
    const response = await guarded(request(), { params: Promise.resolve({ id: 'staff-123' }) });

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      receivedRole: 'ADMIN_MANAGER',
      id: 'staff-123',
    });
  });

  it('uses the same { error: { code, message } } envelope shape across every failure case', async () => {
    getSessionMock.mockResolvedValue(null);
    const unauthenticated = await withRole(undefined, vi.fn())(request(), staticContext());
    const unauthenticatedBody = (await unauthenticated.json()) as {
      error: { code: string; message: string };
    };

    getSessionMock.mockResolvedValue({ user: CLIENT_USER });
    const forbidden = await withRole(['ADMIN_MANAGER'], vi.fn())(request(), staticContext());
    const forbiddenBody = (await forbidden.json()) as { error: { code: string; message: string } };

    for (const body of [unauthenticatedBody, forbiddenBody]) {
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    }
  });
});

describe('getCurrentSession (D-047 §8)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  // A full Better Auth session row — every field except `id` must be absent
  // from what getCurrentSession returns.
  const SESSION = {
    id: 'session-abc123',
    token: 'tok_secret_must_never_leak',
    userId: 'user-1',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-09T00:00:00.000Z'),
    updatedAt: new Date('2026-09-09T00:00:00.000Z'),
    ipAddress: '203.0.113.7',
    userAgent: 'stage-2-test-agent',
  };

  it('returns null when there is no session at all', async () => {
    getSessionMock.mockResolvedValue(null);
    expect(await getCurrentSession()).toBeNull();
  });

  it('returns null when a session exists but carries no user', async () => {
    getSessionMock.mockResolvedValue({ session: SESSION });
    expect(await getCurrentSession()).toBeNull();
  });

  it('fails closed (null) when session.id is missing', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER, session: { token: 'tok_x' } });
    expect(await getCurrentSession()).toBeNull();
  });

  it('fails closed (null) when session.id is an empty string', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER, session: { ...SESSION, id: '' } });
    expect(await getCurrentSession()).toBeNull();
  });

  it('returns the exact AuthenticatedUser shape plus the live Session.id when authenticated', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER, session: SESSION });

    const result = await getCurrentSession();

    expect(result).toEqual({ user: CLIENT_USER, sessionId: 'session-abc123' });
  });

  it('exposes only { user, sessionId } — never Session.token or any other Better Auth session field', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER, session: SESSION });

    const result = await getCurrentSession();

    expect(Object.keys(result!).sort()).toEqual(['sessionId', 'user']);
    expect(Object.keys(result!.user).sort()).toEqual(['email', 'id', 'name', 'role']);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('tok_secret_must_never_leak');
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('stage-2-test-agent');
    expect(serialized).not.toContain('expiresAt');
  });

  it('applies the same role normalization as getCurrentUser — the returned user is identical for the same session', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_USER, session: SESSION });
    const fromSession = await getCurrentSession();

    getSessionMock.mockResolvedValue({ user: ADMIN_USER, session: SESSION });
    const fromUser = await getCurrentUser();

    expect(fromSession?.user).toEqual(ADMIN_USER);
    expect(fromSession?.user).toEqual(fromUser);
  });

  it('performs exactly one auth.api.getSession lookup per invocation', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER, session: SESSION });

    await getCurrentSession();

    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });
});

describe('getCurrentUser (unchanged public contract)', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it('returns null when unauthenticated', async () => {
    getSessionMock.mockResolvedValue(null);
    expect(await getCurrentUser()).toBeNull();
  });

  it('returns exactly { id, email, name, role } and nothing else for an authenticated user', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER, session: { id: 'session-abc123' } });

    const user = await getCurrentUser();

    expect(user).toEqual(CLIENT_USER);
    expect(Object.keys(user!).sort()).toEqual(['email', 'id', 'name', 'role']);
  });

  it('still performs exactly one auth.api.getSession lookup per invocation', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER, session: { id: 'session-abc123' } });

    await getCurrentUser();

    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });
});
