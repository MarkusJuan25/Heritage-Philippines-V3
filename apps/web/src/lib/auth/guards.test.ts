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

describe('withRole', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it('returns a 401 error envelope and never calls the handler when unauthenticated', async () => {
    getSessionMock.mockResolvedValue(null);
    const handler = vi.fn();

    const response = await withRole(undefined, handler)(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns a 403 error envelope and never calls the handler when authenticated but not in allowedRoles', async () => {
    getSessionMock.mockResolvedValue({ user: CLIENT_USER });
    const handler = vi.fn();

    const response = await withRole(['ADMIN_MANAGER'], handler)(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'FORBIDDEN', message: 'You do not have permission to access this resource.' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes the handler with the authenticated user when authorized', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_USER });
    const handler = vi.fn(async (_request: Request, { user }: { user: AuthenticatedUser }) =>
      Response.json({ receivedRole: user.role }),
    );

    const response = await withRole(['ADMIN_MANAGER'], handler)(request());

    expect(handler).toHaveBeenCalledTimes(1);
    const [, context] = handler.mock.calls[0] as [Request, { user: AuthenticatedUser }];
    expect(context.user).toEqual(ADMIN_USER);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ receivedRole: 'ADMIN_MANAGER' });
  });

  it('returns a consistent 500 error envelope — never the raw error — when the handler throws unexpectedly', async () => {
    getSessionMock.mockResolvedValue({ user: ADMIN_USER });
    const handler = vi.fn(async () => {
      throw new Error('boom: internal detail that must never reach the client');
    });

    const response = await withRole(undefined, handler)(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
  });

  it('uses the same { error: { code, message } } envelope shape across every failure case', async () => {
    getSessionMock.mockResolvedValue(null);
    const unauthenticated = await withRole(undefined, vi.fn())(request());
    const unauthenticatedBody = (await unauthenticated.json()) as {
      error: { code: string; message: string };
    };

    getSessionMock.mockResolvedValue({ user: CLIENT_USER });
    const forbidden = await withRole(['ADMIN_MANAGER'], vi.fn())(request());
    const forbiddenBody = (await forbidden.json()) as { error: { code: string; message: string } };

    for (const body of [unauthenticatedBody, forbiddenBody]) {
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    }
  });
});
