import { defineConfig } from '@playwright/test';

import { getValidatedTestDatabaseUrl } from './e2e/support/test-database';

// D-033 §7 (Correction Pass 3): the isolated E2E server's own fixed
// loopback origin/port — deliberately never port 3000, so this run can
// never collide with, or be mistaken for, a developer's already-running
// `pnpm dev` server pointed at heritage_v3_dev.
const E2E_PORT = 3100;
const E2E_HOST = '127.0.0.1';
const BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`;

// D-033 §5: the same canonical validator run-e2e.ts, fixtures.ts, and the
// spec's own direct-assertion code all use — re-validated here
// independently in case `playwright test` is ever invoked directly,
// bypassing run-e2e.ts.
const databaseUrl = getValidatedTestDatabaseUrl();

const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
if (!betterAuthSecret || betterAuthSecret.length < 32) {
  throw new Error(
    'BETTER_AUTH_SECRET (>= 32 characters) is required to start the isolated E2E server. ' +
      'This is set internally by run-e2e.ts before Playwright is invoked — run the suite via ' +
      '`pnpm --filter web run test:e2e`, not `playwright test` directly.',
  );
}

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  outputDir: './test-results',
  use: {
    baseURL: BASE_URL,
    actionTimeout: 15_000,
    // D-033 §8 (Correction Pass 3): tracing captures full network request
    // bodies, including /login's own POST body, which necessarily
    // contains the fixture's plaintext test password — no retention
    // policy for a trace can be made consistent with never persisting it,
    // so tracing is disabled entirely.
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `next start --port ${E2E_PORT} --hostname ${E2E_HOST}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_URL: BASE_URL,
      BETTER_AUTH_SECRET: betterAuthSecret,
      NODE_ENV: 'production',
    },
  },
});
