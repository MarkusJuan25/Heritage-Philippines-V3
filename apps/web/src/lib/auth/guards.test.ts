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

import { withRole, type AuthenticatedUser } from './guards';

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
