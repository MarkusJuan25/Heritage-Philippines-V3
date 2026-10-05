import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import {
  buildArtifact,
  captureFailureEvidence,
  mustRefuse,
  secretForms,
  type RawPageState,
} from './failure-evidence';

// D-060: isolated validation of failure-evidence.ts. No application, server,
// database, or login: every page is a static document served by a route
// handler on a reserved, non-resolving origin. Deliberately not named
// *.spec.ts, so `pnpm test:e2e` never collects it; it runs only through
// `pnpm test:e2e:validate-failure-evidence` and its own config.

const ORIGIN = 'http://failure-evidence.test';
const RECORD_ID = '0b9f6f0e-3c1d-4c58-9d55-7a1e2f3b4c5d';

// Synthetic, never real: the shape of an invitation token and of a
// generated password (24 characters of `A-Z a-z 0-9 - _`).
const TOKEN = 'Zx9-syntheticTOKEN_q7Lm2';
const PASSWORD = 'pW_4synthetic-PASSWORD8k';
const SECRETS = [TOKEN, PASSWORD] as const;

/** Encodings built here, independently of the helper's own secretForms. */
function independentForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  return [
    secret,
    encodeURIComponent(secret),
    Array.from(bytes, (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
    Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
    Array.from(secret).reverse().join(''),
  ];
}

const ALL_FORMS = Array.from(
  new Set(SECRETS.flatMap((secret) => [...independentForms(secret), ...secretForms(secret)])),
);

function expectNoSecret(text: string): void {
  const folded = text.toLowerCase();
  // Booleans only, so a failure never prints a secret form.
  for (const form of ALL_FORMS) {
    expect(text.includes(form)).toBe(false);
    expect(folded.includes(form.toLowerCase())).toBe(false);
  }
  expect(/token=/i.test(text)).toBe(false);
}

function pageHtml(): string {
  const everyForm = ALL_FORMS.map((form) => `<p data-form="${form}">${form}</p>`).join('\n');
  return `<!doctype html><html><head><title>${TOKEN}</title></head><body>
<div id="${PASSWORD}" hidden><span>${PASSWORD}</span></div>
<main>
  <h1>Lead ${TOKEN}</h1><span>${TOKEN}</span>
  <!--$--><!--$?--><!--/$--><!--/$-->
  <!--${TOKEN}-->
  <section id="${TOKEN}" title="${TOKEN}" data-x="${PASSWORD}" class="${PASSWORD}">
    <h2>Convert to Client</h2>
    <h2>${PASSWORD}</h2>
    <h3>${TOKEN}</h3>
    <p role="status">Status updated.</p>
    <p role="status">${TOKEN}</p>
    <x-${TOKEN}>custom element named after the token</x-${TOKEN}>
    <label>One-time invitation link
      <input value="${ORIGIN}/activate#token=${TOKEN}">
    </label>
    <input type="password" value="${PASSWORD}">
    <textarea>${PASSWORD}</textarea>
    ${everyForm}
  </section>
</main>
</body></html>`;
}

/** A history.state shaped like Next's, with secrets at every level. */
function historyStateWithSecrets(): unknown {
  return {
    __NA: true,
    __PRIVATE_NEXTJS_INTERNALS_TREE: {
      tree: [
        '',
        {
          children: [
            'admin',
            {
              children: [
                'leads',
                {
                  children: [
                    ['id', TOKEN, 'd'],
                    {
                      children: [`__PAGE__?{"search":"${PASSWORD}"}`, {}],
                      [TOKEN]: [PASSWORD, {}],
                    },
                  ],
                  modal: [['id', RECORD_ID, TOKEN], { children: [TOKEN, {}] }],
                },
              ],
            },
          ],
        },
        PASSWORD,
        TOKEN,
      ],
      renderedSearch: `?search=${PASSWORD}`,
    },
    [PASSWORD]: TOKEN,
    nested: { deeper: { deepest: [TOKEN, { value: PASSWORD, forms: ALL_FORMS }] } },
  };
}

async function openPageWithSecretsEverywhere(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml() }),
  );
  await page.goto(
    `${ORIGIN}/admin/leads/${RECORD_ID}/${TOKEN}` +
      `?search=${PASSWORD}&${TOKEN}=1&_rsc=${TOKEN}&token=${TOKEN}#token=${TOKEN}`,
  );
  const requestUrls = [
    `/api/leads/${RECORD_ID}/conversion?_rsc=abc12`,
    `/admin/leads/${RECORD_ID}?_rsc=abc12`,
    `/admin/clients?_rsc=${PASSWORD}`,
    `/admin/clients?search=${TOKEN}&status=${PASSWORD}&${PASSWORD}=${TOKEN}`,
    ...ALL_FORMS.flatMap((form) => [
      `/api/leads/${form}/status`,
      `/admin/${form}`,
      `/admin/clients?search=${form}`,
      `/admin/clients?_rsc=${form}`,
      `/admin/clients?${form}=1`,
    ]),
  ];
  await page.evaluate(async (urls) => {
    for (const url of urls) {
      try {
        await (await fetch(url)).text();
      } catch {
        // a form that is not a fetchable URL is simply skipped
      }
    }
  }, requestUrls);
  await page.evaluate((state) => history.replaceState(state, ''), historyStateWithSecrets());
}

