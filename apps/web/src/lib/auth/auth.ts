import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import { prisma } from '@/lib/db';
import { getServerEnv } from '@/lib/env';

import { assertAccountIsActive } from './account-status';
import { ROLES } from './roles';

const env = getServerEnv();

// Better Auth server configuration — the shared identity/session system for
// staff and clients (blueprint Section 4; ADR-001). Selected and documented
// in docs/HERITAGE_V3_DECISIONS_LOG.md D-011.
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,

  // No `secondaryStorage` is configured, so sessions are stored in — and
  // read from — the database (the `Session` model) by default: the
  // database-backed session state ADR-001 calls for.
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  emailAndPassword: {
    enabled: true,
    // Blueprint Section 7: "The initial release uses invitation-based
    // signup only... Public self-service account creation is not part of
    // the initial release." Sign-IN stays enabled; only the public sign-UP
    // endpoint is blocked. Accounts are created out-of-band today (the
    // Phase 1 dev seed script) and, in a later phase, through the real
    // portal-invitation flow — never through this generic endpoint.
    disableSignUp: true,
  },

  user: {
    additionalFields: {
      role: {
        // A literal-string union, not a free-form string — Better Auth
        // validates the field's TypeScript type against exactly these six
        // blueprint-approved roles (blueprint Section 4).
        type: [...ROLES],
        required: true,
        defaultValue: 'CLIENT',
        // `input: false` is a second, independent guard (beyond
        // `disableSignUp`) against role self-elevation: even if a client
        // sends `role` in a request body, Better Auth silently ignores it
        // and applies `defaultValue` instead (.claude/rules/admin-
        // dashboard.md's mass-assignment rule). Only a direct, trusted
        // server-side write (e.g. the seed script, or a future authorized
        // staff-management feature) may set a user's role.
        input: false,
      },
    },
  },

  // Blocks a deactivated account (blueprint Section 4.1's "deactivate
  // platform user accounts"; see the staff-management service and the
  // schema invariants in apps/web/prisma/schema.prisma) from creating a
  // new session, i.e. from signing back in — without this, deactivation
  // would only revoke a user's *existing* sessions and be trivially
  // bypassed by signing in again. Runs on every session creation
  // (sign-in), not just staff-management's own writes, since `isActive`
  // is a shared User field. See src/lib/auth/account-status.ts for why
  // the check itself lives in a separate, unit-testable module.
  databaseHooks: {
    session: {
      create: {
        async before(session) {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { isActive: true },
          });
          assertAccountIsActive(user);
        },
      },
    },
  },
});
