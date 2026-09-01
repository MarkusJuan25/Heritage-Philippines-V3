import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateRandomString } from 'better-auth/crypto';

import { describeValidatedDatabaseSafely, getValidatedTestDatabaseUrl } from './test-database';

// D-034 Stage 5e (D-037 Section 15): the dedicated, controlled
// verification harness proving the expected-failure artifact-safety
// probe (artifact-safety-probe.spec.ts) genuinely runs, genuinely fails
// at its own deliberate assertion, and leaves no trace of the canary
// token it used anywhere this harness can observe. Distinct from, and
// never invoked by, `pnpm test:e2e` — its own `pnpm` command
// (`test:e2e:verify-artifact-safety`) is the only way to run it.
//
// This script runs under `tsx` (genuine ESM), exactly like run-e2e.ts —
// unlike a Playwright-loaded .spec.ts file, it can safely construct a
// real PrismaClient directly for its own post-run rate-limit cleanup
// (e2e/support/test-database.ts's own doc comment documents in detail
// why Playwright's own loader cannot do this). Deliberately does NOT
// import anything from run-e2e.ts — that module's own top-level code
// calls main() as a side effect of being imported at all; every constant
// and helper this file needs is duplicated locally instead, each citing
// its source of truth.

const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

// Mirrors playwright.config.ts's own E2E_PORT/E2E_HOST exactly — this
// harness's own Playwright invocation loads that identical config file,
// so it starts the identical webServer on this identical port.
const E2E_PORT = 3100;
const E2E_HOST = '127.0.0.1';

// Mirrors artifact-safety-probe.spec.ts's own two exported-in-spirit
// constants (duplicated, not imported — that file imports
// '@playwright/test' at module scope, which is only safe to load inside
// Playwright's own process, not under plain tsx execution).
const CANARY_ENV_VAR = 'ACTIVATION_ARTIFACT_PROBE_CANARY_TOKEN';
const EXPECTED_FAILURE_MARKER = 'EXPECTED_ACTIVATION_ARTIFACT_PROBE_FAILURE';
const PROBE_TAG = '@expected-failure-probe';
const PROBE_SPEC_PATH = 'e2e/support/artifact-safety-probe.spec.ts';

// Mirrors run-e2e.ts's own INHERITED_ENV_KEYS exactly — never spread the
// full parent environment.
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

function buildBaseChildEnv(
  databaseUrl: string,
  betterAuthSecret: string,
  activationRateLimitHmacSecret: string,
): NodeJS.ProcessEnv {
  const inherited: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return {
    ...inherited,
    TEST_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_URL: `http://${E2E_HOST}:${E2E_PORT}`,
    BETTER_AUTH_SECRET: betterAuthSecret,
    ACTIVATION_RATE_LIMIT_HMAC_SECRET: activationRateLimitHmacSecret,
    NODE_ENV: 'production',
  } satisfies Record<string, string> as NodeJS.ProcessEnv;
}

