import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

import {
  describeValidatedDatabaseSafely,
  getValidatedTestDatabaseUrl,
  startE2EPrismaRpcServer,
} from './test-database';

// D-033 §6: fixed orchestration order — (1) validate TEST_DATABASE_URL,
// (2) generate the ephemeral Better Auth secret, (3) construct the
// explicit child environment, (4) start the real-Prisma RPC bridge
// (§5a), (5) build apps/web, (6) invoke Playwright, (7) close the RPC
// bridge, (8) propagate any nonzero build or test exit status.
// Cross-platform: resolves the pnpm executable per-platform. No dynamic,
// user-controlled, or credential-bearing value is ever concatenated into
// a command string — `command`/`args` are static literals throughout,
// and credentials travel only via `env`; on Windows this still requires
// `shell: true` to launch the `pnpm.cmd` shim (Node's own documented
// mechanism, also used internally by Playwright's own webServer
// launcher), since this project's primary development environment is
// Windows Command Prompt.

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const E2E_PORT = 3100;
const E2E_RPC_PORT = 3101;
const E2E_HOST = '127.0.0.1';

// Preserve only the defined inherited variables genuinely needed for
// executable resolution/runtime — never blindly spread the full parent
// environment, which would otherwise carry the developer's own
// DATABASE_URL/BETTER_AUTH_* values through unless explicitly overridden
// below (D-033 §5).
const INHERITED_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'ComSpec',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'HOME',
] as const;

function buildChildEnv(
  databaseUrl: string,
  betterAuthSecret: string,
  activationRateLimitHmacSecret: string,
): NodeJS.ProcessEnv {
  const inherited: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    // Never convert an undefined value into the literal string
    // "undefined" (D-033 §6).
    if (value !== undefined) {
      inherited[key] = value;
    }
  }

  return {
    ...inherited,
    // Also exposed under its own conventional name so playwright.config.ts,
    // fixtures.ts, and the spec's own assertion code can each
    // independently re-validate through the identical canonical validator
    // (D-033 §5) — the same already-validated value, never a second,
    // different one.
    TEST_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_URL: `http://${E2E_HOST}:${E2E_PORT}`,
    BETTER_AUTH_SECRET: betterAuthSecret,
    // D-034 Stage 5e (D-037 Section 11/16): a second, independently
    // generated secret — never derived from or equal to betterAuthSecret
    // above, mirroring that value's own generation exactly (a fresh
    // randomBytes(32) call produces a statistically distinct value every
    // time; this is never a transform of the auth secret). Threaded only
    // through this child environment, never logged, never written to a
    // file.
    ACTIVATION_RATE_LIMIT_HMAC_SECRET: activationRateLimitHmacSecret,
    NODE_ENV: 'production',
  } satisfies Record<string, string> as NodeJS.ProcessEnv;
}

/**
 * If port 3100 is unexpectedly occupied, stop safely and report the
 * blocker rather than killing an unidentified process (D-033 Correction
 * Pass 3 §7). Never touches port 3000.
 */
