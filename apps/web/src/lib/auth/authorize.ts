import type { AppRole } from './roles';

export type AuthorizationResult =
  | { authorized: true }
  | { authorized: false; status: 401; reason: 'unauthenticated' }
  | { authorized: false; status: 403; reason: 'forbidden' };

/**
 * Pure authorization decision, deliberately separated from session lookup
 * (guards.ts) so this "critical authorization behavior"
 * (.claude/rules/backend.md) can be unit-tested without a database, a
 * request, or Next.js's `headers()`.
 *
 * `role` is `null` when there is no authenticated session — checked first
 * (401), independently of `allowedRoles` (.claude/rules/backend.md's
 * "Authentication vs. Authorization": a valid session never implies
 * authorization on its own). When `allowedRoles` is omitted, any
 * authenticated role passes; when provided, `role` must be one of them
 * (403 otherwise).
 */
export function authorize(
  role: AppRole | null,
  allowedRoles?: readonly AppRole[],
): AuthorizationResult {
  if (!role) {
    return { authorized: false, status: 401, reason: 'unauthenticated' };
  }
  if (allowedRoles && !allowedRoles.includes(role)) {
    return { authorized: false, status: 403, reason: 'forbidden' };
  }
  return { authorized: true };
}