/** Mirrors run-e2e.ts's own assertPortFree exactly. */
async function assertPortFree(port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tester = createServer();
    tester.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} on ${host} is already in use. Refusing to start the artifact-safety verification run.`,
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

/** A syntactically valid, never-persisted 24-character canary — same shape/alphabet generateInvitationToken() produces. */
function generateCanary(): string {
  return generateRandomString(24, 'a-z', 'A-Z', '0-9', '-_');
}

/** Mirrors features/invitations/token.ts's hashInvitationToken exactly — duplicated, never imported (this harness must never import anything from src/features/**, keeping its own dependency surface minimal and self-contained). */
async function sha256Hex(value: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Runs a child to completion with inherited stdio (build output stays visible) — mirrors run-e2e.ts's own runChild exactly, including its async-not-execFileSync rationale. */
function runChildInherit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
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

type CapturedRun = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/**
 * Runs the probe child with piped, in-memory-captured stdio — never
 * inherited, since this child's own output can contain the canary. Never
 * rejects on a nonzero exit code: a nonzero exit is the *expected* normal
 * outcome here, so the caller performs its own structured verification
 * of exactly why the child exited nonzero, rather than this function
 * making that judgment via exit code alone.
 */
function runChildCaptured(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CapturedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'pipe', shell: process.platform === 'win32' });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

// --- Minimal, honest JSON-report shape this harness reads. Every field
// access below is guarded; a report that doesn't match this shape is
// treated as "malformed report" (an explicit failure), never assumed. ---

type JsonReportTestResult = { status?: unknown; error?: unknown; errors?: unknown };
type JsonReportTest = { status?: unknown; results?: unknown };
type JsonReportSpec = { title?: unknown; tests?: unknown };
type JsonReportSuite = { specs?: unknown; suites?: unknown };
type JsonReport = { suites?: unknown; errors?: unknown; stats?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectTests(report: JsonReport): JsonReportTest[] {
  const collected: JsonReportTest[] = [];
  function walkSuite(suite: unknown): void {
    if (!isRecord(suite)) return;
    const s = suite as JsonReportSuite;
    if (Array.isArray(s.specs)) {
      for (const spec of s.specs) {
        if (!isRecord(spec)) continue;
        const sp = spec as JsonReportSpec;
        if (Array.isArray(sp.tests)) {
          for (const t of sp.tests) {
            if (isRecord(t)) collected.push(t as JsonReportTest);
          }
        }
      }
    }
    if (Array.isArray(s.suites)) {
      for (const child of s.suites) walkSuite(child);
    }
  }
  if (Array.isArray(report.suites)) {
    for (const suite of report.suites) walkSuite(suite);
  }
  return collected;
}

function errorTextOf(result: JsonReportTestResult): string {
  const parts: string[] = [];
  if (typeof result.error === 'string') parts.push(result.error);
  else if (isRecord(result.error) && typeof result.error.message === 'string')
    parts.push(result.error.message);
  if (Array.isArray(result.errors)) {
    for (const e of result.errors) {
      if (typeof e === 'string') parts.push(e);
      else if (isRecord(e) && typeof e.message === 'string') parts.push(e.message);
    }
  }
  return parts.join('\n');
}

type VerificationOutcome = { ok: true } | { ok: false; reason: string };

/**
 * The full positive proof (D-037 Section 15 / this stage's authorization,
 * item 6): exactly one test ran, exactly one result exists for it, that
 * result's status is 'failed' (never 'skipped'/'timedOut'/'interrupted'),
 * its captured error contains the fixed marker, no top-level load/config
 * errors are present, and the child's own exit code is nonzero. Any
 * deviation is an explicit, named failure — never a default "assume
 * success."
 */
function verifyProbeOutcome(
  report: JsonReport | null,
  exitCode: number | null,
): VerificationOutcome {
  if (report === null) {
    return { ok: false, reason: 'the JSON report was missing or unreadable' };
  }
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    return {
      ok: false,
      reason: 'unrelated top-level load/config errors were present in the report',
    };
  }
  const tests = collectTests(report);
  if (tests.length === 0) {
    return { ok: false, reason: 'no tests ran (zero test entries in the report)' };
  }
  if (tests.length > 1) {
    return {
      ok: false,
      reason: `more than one test ran (${tests.length} test entries in the report)`,
    };
  }
  const [onlyTest] = tests;
  const results = Array.isArray(onlyTest?.results) ? (onlyTest.results as unknown[]) : [];
  if (results.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one result for the one test, found ${results.length}`,
    };
  }
  const [onlyResult] = results;
  if (!isRecord(onlyResult)) {
    return { ok: false, reason: 'the test result entry was malformed' };
  }
  const result = onlyResult as JsonReportTestResult;
  if (result.status !== 'failed') {
    return {
      ok: false,
      reason: `the test's result status was "${String(result.status)}", not "failed"`,
    };
  }
  const errorText = errorTextOf(result);
  if (!errorText.includes(EXPECTED_FAILURE_MARKER)) {
    return {
      ok: false,
      reason:
        'the captured error did not contain the expected failure marker — an unrelated assertion or error occurred',
    };
  }
  if (exitCode === 0) {
    return {
      ok: false,
      reason: 'the child process exited zero (the probe did not fail as designed)',
    };
  }
  if (exitCode === null) {
    return {
      ok: false,
      reason: 'the child process did not exit normally (it was signaled/killed)',
    };
  }
  return { ok: true };
}