async function assertPortFree(port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tester = createServer();
    tester.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} on ${host} is already in use. Refusing to start the isolated E2E server. Stop whatever is using it, or investigate, before retrying — this launcher never kills an unidentified process. The existing development server on port 3000 has not been touched.`,
          ),
        );
        return;
      }
      reject(error);
    });
    tester.once('listening', () => {
      tester.close(() => resolve());
    });
    tester.listen(port, host);
  });
}

/**
 * Asynchronous, not `execFileSync` — the real-Prisma RPC bridge
 * (`startE2EPrismaRpcServer`) runs its HTTP server in this exact same
 * process; a synchronous child-process call blocks the entire Node event
 * loop for as long as the child runs, which would starve that server and
 * make every RPC call from `fixtures.ts`/the spec hang indefinitely
 * (directly observed and confirmed as the cause of an earlier "Test
 * timeout ... while setting up tcAccount" failure). `spawn` keeps the
 * event loop free for the bridge to keep serving requests concurrently.
 */
function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    // Windows cannot launch a `.cmd` file (pnpm's own shim, resolved
    // above) directly via CreateProcess — only cmd.exe can. `shell: true`
    // is Node's own documented mechanism for this; `args` remains a
    // discrete array of static, non-interpolated literals throughout this
    // file (the env values are passed via `env`, never embedded into
    // `command`/`args` as a concatenated string), so this introduces no
    // argument-injection risk despite going through cmd.exe on Windows.
    const child = spawn(command, args, {
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(
        `${command} ${args.join(' ')} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}.`,
      );
      (error as { status?: number }).status = code ?? 1;
      reject(error);
    });
  });
}

async function main(): Promise<void> {
  const databaseUrl = getValidatedTestDatabaseUrl();
  // Non-secret confirmation only — never the URL, username, or password
  // (D-033 §5).
  console.log(describeValidatedDatabaseSafely());

  await assertPortFree(E2E_PORT, E2E_HOST);
  await assertPortFree(E2E_RPC_PORT, E2E_HOST);

  const betterAuthSecret = randomBytes(32).toString('base64');
  // D-034 Stage 5e: independently generated, never derived from
  // betterAuthSecret — see buildChildEnv's own doc comment.
  const activationRateLimitHmacSecret = randomBytes(32).toString('base64');
  const childEnv = buildChildEnv(databaseUrl, betterAuthSecret, activationRateLimitHmacSecret);

  // The generated Prisma client cannot be loaded from Playwright's own
  // CJS-`require`-based `.ts` loader — confirmed directly to fail with a
  // require-cycle error every time it is exercised inside Playwright's own
  // process; the exact underlying mechanism is not fully isolated
  // (test-database.ts has the full account, including why this is not
  // asserted as a universal rule). This process runs under `tsx`, a
  // genuine ESM-capable runtime that loads the identical file with no
  // issue in this separate context, so the one real PrismaClient lives
  // here, behind a localhost-only RPC bridge `fixtures.ts`/the spec talk
  // to over `fetch()` (`test-database.ts`'s `createE2EPrismaRpcClient`).
  console.log('Starting the real-Prisma RPC bridge for the E2E run...');
  const rpcServer = await startE2EPrismaRpcServer();

  try {
    console.log('Building apps/web (production build) for the isolated E2E server...');
    await runChild(pnpmExecutable, ['--filter', 'web', 'build'], childEnv);

    console.log('Running the Playwright E2E suite against the isolated server...');
    // D-034 Stage 5e: the tag-isolated expected-failure artifact-safety
    // probe (e2e/support/artifact-safety-probe.spec.ts) must never run as
    // part of this normal suite — it is designed to fail deliberately.
    // This CLI-level exclusion is the *only* place that exclusion lives;
    // playwright.config.ts deliberately sets no config-level grep/grepInvert
    // at all, since Playwright 1.62.1's own runner applies a config-level
    // grepInvert as an unconditional suite-load-time filter (verified
    // directly against the installed source,
    // node_modules/playwright/lib/runner/index.js) *before* any CLI-level
    // --grep the harness later supplies is ever evaluated — a config-level
    // exclusion here would silently defeat the harness's own positive
    // selection of that same test, producing a false "no tests found"
    // pass. Keeping the exclusion CLI-only, and only in this one
    // invocation, avoids that interaction entirely.
    await runChild(
      pnpmExecutable,
      ['--filter', 'web', 'exec', 'playwright', 'test', '--grep-invert', '@expected-failure-probe'],
      childEnv,
    );
  } finally {
    // Caught and reported here, rather than left to propagate, so a
    // shutdown-only failure can never mask a genuine build/test failure
    // already in flight from the try block above (Stage 2 Correction Pass
    // 2). Sanitized: only a safe error class name, never the underlying
    // error's raw message, stack, or cause.
    await rpcServer.close().catch((closeError: unknown) => {
      const className =
        closeError instanceof Error ? closeError.constructor.name : typeof closeError;
      console.error(`E2E RPC bridge shutdown reported a failure (${className}).`);
      process.exitCode = process.exitCode && process.exitCode !== 0 ? process.exitCode : 1;
    });
  }
}

main().catch((error: unknown) => {
  // Sanitized top-level failure reporting (D-033 §6): never the underlying
  // error's raw message, stack trace, or any credential-/connection-
  // bearing text — anywhere, including the RPC bridge's own local console
  // output (D-033 §5b, Stage 2 Correction Pass 2). Full diagnostic detail
  // for a build or test failure remains visible via the child processes'
  // own inherited stdio output, which streams before this handler ever
  // runs.
  const className = error instanceof Error ? error.constructor.name : typeof error;
  console.error(`E2E run failed (${className}).`);
  const status = (error as { status?: unknown }).status;
  process.exitCode = typeof status === 'number' && status !== 0 ? status : 1;
});
