import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@/lib/auth/guards';

// Database-backed integration test satisfying docs/HERITAGE_V3_DECISIONS_LOG.md
// D-012's Effect clause: "Direct credential provisioning... must be covered by
// an integration test in the staff-management-service checkpoint that
// verifies the created account can actually authenticate through the normal
// Better Auth sign-in path — not merely that a database row was written
// correctly." Every mocked test elsewhere in this repository (service.test.ts,
// the four apps/web/src/app/api/staff/**/route.test.ts files) intentionally
// mocks the repository, Prisma, and Better Auth's session lookup — none of
// them can prove this. This file proves it for real, against a dedicated,
// disposable PostgreSQL database — never the shared local `heritage_v3_dev`
// database — using the repository's own real, unmodified `createStaffAccount`,
// `deactivateStaffAccount`, and `auth` (Better Auth) exports.
//
// IMPORT SAFETY: this file must not statically import `@/lib/db`,
// `@/lib/auth/auth`, `@/lib/env`, or `@/features/staff/service` — every one
// of those eagerly validates environment variables and/or opens a real
// database adapter at module-import time (matching the same reason
// service.test.ts and every route.test.ts mock `@/lib/db`/`@/lib/auth/auth`
// before importing anything that transitively pulls them in). Since this file
// instead needs the *real*, unmocked versions of those modules, the only safe
// way to get them is to set `process.env.DATABASE_URL` (and, only if absent,
// `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`) to safety-validated values *before*
// ever importing them, then import them dynamically (`await import(...)`)
// inside `beforeAll` — never as a top-level `import` statement, which Vitest
// would hoist and execute before any of this file's own code runs. The only
// top-level imports here are Vitest itself, a Node standard-library helper,
// and a type-only import (`import type`, erased entirely at build time — it
// causes no runtime module evaluation) for a shared type shape.
//
// SKIP/FAIL SEMANTICS: when `TEST_DATABASE_URL` is unset (the default — this
// is true in CI today and for any developer who hasn't provisioned a
// disposable test database), the entire suite is conditionally skipped via
// `describe.skipIf`, and none of the above dynamic imports or database
// connections ever happen — `pnpm test` remains safe by default. When
// `TEST_DATABASE_URL` *is* set, the suite is not skipped, and the very first
// thing `beforeAll` does is validate it; an unsafe or malformed value throws
// immediately (a loud test failure), never a silent skip.

const REQUIRED_TEST_DATABASE_NAME = 'heritage_v3_test';
const ALLOWED_TEST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const ALLOWED_TEST_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

/**
 * Parses and validates `TEST_DATABASE_URL` without ever interpolating the raw
 * connection string (which may contain a password) into a thrown message —
 * only the individually-parsed protocol/hostname/database-name components are
 * ever included, mirroring apps/web/src/lib/env.ts's own discipline. Throws
 * (never returns false, never silently skips) on any violation — this is the
 * database-safety guard that must run before any application import,
 * environment mutation, or connection attempt.
 */
function validateTestDatabaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL is not a valid URL. Refusing to run the staff authentication integration suite.',
    );
  }

  if (!ALLOWED_TEST_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `TEST_DATABASE_URL must use the postgresql:// or postgres:// protocol (got "${parsed.protocol}"). Refusing to proceed.`,
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_TEST_HOSTNAMES.has(hostname)) {
    throw new Error(
      `TEST_DATABASE_URL hostname must be localhost, 127.0.0.1, or ::1 (got "${hostname}"). Refusing to run against a non-local host.`,
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName !== REQUIRED_TEST_DATABASE_NAME) {
    throw new Error(
      `TEST_DATABASE_URL must target the "${REQUIRED_TEST_DATABASE_NAME}" database (got "${databaseName || '(empty)'}"). Refusing to run against any other database, including heritage_v3_dev.`,
    );
  }

  if (!parsed.username) {
    throw new Error('TEST_DATABASE_URL must include a non-empty username. Refusing to proceed.');
  }
}

const rawTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasTestDatabaseUrl = typeof rawTestDatabaseUrl === 'string' && rawTestDatabaseUrl.length > 0;

// Captured before any mutation, so `afterAll` can restore the process
// environment exactly as it found it — this file runs inside a shared
// Vitest worker process, and `process.env` mutations are not automatically
// isolated per test file the way the module registry is.
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;

