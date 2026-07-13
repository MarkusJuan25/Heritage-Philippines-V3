import { z } from 'zod';

// Validates required server-only environment variables once, on first use,
// rather than at module-import time — importing this module (or anything
// that imports it) must never crash `next build` or `next lint` just
// because a real value isn't set yet (e.g. in CI, which never provisions a
// real database). Errors list which variable names are missing/invalid;
// they never include the value of any variable, per
// docs/HERITAGE_V3_ENVIRONMENT_CONFIGURATION.md and .claude/rules/backend.md.
const POSTGRES_PROTOCOLS = new Set(['postgresql:', 'postgres:']);

const serverEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (see apps/web/.env.example)')
    .refine(
      (value) => {
        try {
          return POSTGRES_PROTOCOLS.has(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      // Never interpolate the value itself into this message — a malformed
      // DATABASE_URL can still contain a real password.
      'DATABASE_URL must be a valid PostgreSQL connection string (postgresql:// or postgres://)',
    ),
  BETTER_AUTH_SECRET: z
    .string()
    .min(
      32,
      'BETTER_AUTH_SECRET must be at least 32 characters — generate one with `openssl rand -base64 32`',
    ),
  BETTER_AUTH_URL: z
    .string()
    .url('BETTER_AUTH_URL must be a valid URL, e.g. http://localhost:3000'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cachedEnv: ServerEnv | undefined;

/**
 * Returns the validated server-only environment. Throws a single error
 * listing every missing/invalid variable name (never a value) on first
 * call if validation fails; the result is memoized after a successful
 * parse so validation only runs once per process.
 */
export function getServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(
      [
        'Invalid or missing environment variables:',
        ...problems,
        'See apps/web/.env.example and docs/HERITAGE_V3_ENVIRONMENT_CONFIGURATION.md.',
      ].join('\n'),
    );
  }

  cachedEnv = result.data;
  return cachedEnv;
}
