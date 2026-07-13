import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from './auth';
import { authorize } from './authorize';
import type { AppRole } from './roles';

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  role: AppRole;
};

/**
 * Reads the current request's session server-side (database-backed —
 * Section 12 of docs/HERITAGE_V3_ENVIRONMENT_CONFIGURATION.md). Returns
 * null if there is no valid session; callers decide what "no session"
 * means for their context (redirect for pages, 401 for API routes) rather
 * than this helper assuming one.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result?.user) {
    return null;
  }

  const user = result.user as typeof result.user & { role: AppRole };
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export class AuthorizationError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
  }
}

/**
 * Authentication + authorization for a Server Component or route handler
 * that requires a signed-in user, per .claude/rules/backend.md's
 * "Authentication vs. Authorization" rule: a valid session alone is
 * checked first (401 if absent), then — only if `allowedRoles` is given —
 * whether that specific identity's role is one of them (403 otherwise). A
 * valid session never implies authorization on its own.
 */
export async function requireUser(allowedRoles?: readonly AppRole[]): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  const result = authorize(user?.role ?? null, allowedRoles);

  if (!result.authorized) {
    const message =
      result.status === 401
        ? 'Authentication required.'
        : 'You do not have permission to access this resource.';
    throw new AuthorizationError(result.status, message);
  }

  // authorize() only returns { authorized: true } when its `role` argument
  // was non-null, which only happens here when getCurrentUser() returned a
  // user — so `user` is guaranteed non-null at this point.
  return user as AuthenticatedUser;
}

type RoleGuardedHandler = (
  request: Request,
  context: { user: AuthenticatedUser },
) => Promise<Response> | Response;

/**
 * Wraps a route handler with a role guard, returning the consistent
 * `{ error: { code, message } }` envelope .claude/rules/backend.md requires
 * — never a stack trace or internal error detail — for both the 401/403
 * cases and any unexpected failure inside the handler itself.
 */
export function withRole(
  allowedRoles: readonly AppRole[] | undefined,
  handler: RoleGuardedHandler,
) {
  return async (request: Request): Promise<Response> => {
    try {
      const user = await requireUser(allowedRoles);
      return await handler(request, { user });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return NextResponse.json(
          {
            error: {
              code: error.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN',
              message: error.message,
            },
          },
          { status: error.status },
        );
      }

      // Never leak internal error details to the client
      // (.claude/rules/backend.md's "No secret or sensitive-error
      // exposure" / "Consistent Error Responses" rules).
      console.error('Unhandled error in a role-guarded route handler:', error);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } },
        { status: 500 },
      );
    }
  };
}