describe.skipIf(!hasTestDatabaseUrl)('staff authentication integration (real database)', () => {
  // Populated by beforeAll via dynamic import, once TEST_DATABASE_URL has
  // passed validation — see the module doc comment above for why these
  // cannot be static top-level imports.
  let prisma: (typeof import('@/lib/db'))['prisma'] | undefined;
  let auth: (typeof import('@/lib/auth/auth'))['auth'];
  let createStaffAccount: (typeof import('@/features/staff/service'))['createStaffAccount'];
  let deactivateStaffAccount: (typeof import('@/features/staff/service'))['deactivateStaffAccount'];

  let actor: AuthenticatedUser;
  let actorId = '';
  let didSetBetterAuthSecret = false;
  let didSetBetterAuthUrl = false;

  // Every subject User this run creates, tracked by its unique email —
  // recorded *before* each createStaffAccount call, not after, so a subject
  // whose creation throws partway through is still cleaned up correctly (see
  // the module doc comment and afterAll below).
  const createdSubjectEmails: string[] = [];

  beforeAll(async () => {
    // 1. Safety guard — must run before any env mutation, import, or
    // connection. Throws loudly (a failed beforeAll, not a skip) if unsafe.
    validateTestDatabaseUrl(rawTestDatabaseUrl!);

    // 2. Establish the environment the real modules will read at import time.
    process.env.DATABASE_URL = rawTestDatabaseUrl;
    if (!process.env.BETTER_AUTH_SECRET) {
      process.env.BETTER_AUTH_SECRET =
        'integration-test-only-secret-not-a-real-credential-0000000000';
      didSetBetterAuthSecret = true;
    }
    if (!process.env.BETTER_AUTH_URL) {
      process.env.BETTER_AUTH_URL = 'http://localhost:3000';
      didSetBetterAuthUrl = true;
    }

    // 3. Only now — dynamically — import the real, unmocked application
    // modules. This is the repository's actual exported `prisma` singleton
    // and actual exported `auth` (Better Auth) instance, constructed from
    // the same production configuration every other code path uses, now
    // bound to TEST_DATABASE_URL because of step 2 above.
    ({ prisma } = await import('@/lib/db'));
    ({ auth } = await import('@/lib/auth/auth'));
    ({ createStaffAccount, deactivateStaffAccount } = await import('@/features/staff/service'));

    // Independent, post-connection confirmation that the real client is
    // actually talking to heritage_v3_test — a second, defense-in-depth
    // check beyond the pre-connection URL parse above. No fixture is created
    // until this passes.
    const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
    if (rows[0]?.current_database !== REQUIRED_TEST_DATABASE_NAME) {
      throw new Error(
        `Refusing to proceed: the connected database reports current_database() = "${rows[0]?.current_database}", not "${REQUIRED_TEST_DATABASE_NAME}".`,
      );
    }

    // The SYSTEM_ADMINISTRATOR actor fixture. Required because
    // createStaffAccount's own STAFF_ACCOUNT_CREATED AuditLog write
    // references actorId through a real foreign key (AuditLog.actorId,
    // onDelete: Restrict) — there is no pre-existing row to rely on in a
    // freshly disposable database, and this test must not assume the dev
    // seed script has ever been run against it.
    actorId = randomUUID();
    const actorEmail = `staff-integration-actor-${randomUUID()}@example.test`;
    const actorName = 'Integration Test Actor';
    await prisma.user.create({
      data: {
        id: actorId,
        name: actorName,
        email: actorEmail,
        role: 'SYSTEM_ADMINISTRATOR',
        isActive: true,
      },
    });
    actor = { id: actorId, name: actorName, email: actorEmail, role: 'SYSTEM_ADMINISTRATOR' };
  });

  afterAll(async () => {
    if (!prisma) {
      // beforeAll failed before a connection was ever established (e.g. the
      // safety guard threw) — nothing was created, nothing to clean up.
      return;
    }

    try {
      // Required order: AuditLog rows referencing the actor must be deleted
      // before the actor User row itself (AuditLog.actorId has
      // onDelete: Restrict). Subject Users are deleted by their exact,
      // unique email — never a pattern match — and their Session/Account/
      // StaffProfile rows are removed automatically via the schema's
      // onDelete: Cascade on each of those relations to User.
      if (actorId) {
        await prisma.auditLog.deleteMany({ where: { actorId } });
      }
      for (const email of createdSubjectEmails) {
        await prisma.user.deleteMany({ where: { email } });
      }
      if (actorId) {
        await prisma.user.deleteMany({ where: { id: actorId } });
      }
    } finally {
      // Always disconnect and restore the process environment, even if a
      // deletion above threw — that failure still propagates from this
      // afterAll (Vitest reports hook failures independently of test
      // failures, so a genuine test-body failure is never hidden by a
      // cleanup failure, and vice versa).
      await prisma.$disconnect();

      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
      if (didSetBetterAuthSecret) {
        if (originalBetterAuthSecret === undefined) {
          delete process.env.BETTER_AUTH_SECRET;
        } else {
          process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
        }
      }
      if (didSetBetterAuthUrl) {
        if (originalBetterAuthUrl === undefined) {
          delete process.env.BETTER_AUTH_URL;
        } else {
          process.env.BETTER_AUTH_URL = originalBetterAuthUrl;
        }
      }
    }
  });

  it('authenticates a staff account created with a service-generated password', async () => {
    const email = `staff-integration-generated-${randomUUID()}@example.test`;
    createdSubjectEmails.push(email);

    const { account, initialPassword } = await createStaffAccount(actor, {
      name: 'Generated Password Subject',
      email,
      role: 'TRAVEL_CONSULTANT',
    });

    expect(initialPassword).toBeTruthy();
    expect(initialPassword.length).toBeGreaterThan(0);

    const signInResult = await auth.api.signInEmail({
      body: { email, password: initialPassword },
    });

    expect(signInResult.user.id).toBe(account.id);
    expect(typeof signInResult.token).toBe('string');
    expect(signInResult.token.length).toBeGreaterThan(0);

    const sessions = await prisma!.session.findMany({ where: { userId: account.id } });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('authenticates a staff account created with a caller-supplied password', async () => {
    const email = `staff-integration-supplied-${randomUUID()}@example.test`;
    createdSubjectEmails.push(email);
    const suppliedPassword = `Integration-Test-Supplied-Password-${randomUUID()}`;

    const { account, initialPassword } = await createStaffAccount(actor, {
      name: 'Supplied Password Subject',
      email,
      role: 'FINANCE_ACCOUNTING',
      password: suppliedPassword,
    });

    expect(initialPassword).toBe(suppliedPassword);

    const signInResult = await auth.api.signInEmail({
      body: { email, password: suppliedPassword },
    });

    expect(signInResult.user.id).toBe(account.id);
    expect(typeof signInResult.token).toBe('string');
    expect(signInResult.token.length).toBeGreaterThan(0);

    const sessions = await prisma!.session.findMany({ where: { userId: account.id } });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // This is a staff-management security contract, not merely a coverage
  // exercise: if the current production configuration does not actually
  // block a deactivated account from signing back in, this assertion must
  // fail truthfully once run against a real database. It is deliberately
  // unconditional and must not be weakened, softened, or removed.
  it('rejects sign-in after the account is deactivated, with sessions revoked and no new session created', async () => {
    const email = `staff-integration-deactivate-${randomUUID()}@example.test`;
    createdSubjectEmails.push(email);

    const { account, initialPassword } = await createStaffAccount(actor, {
      name: 'Deactivation Subject',
      email,
      role: 'VISA_DOCUMENTATION',
    });

    // Prove the credential works once, before deactivation.
    const firstSignIn = await auth.api.signInEmail({
      body: { email, password: initialPassword },
    });
    expect(firstSignIn.user.id).toBe(account.id);
    expect(typeof firstSignIn.token).toBe('string');

    const sessionsAfterFirstSignIn = await prisma!.session.findMany({
      where: { userId: account.id },
    });
    expect(sessionsAfterFirstSignIn.length).toBeGreaterThan(0);

    const deactivated = await deactivateStaffAccount(
      actor,
      account.id,
      'Integration test deactivation',
    );
    expect(deactivated.isActive).toBe(false);

    const sessionsAfterDeactivation = await prisma!.session.findMany({
      where: { userId: account.id },
    });
    expect(sessionsAfterDeactivation.length).toBe(0);

    await expect(
      auth.api.signInEmail({ body: { email, password: initialPassword } }),
    ).rejects.toBeTruthy();

    const sessionsAfterRejectedSignIn = await prisma!.session.findMany({
      where: { userId: account.id },
    });
    expect(sessionsAfterRejectedSignIn.length).toBe(0);
  });
});