// --- Canary scanning. Never interpolates the canary into any message
// this harness itself emits — only reports a boolean/count. ---

async function scanTextForCanary(text: string, canary: string): Promise<boolean> {
  return text.includes(canary);
}

async function scanFileForCanary(filePath: string, canary: string): Promise<boolean> {
  const buffer = await fs.readFile(filePath);
  return buffer.includes(Buffer.from(canary, 'utf8'));
}

async function scanDirectoryForCanary(dirPath: string, canary: string): Promise<boolean> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    // Directory may legitimately not exist (e.g. no artifacts were
    // produced at all, since trace/screenshot/video are all 'off') —
    // that is not itself a scan failure.
    return false;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (await scanDirectoryForCanary(entryPath, canary)) return true;
    } else if (entry.isFile()) {
      if (await scanFileForCanary(entryPath, canary)) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const databaseUrl = getValidatedTestDatabaseUrl();
  console.log(describeValidatedDatabaseSafely());
  console.log(
    '[verify-artifact-safety] Starting the D-037 Stage 5e expected-failure probe verification run...',
  );

  await assertPortFree(E2E_PORT, E2E_HOST);

  const betterAuthSecret = randomBytes(32).toString('base64');
  const activationRateLimitHmacSecret = randomBytes(32).toString('base64');
  const canary = generateCanary();
  const canaryTokenHash = await sha256Hex(canary);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'activation-artifact-probe-'));
  const jsonReportPath = path.join(tempDir, 'report.json');
  const probeOutputDir = path.join(tempDir, 'test-results');

  const baseChildEnv = buildBaseChildEnv(
    databaseUrl,
    betterAuthSecret,
    activationRateLimitHmacSecret,
  );

  let outcome: VerificationOutcome = { ok: false, reason: 'the verification run did not complete' };
  let canaryLeaked = false;
  let scanIncomplete = false;

  try {
    console.log('[verify-artifact-safety] Building apps/web (production build)...');
    await runChildInherit(pnpmExecutable, ['--filter', 'web', 'build'], baseChildEnv);

    console.log('[verify-artifact-safety] Running the isolated expected-failure probe...');
    const probeChildEnv: NodeJS.ProcessEnv = {
      ...baseChildEnv,
      [CANARY_ENV_VAR]: canary,
      PLAYWRIGHT_JSON_OUTPUT_FILE: jsonReportPath,
    };
    const run = await runChildCaptured(
      pnpmExecutable,
      [
        '--filter',
        'web',
        'exec',
        'playwright',
        'test',
        PROBE_SPEC_PATH,
        '--grep',
        PROBE_TAG,
        '--reporter=json',
        '--output',
        probeOutputDir,
      ],
      probeChildEnv,
    );

    let report: JsonReport | null = null;
    let rawReportText: string | null = null;
    try {
      rawReportText = await fs.readFile(jsonReportPath, 'utf8');
      report = JSON.parse(rawReportText) as JsonReport;
    } catch {
      report = null;
      rawReportText = null;
    }

    outcome = verifyProbeOutcome(report, run.exitCode);

    // Canary scan — independent of, and performed regardless of, the
    // structural outcome above. A clean structural outcome is not itself
    // sufficient; the canary must also be genuinely absent everywhere.
    try {
      const foundInStdout = await scanTextForCanary(run.stdout, canary);
      const foundInStderr = await scanTextForCanary(run.stderr, canary);
      const foundInReportText =
        rawReportText !== null && (await scanTextForCanary(rawReportText, canary));
      const foundInTempDir = await scanDirectoryForCanary(tempDir, canary);
      canaryLeaked = foundInStdout || foundInStderr || foundInReportText || foundInTempDir;
    } catch {
      scanIncomplete = true;
    }
  } finally {
    // Post-run rate-limit cleanup (this stage's own authorization, item
    // 4): the probe's real navigation increments the shared SOURCE
    // "unknown-source" bucket, and its computed TOKEN bucket for the
    // canary's own digest — the probe spec itself cannot rely on its own
    // afterEach for this, since it deliberately fails before any such
    // hook could run cleanly; this harness performs it directly, via its
    // own real Prisma connection (safe under tsx — never under
    // Playwright's own loader, see this file's header comment).
    try {
      process.env.DATABASE_URL = databaseUrl;
      const nativeDynamicImport = new Function('specifier', 'return import(specifier);') as (
        specifier: string,
      ) => Promise<unknown>;
      const adapterModule = (await nativeDynamicImport(
        '@prisma/adapter-pg',
      )) as typeof import('@prisma/adapter-pg');
      const clientModule = (await nativeDynamicImport(
        '@/generated/prisma/client',
      )) as typeof import('@/generated/prisma/client');
      const adapter = new adapterModule.PrismaPg({ connectionString: databaseUrl });
      const prisma = new clientModule.PrismaClient({ adapter });
      try {
        const sourceWindowMs = 15 * 60 * 1000; // mirrors features/activation/rate-limit.ts's SOURCE_WINDOW_MS
        const windowStart = new Date(Math.floor(Date.now() / sourceWindowMs) * sourceWindowMs);
        await prisma.rateLimitBucket.deleteMany({
          where: { dimension: 'SOURCE', bucketKey: 'unknown-source', windowStart },
        });
        await prisma.rateLimitBucket.deleteMany({
          where: { dimension: 'TOKEN', bucketKey: canaryTokenHash },
        });
      } finally {
        await prisma.$disconnect();
      }
    } catch (cleanupError) {
      const className =
        cleanupError instanceof Error ? cleanupError.constructor.name : typeof cleanupError;
      console.error(`[verify-artifact-safety] rate-limit cleanup failed (${className}).`);
      if (outcome.ok) {
        outcome = { ok: false, reason: 'post-run rate-limit cleanup failed' };
      }
    }

    // Remove only this harness's own temporary directory — never
    // apps/web/test-results or anything else.
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (rmError) {
      const className = rmError instanceof Error ? rmError.constructor.name : typeof rmError;
      console.error(`[verify-artifact-safety] temporary-directory cleanup failed (${className}).`);
      if (outcome.ok) {
        outcome = { ok: false, reason: 'temporary artifact directory cleanup failed' };
      }
    }
  }

  if (scanIncomplete) {
    console.error(
      '[verify-artifact-safety] FAIL: artifact/output scan could not be completed conclusively.',
    );
    process.exitCode = 1;
    return;
  }
  if (canaryLeaked) {
    // Per this stage's own authorization: never sanitize the evidence
    // after capture and claim success. This is reported as a direct
    // failure/blocker, not silently accepted.
    console.error(
      '[verify-artifact-safety] FAIL: the canary token substring was found in captured output or generated artifacts.',
    );
    process.exitCode = 1;
    return;
  }
  if (!outcome.ok) {
    console.error(`[verify-artifact-safety] FAIL: ${outcome.reason}.`);
    process.exitCode = 1;
    return;
  }

  console.log(
    '[verify-artifact-safety] PASS: the probe ran exactly once, failed at its own deliberate assertion, ' +
      'and no canary substring was found in any captured output or generated artifact.',
  );
  process.exitCode = 0;
}

main().catch((error: unknown) => {
  const className = error instanceof Error ? error.constructor.name : typeof error;
  console.error(
    `[verify-artifact-safety] FAIL: the verification run itself failed (${className}).`,
  );
  process.exitCode = 1;
});
