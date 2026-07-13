import { APIError } from 'better-auth/api';

/**
 * Blocks sign-in for a deactivated platform account (blueprint Section 4.1
 * "deactivate platform user accounts"; apps/web/prisma/schema.prisma's
 * `User.isActive` invariants). Deliberately separated from auth.ts's
 * `databaseHooks` wiring — the same reason authorize.ts is separated from
 * guards.ts — so this "critical authorization behavior"
 * (.claude/rules/backend.md) can be unit-tested without constructing a
 * real Better Auth instance or database connection.
 *
 * Mirrors the shape of Better Auth's own admin-plugin banned-user check
 * (`databaseHooks.session.create.before` throwing `APIError.from(...)`),
 * without registering that plugin — see docs/HERITAGE_V3_DECISIONS_LOG.md
 * D-012.
 */
export function assertAccountIsActive(user: { isActive: boolean } | null | undefined): void {
  if (user && !user.isActive) {
    throw APIError.from('FORBIDDEN', {
      code: 'ACCOUNT_DEACTIVATED',
      message: 'This account has been deactivated. Contact a system administrator for assistance.',
    });
  }
}
