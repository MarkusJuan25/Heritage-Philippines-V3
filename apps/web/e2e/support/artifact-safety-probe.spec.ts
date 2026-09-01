import { expect, test } from '@playwright/test';

// D-034 Stage 5e (D-037 Section 15): the dedicated, tag-isolated
// "expected-failure probe." This spec is DESIGNED to fail — its own
// deliberate assertion is the proof the artifact-safety harness
// (verify-artifact-safety.ts) verifies. It must never run as part of the
// normal `pnpm test:e2e` suite: run-e2e.ts's own Playwright invocation
// excludes it via the CLI flag `--grep-invert @expected-failure-probe`
// (never a config-level grep/grepInvert — see that file's own doc
// comment for why). Only the harness selects it, via an explicit file
// path plus `--grep @expected-failure-probe`.
//
// The tag lives in the test title itself (the `@expected-failure-probe`
// token below), the simplest, version-stable mechanism Playwright's own
// `_grepTitleWithTags()` matches regardless of which explicit tag-option
// API a given version also supports.

const CANARY_ENV_VAR = 'ACTIVATION_ARTIFACT_PROBE_CANARY_TOKEN';
const CANARY_SHAPE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

// The one fixed, non-sensitive marker the harness's JSON-report check
// looks for — proving this exact deliberate assertion, not some unrelated
// error, is what failed. Never derived from, and never containing, the
// canary itself.
export const EXPECTED_FAILURE_MARKER = 'EXPECTED_ACTIVATION_ARTIFACT_PROBE_FAILURE';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test(`deliberately fails while a token-bearing activation URL is current, to prove artifact-safety controls hold @expected-failure-probe`, async ({
  page,
}) => {
  // The canary travels only through this dedicated environment variable —
  // never a command-line argument, a filename, a source-controlled
  // literal, or any log line (this file itself never contains one).
  const canary = process.env[CANARY_ENV_VAR];
  if (!canary) {
    throw new Error(
      `${CANARY_ENV_VAR} must be set to run this probe — it is not meant to be run directly.`,
    );
  }
  if (!CANARY_SHAPE_PATTERN.test(canary)) {
    // Deliberately NOT the expected-failure path — a malformed canary is
    // a setup defect the harness must recognize as a genuinely different
    // failure (its own JSON-report check requires the fixed marker to be
    // present; this message never is).
    throw new Error(`${CANARY_ENV_VAR} does not match the required 24-character token shape.`);
  }

  // Real navigation to the exact surface D-037 Section 15's artifact
  // retention policy governs — this is the actual exposure path under
  // test: does Playwright ever persist this URL/DOM content into a
  // trace, screenshot, video, or report file. Under D-038's fragment-based
  // contract, GET /activate performs no lookup at all and always renders
  // the identical, fixed Continue state (D-038 Section 3) — it can no
  // longer distinguish "no token"/"invalid token" the way the old
  // path-based route's server-side lookup did. Reaching the same generic
  // invalid-link state this probe's deliberate failure asserts against
  // therefore now requires one real Continue click, which POSTs the
  // canary to /api/activation/continue; the canary resolves to no real
  // invitation (never persisted to PortalInvitation by the harness), so
  // the server rejects it and the client renders its ordinary generic
  // invalid-link state — the exact same rendering code path a real
  // revoked/expired token would take.
  //
  // Wrapped in explicitly, fixedly titled test.step calls so the
  // reporter's own step titles are these literal strings, never
  // Playwright's default auto-generated "page.goto(<url>)"/
  // "getByRole(...).click()" titles, which would otherwise embed the
  // full canary-bearing URL/request directly into the JSON report. The
  // harness's own artifact scan independently re-verifies this holds —
  // see verify-artifact-safety.ts — and stops rather than silently
  // accepting the run if it does not.
  await test.step('navigate to the canary-bearing activation URL', async () => {
    await page.goto(`/activate#token=${canary}`);
  });
  await test.step('click Continue to submit the canary token', async () => {
    await page.getByRole('button', { name: 'Continue' }).click();
  });
  await expect(page.getByText('This invitation link is no longer valid.')).toBeVisible();

  // The deliberate failure. A boolean assertion on a literal `false`,
  // never an equality check against anything canary-derived — the canary
  // is never referenced here or in the message below, only the fixed
  // marker is.
  expect(false, EXPECTED_FAILURE_MARKER).toBe(true);
});