async function readFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function listFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

const savedPath = (testInfo: TestInfo): string =>
  testInfo.outputPath('d059-failure-evidence', 'page-state.json');
const refusedPath = (testInfo: TestInfo): string =>
  testInfo.outputPath('d059-failure-evidence', 'page-state.refused.json');

/** Runs the capture with console.log replaced, returning every line it printed. */
async function captureWithOutput(
  run: () => Promise<void>,
): Promise<{ lines: string[]; threw: boolean }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  let threw = false;
  try {
    await run();
  } catch {
    threw = true;
  } finally {
    console.log = original;
  }
  return { lines, threw };
}

const FIXED_LINES = new Set([
  '[d059-evidence] page state saved',
  '[d059-evidence] page state not read; record saved',
  '[d059-evidence] refused by the secret guard; nothing saved',
  '[d059-evidence] abandoned after its time budget',
  '[d059-evidence] not captured',
]);

function expectFixedLinesOnly(lines: string[]): void {
  expect(lines.length).toBe(1);
  for (const line of lines) {
    expect(FIXED_LINES.has(line)).toBe(true);
    expectNoSecret(line);
  }
}

test('the allowlist alone keeps every synthetic secret, in every encoding, out of the file', async ({
  page,
}, testInfo) => {
  await openPageWithSecretsEverywhere(page);
  // No known secrets are passed: the guard cannot be what keeps them out.
  const { lines, threw } = await captureWithOutput(() =>
    captureFailureEvidence(page, testInfo, []),
  );
  expect(threw).toBe(false);
  expect(lines).toEqual(['[d059-evidence] page state saved']);

  const saved = await readFile(savedPath(testInfo));
  expect(saved !== null).toBe(true);
  expectNoSecret(saved ?? '');
  expect(await listFiles(testInfo.outputPath('d059-failure-evidence'))).toEqual([
    'page-state.json',
  ]);

  // The diagnostic content that is meant to survive, did.
  const parsed = JSON.parse(saved ?? '{}') as {
    pageState: ReturnType<typeof buildArtifact>;
    pageStateError: string | null;
  };
  const state = parsed.pageState;
  expect(parsed.pageStateError).toBeNull();
  expect(state.location.path).toBe('/admin/leads/[uuid#1]/[segment]');
  expect(state.location.query.keys).toEqual(['search', '[key]', '_rsc', '[key]']);
  expect(state.location.hasFragment).toBe(true);
  expect(state.main.commentCounts).toEqual({ $: 1, '$?': 1, '/$': 2, '[comment]': 1 });
  expect(state.main.skeleton.some((line) => /#text\(\d+\)/.test(line))).toBe(true);
  expect(state.main.skeleton.some((line) => line.includes('<[tag]>'))).toBe(true);
  expect(state.labels.leadStatusBadge).toEqual({ label: '[text]', length: TOKEN.length });
  expect(state.labels.mainHeadings.map((heading) => heading?.label)).toEqual([
    'Convert to Client',
    '[text]',
    '[text]',
  ]);
  expect(state.labels.statusRegions.map((region) => region?.label)).toEqual([
    'Status updated.',
    '[text]',
  ]);
  const paths = state.resourceTiming.entries.map((entry) => entry.path);
  expect(paths).toContain('/api/leads/[uuid#1]/conversion');
  expect(paths).toContain('/admin/leads/[uuid#1]');
  expect(paths).toContain('/admin/clients');
  const rscIndexes = state.resourceTiming.entries.map((entry) => entry.query?.rsc ?? null);
  // The page's own `_rsc` value is rsc#1; `abc12` is rsc#2, the same for both requests that used it.
  expect(rscIndexes.slice(0, 2)).toEqual(['rsc#2', 'rsc#2']);
  expect(state.historyState.routeTree).toEqual({
    segment: '',
    routes: {
      children: {
        segment: 'admin',
        routes: {
          children: {
            segment: 'leads',
            routes: {
              children: {
                segment: '[id=[value]:d]',
                routes: {
                  children: { segment: '__PAGE__?[search]', routes: {} },
                  '[slot#1]': { segment: '[segment]', routes: {} },
                },
              },
              '[slot#1]': {
                segment: '[id=uuid#1:?]',
                routes: { children: { segment: '[segment]', routes: {} } },
              },
            },
          },
        },
      },
    },
  });
});

test('buildArtifact is safe for raw fields a browser would not normally produce', () => {
  const hostile: RawPageState = {
    clocks: { pageClockMs: TOKEN, timeOriginEpochMs: Number.NaN, pageEpochMs: { toString: TOKEN } },
    origin: ORIGIN,
    pathname: `/${TOKEN}/${PASSWORD}`,
    search: `?${TOKEN}=${PASSWORD}`,
    fragmentLength: 1,
    readyState: TOKEN,
    visibilityState: PASSWORD,
    mainPresent: true,
    mainTruncated: false,
    mainNodes: [
      { kind: 'element', depth: 0, tag: TOKEN.toLowerCase(), id: PASSWORD, hidden: false },
      { kind: 'comment', depth: 1, data: TOKEN },
      { kind: 'text', depth: 1, length: 3 },
    ],
    bodyChildren: [{ tag: PASSWORD, id: TOKEN, hidden: false, childElementCount: 1 }],
    badge: TOKEN,
    headings: ALL_FORMS,
    statusRegions: [PASSWORD],
    resources: ALL_FORMS.map((form) => ({
      name: `${ORIGIN}/${form}?${form}=${form}`,
      initiatorType: form,
      numbers: { startTime: form, responseStatus: form },
    })),
    navigations: [{ name: TOKEN, initiatorType: TOKEN, type: PASSWORD, numbers: {} }],
    historyState: historyStateWithSecrets(),
  };
  const artifact = buildArtifact(hostile);
  expectNoSecret(JSON.stringify(artifact));
  expect(mustRefuse(artifact, SECRETS)).toBe(false);
});

test('the guard refuses each encoding of a known secret, a token marker, and a long token-like run', () => {
  const clean = { note: 'clean', path: '/admin/clients/confirm-manual-sent' };
  expect(mustRefuse(clean, SECRETS)).toBe(false);
  for (const secret of SECRETS) {
    for (const form of secretForms(secret)) {
      expect(mustRefuse({ nested: [{ value: `before ${form} after` }] }, [secret])).toBe(true);
      expect(mustRefuse({ nested: [{ value: `before ${form} after` }] }, [])).toBe(
        /[A-Za-z0-9_-]{16,}/.test(form),
      );
    }
  }
  expect(mustRefuse({ value: 'x?Token=abc' }, [])).toBe(true);
  expect(mustRefuse({ value: 'abcdefghijklmnop' }, [])).toBe(true);
});

test('a refusal writes a fixed marker and nothing else', async ({ page }, testInfo) => {
  await openPageWithSecretsEverywhere(page);
  // An allowlisted label stands in for a secret, so the guard has something to find.
  const { lines, threw } = await captureWithOutput(() =>
    captureFailureEvidence(page, testInfo, ['Convert to Client']),
  );
  expect(threw).toBe(false);
  expect(lines).toEqual(['[d059-evidence] refused by the secret guard; nothing saved']);
  expect(await readFile(savedPath(testInfo))).toBeNull();
  expect(await readFile(refusedPath(testInfo))).toBe('{"written":false,"reason":"secret-guard"}\n');
});

test('a closed page yields a record with no page state and no error text', async ({
  page,
}, testInfo) => {
  await openPageWithSecretsEverywhere(page);
  await page.close();
  const { lines, threw } = await captureWithOutput(() =>
    captureFailureEvidence(page, testInfo, SECRETS),
  );
  expect(threw).toBe(false);
  expect(lines).toEqual(['[d059-evidence] page state not read; record saved']);
  const saved = await readFile(savedPath(testInfo));
  expectNoSecret(saved ?? '');
  const parsed = JSON.parse(saved ?? '{}') as { pageState: unknown; pageStateError: string };
  expect(parsed.pageState).toBeNull();
  expect(['Error', 'TimeoutError', 'TargetClosedError', 'other']).toContain(parsed.pageStateError);
});

/** A stand-in page whose read fails with an error that carries a secret in its message and its class name. */
function pageWhoseReadRejects(): Page {
  class SecretNamedError extends Error {}
  Object.defineProperty(SecretNamedError, 'name', { value: TOKEN });
  return {
    evaluate: () =>
      Promise.reject(new SecretNamedError(`failed at ${ORIGIN}/activate#token=${TOKEN}`)),
    isClosed: () => {
      throw new Error(PASSWORD);
    },
    context: () => {
      throw new Error(PASSWORD);
    },
  } as unknown as Page;
}

test('a failing read records a fixed error class, never the error text or class name', async ({}, testInfo) => {
  const { lines, threw } = await captureWithOutput(() =>
    captureFailureEvidence(pageWhoseReadRejects(), testInfo, []),
  );
  expect(threw).toBe(false);
  expectFixedLinesOnly(lines);
  const saved = await readFile(savedPath(testInfo));
  expectNoSecret(saved ?? '');
  const parsed = JSON.parse(saved ?? '{}') as { pageStateError: string };
  expect(parsed.pageStateError).toBe('other');
});

test('a read that never returns is abandoned at the budget and writes nothing', async ({}, testInfo) => {
  let release: (value: RawPageState) => void = () => {};
  const hanging = {
    evaluate: () =>
      new Promise<RawPageState>((resolve) => {
        release = resolve;
      }),
    isClosed: () => false,
    context: () => ({ pages: () => [] }),
  } as unknown as Page;
  const started = Date.now();
  const { lines, threw } = await captureWithOutput(() =>
    captureFailureEvidence(hanging, testInfo, [], { budgetMs: 300 }),
  );
  expect(threw).toBe(false);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(lines).toEqual(['[d059-evidence] abandoned after its time budget']);
  // The read finishing later must still write nothing.
  release(await Promise.resolve({} as RawPageState));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await listFiles(testInfo.outputPath('d059-failure-evidence'))).toEqual([]);
});

test('a file-write failure is contained and prints no path or error text', async ({
  page,
}, testInfo) => {
  await openPageWithSecretsEverywhere(page);
  // The evidence directory cannot be created: its parent is a regular file.
  const blocker = testInfo.outputPath(`blocker-${TOKEN}`);
  await fs.mkdir(path.dirname(blocker), { recursive: true });
  await fs.writeFile(blocker, 'not a directory');
  const blockedInfo = {
    outputPath: (...segments: string[]) => path.join(blocker, ...segments),
  } as unknown as TestInfo;
  const { lines, threw } = await captureWithOutput(() =>
    captureFailureEvidence(page, blockedInfo, SECRETS),
  );
  expect(threw).toBe(false);
  expect(lines).toEqual(['[d059-evidence] not captured']);
});

test('in the spec pattern, the original error survives every capture failure and cleanup still runs', async ({}, testInfo) => {
  const hanging = {
    evaluate: () => new Promise<RawPageState>(() => {}),
    isClosed: () => false,
    context: () => ({ pages: () => [] }),
  } as unknown as Page;
  const blockedInfo = {
    outputPath: () => {
      throw new Error(TOKEN);
    },
  } as unknown as TestInfo;
  const cases: [Page, TestInfo, number][] = [
    [pageWhoseReadRejects(), testInfo, 10_000],
    [pageWhoseReadRejects(), blockedInfo, 10_000],
    [hanging, testInfo, 200],
  ];
  for (const [failingPage, info, budgetMs] of cases) {
    const original = new Error('the test’s own failure');
    let primaryError: unknown;
    let cleanupRan = false;
    const { lines, threw } = await captureWithOutput(async () => {
      // The exact shape both specs use.
      try {
        throw original;
      } catch (error) {
        primaryError = error;
        await captureFailureEvidence(failingPage, info, SECRETS, { budgetMs });
      } finally {
        cleanupRan = true;
      }
    });
    expect(threw).toBe(false);
    expect(primaryError).toBe(original);
    expect(cleanupRan).toBe(true);
    expectFixedLinesOnly(lines);
  }
});
