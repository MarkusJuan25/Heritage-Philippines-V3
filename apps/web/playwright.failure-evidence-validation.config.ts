import { defineConfig } from '@playwright/test';

// D-060: isolated validation of e2e/support/failure-evidence.ts only. No
// webServer, no database, no environment secrets, and its own output
// directory. Run with `pnpm --filter web run test:e2e:validate-failure-evidence`.
export default defineConfig({
  testDir: './e2e/support',
  testMatch: 'failure-evidence.validation.ts',
  outputDir: './test-results/failure-evidence-validation',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
