import * as fs from 'node:fs/promises';

import type { Page, TestInfo } from '@playwright/test';

// D-059 diagnostic evidence, written only after a test has already failed
// (D-060). Nothing in this file runs before a failure: the one entry point,
// captureFailureEvidence, is called from a spec's existing catch block after
// the spec has stored its own error. It never throws, so it cannot replace
// that error, and it prints only fixed text.
//
// D-033 §8 and D-037 §15 stay as they are: no trace, screenshot, or video.
// The JSON written here is built from an allowlist instead of by redaction.
// A string reaches the file only if it is one of:
//   - a fixed word from a list in this file (route words, query-key names,
//     UI labels, React comment markers, browser enum values), or
//   - a fixed placeholder such as `[segment]` or `[text]`, or
//   - an index this file assigned (`[uuid#1]`, `rsc#2`), or
//   - a standard HTML or SVG tag name from a fixed list, or the kind of a
//     React streaming id (`B:*`, `S:*`, `P:*`) without its value.
// Everything else is a number or a boolean. Page text, input and attribute
// values, raw URL path segments, raw query values, the URL fragment, raw
// history.state values, cookies, headers, and request or response bodies
// never reach the file. As a second layer, the finished text is discarded
// rather than written if it holds a known secret in any of the encodings
// listed in secretForms, a `token=` marker, or any long token-like run.

const EVIDENCE_DIR = 'd059-failure-evidence';
const EVIDENCE_FILE = 'page-state.json';
const REFUSAL_FILE = 'page-state.refused.json';
const DEFAULT_BUDGET_MS = 10_000;

// ---------------------------------------------------------------------------
// Allowlists. Each list names its diagnostic purpose.
// ---------------------------------------------------------------------------

/**
 * Route words: the application's own static path segments (the directory
 * names under src/app, plus Next's asset prefix). Purpose: to tell which
 * page or endpoint a request or history entry belongs to, e.g. the Lead
 * conversion POST, the Lead page's refresh, and the Clients navigation.
 */
const ROUTE_WORDS: ReadonlySet<string> = new Set([
  '_next',
  'static',
  'chunks',
  'css',
  'media',
  'activate',
  'activation',
  'admin',
  'allocations',
  'api',
  'approval',
  'assignment',
  'assignments',
  'auth',
  'bookings',
  'client',
  'clients',
  'confirmation',
  'confirm-manual-sent',
  'continue',
  'conversations',
  'conversion',
  'dashboard',
  'deactivate',
  'finance-assignment',
  'financials',
  'health',
  'invitation',
  'leads',
  'login',
  'me',
  'my-journey',
  'new',
  'payments',
  'plans',
  'proposals',
  'publish',
  'reactivate',
  'receipt',
  'refunds',
  'regional-tours',
  'resend',
  'response',
  'reversal',
  'revoke',
  'send',
  'staff',
  'status',
  'status-history',
  'support',
  'travel-consultants',
  'versions',
  'webhooks',
  'withdrawal',
]);

/**
 * Query-key names only — never a value. Purpose: to tell an RSC request
 * (`_rsc`) from a document or API request, and a filtered list from an
 * unfiltered one. Unknown keys become `[key]`.
 */
const QUERY_KEYS: ReadonlySet<string> = new Set(['_rsc', 'search', 'status', 'page', 'activated']);

/**
 * UI labels: the ten Lead status labels (leadStatusLabels.ts) and the fixed
 * texts the two specs assert on. Purpose: to record which state the page
 * showed, e.g. badge "Qualified" with the "Convert to Client" heading
 * absent. Any other text becomes `[text]` with its length.
 */
const KNOWN_LABELS: ReadonlySet<string> = new Set([
  'New',
  'Under Review',
  'Contacted',
  'Consultation Scheduled',
  'Qualified',
  'Converted to Client',
  'Not Proceeding',
  'Duplicate',
  'Spam',
  'Archived',
  'Convert to Client',
  'Change Status',
  'Status updated.',
  'No status changes are available for this lead.',
  'Refreshing available status changes…',
]);

/**
 * React's own comment markers (Suspense, Activity, form state, preamble).
 * Purpose: to tell an empty resolved boundary (`$` … `/$`) from a pending
 * (`$?`) or errored (`$!`) one. Any other comment becomes `[comment]`.
 */
const KNOWN_COMMENTS: ReadonlySet<string> = new Set([
  '$',
  '/$',
  '$?',
  '$!',
  '$~',
  '&',
  '/&',
  'F',
  'F!',
  'html',
  'head',
  'body',
]);

const INITIATOR_TYPES: ReadonlySet<string> = new Set([
  'fetch',
  'xmlhttprequest',
  'script',
  'link',
  'css',
  'img',
  'navigation',
  'beacon',
  'other',
  'early-hints',
]);
const NAVIGATION_TYPES: ReadonlySet<string> = new Set([
  'navigate',
  'reload',
  'back_forward',
  'prerender',
]);
const READY_STATES: ReadonlySet<string> = new Set(['loading', 'interactive', 'complete']);
const VISIBILITY_STATES: ReadonlySet<string> = new Set(['visible', 'hidden']);
const ERROR_CLASSES: ReadonlySet<string> = new Set(['Error', 'TimeoutError', 'TargetClosedError']);
const DYNAMIC_PARAM_NAMES: ReadonlySet<string> = new Set([
  'id',
  'bookingId',
  'bookingReference',
  'all',
]);
const DYNAMIC_PARAM_TYPES: ReadonlySet<string> = new Set(['d', 'c', 'oc', 'ci', 'di', 'oci']);

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/**
 * Standard HTML and SVG element names. Purpose: the shape of the rendered
 * tree. A custom or unknown element name is page-chosen text, however
 * short, so it becomes `[tag]` (this includes Next's own
 * `next-route-announcer`).
 */
const STANDARD_TAGS: ReadonlySet<string> = new Set(
  (
    'a abbr address article aside b blockquote body br button caption circle code col ' +
    'colgroup dd defs details dialog div dl dt em fieldset figcaption figure footer form g ' +
    'h1 h2 h3 h4 h5 h6 head header hr html i img input label legend li line link main meta ' +
    'nav noscript ol optgroup option p path polygon polyline pre rect script section select ' +
    'small span strong style summary svg table tbody td template textarea tfoot th thead ' +
    'time title tr ul use'
  ).split(' '),
);

/**
 * React's streaming ids, exactly as react-dom's server writes them with no
 * identifier prefix: `B:` (Suspense boundary), `S:` (segment) or `P:`
 * (placeholder) followed by a lowercase hexadecimal counter. Only the
 * kind is written (`B:*`); the counter is not.
 */
const REACT_ID_SHAPE = /^([BSP]):[0-9a-f]{1,8}$/;

function safeTag(tag: unknown): string {
  return oneOf(STANDARD_TAGS, tag, '[tag]');
}

// ---------------------------------------------------------------------------
// Raw page read. Runs inside the page; reads only. Its result stays in this
// process's memory and is never written: only buildArtifact's output is.
// ---------------------------------------------------------------------------

type RawNode =
  | { kind: 'element'; depth: number; tag: string; id: string; hidden: boolean }
  | { kind: 'comment'; depth: number; data: string }
  | { kind: 'text'; depth: number; length: number };

type RawTiming = { name: string; initiatorType: string; numbers: Record<string, unknown> };

export type RawPageState = {
  clocks: { pageClockMs: unknown; timeOriginEpochMs: unknown; pageEpochMs: unknown };
  origin: string;
  pathname: string;
  search: string;
  fragmentLength: number;
  readyState: string;
  visibilityState: string;
  mainPresent: boolean;
  mainTruncated: boolean;
  mainNodes: RawNode[];
  bodyChildren: { tag: string; id: string; hidden: boolean; childElementCount: number }[];
  badge: string | null;
  headings: string[];
  statusRegions: string[];
  resources: RawTiming[];
  navigations: (RawTiming & { type: string })[];
  historyState: unknown;
};

function readRawPageState(): RawPageState {
  const MAX_NODES = 5000;
  const MAX_TEXT = 200;
  const text = (element: Element | null): string | null =>
    element ? (element.textContent ?? '').trim().slice(0, MAX_TEXT) : null;

  const mainNodes: RawNode[] = [];
  let mainTruncated = false;
  const walk = (node: Node, depth: number): void => {
    if (mainNodes.length >= MAX_NODES) {
      mainTruncated = true;
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      mainNodes.push({
        kind: 'element',
        depth,
        tag: element.tagName.toLowerCase(),
        id: element.id,
        hidden: element.hasAttribute('hidden'),
      });
      for (const child of Array.from(element.childNodes)) walk(child, depth + 1);
    } else if (node.nodeType === Node.COMMENT_NODE) {
      mainNodes.push({ kind: 'comment', depth, data: (node as Comment).data.slice(0, MAX_TEXT) });
    } else if (node.nodeType === Node.TEXT_NODE) {
      const length = (node.nodeValue ?? '').trim().length;
      if (length > 0) mainNodes.push({ kind: 'text', depth, length });
    }
  };
  const main = document.querySelector('main');
  if (main) walk(main, 0);

  const resources = performance.getEntriesByType('resource').map((entry) => {
    const timing = entry as PerformanceResourceTiming & { responseStatus?: number };
    return {
      name: timing.name,
      initiatorType: timing.initiatorType,
      numbers: {
        startTime: timing.startTime,
        responseStart: timing.responseStart,
        responseEnd: timing.responseEnd,
        duration: timing.duration,
        transferSize: timing.transferSize,
        encodedBodySize: timing.encodedBodySize,
        decodedBodySize: timing.decodedBodySize,
        responseStatus: timing.responseStatus,
      },
    };
  });
  const navigations = performance.getEntriesByType('navigation').map((entry) => {
    const timing = entry as PerformanceNavigationTiming & { responseStatus?: number };
    return {
      name: timing.name,
      initiatorType: timing.initiatorType,
      type: timing.type,
      numbers: {
        startTime: timing.startTime,
        responseEnd: timing.responseEnd,
        domContentLoadedEventEnd: timing.domContentLoadedEventEnd,
        loadEventEnd: timing.loadEventEnd,
        responseStatus: timing.responseStatus,
      },
    };
  });

  let historyState: unknown = null;
  try {
    const serialized = JSON.stringify(history.state ?? null);
    if (serialized.length <= 50_000) historyState = JSON.parse(serialized) as unknown;
  } catch {
    historyState = null;
  }

  return {
    clocks: {
      pageClockMs: performance.now(),
      timeOriginEpochMs: performance.timeOrigin,
      pageEpochMs: Date.now(),
    },
    origin: location.origin,
    pathname: location.pathname,
    search: location.search,
    fragmentLength: location.hash.length,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    mainPresent: main !== null,
    mainTruncated,
    mainNodes,
    bodyChildren: Array.from(document.body?.children ?? []).map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id,
      hidden: element.hasAttribute('hidden'),
      childElementCount: element.childElementCount,
    })),
    badge: text(document.querySelector('main h1 + span')),
    headings: Array.from(document.querySelectorAll('main h2, main h3'))
      .slice(0, 40)
      .map((element) => text(element) ?? ''),
    statusRegions: Array.from(document.querySelectorAll('[role="status"]'))
      .slice(0, 40)
      .map((element) => text(element) ?? ''),
    resources,
    navigations,
    historyState,
  };
}

// ---------------------------------------------------------------------------
// Allowlisted artifact. Pure: raw page state in, writable object out.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function oneOf(allowed: ReadonlySet<string>, value: unknown, otherwise: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : otherwise;
}

/** Assigns `prefix#1`, `prefix#2`, … to distinct raw values; the raw value is never returned. */
function indexer(prefix: string): (raw: string) => string {
  const seen = new Map<string, number>();
  return (raw) => {
    let index = seen.get(raw);
    if (index === undefined) {
      index = seen.size + 1;
      seen.set(raw, index);
    }
    return `${prefix}#${index}`;
  };
}

type Indexers = { uuid: (raw: string) => string; rsc: (raw: string) => string };

function safeSegment(segment: string, indexers: Indexers): string {
  if (segment === '') return '';
  if (ROUTE_WORDS.has(segment)) return segment;
  // Record ids are replaced by an index: the same id gets the same index
  // everywhere in one artifact, which is all the comparison needs.
  if (UUID_SHAPE.test(segment)) return `[${indexers.uuid(segment.toLowerCase())}]`;
  return '[segment]';
}

function safePath(pathname: string, indexers: Indexers): string {
  return pathname
    .split('/')
    .slice(0, 12)
    .map((segment) => safeSegment(segment, indexers))
    .join('/');
}

/**
 * Query keys by name, and for `_rsc` an index in place of its value.
 * Purpose of the index: requests with the same `_rsc` value carry the same
 * router state and prefetch headers, so the index separates the refresh,
 * the navigation, and prefetches without keeping the value.
 */
function safeQuery(search: string, indexers: Indexers): { keys: string[]; rsc: string | null } {
  const keys: string[] = [];
  let rsc: string | null = null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { keys: ['[unparsed]'], rsc: null };
  }
  for (const [key, value] of Array.from(params.entries()).slice(0, 20)) {
    keys.push(QUERY_KEYS.has(key) ? key : '[key]');
    if (key === '_rsc' && rsc === null) rsc = indexers.rsc(value);
  }
  return { keys, rsc };
}

function safeUrl(
  rawUrl: string,
  pageOrigin: string,
  indexers: Indexers,
): { sameOrigin: boolean; path: string | null; query: ReturnType<typeof safeQuery> | null } {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== pageOrigin) return { sameOrigin: false, path: null, query: null };
    return {
      sameOrigin: true,
      path: safePath(url.pathname, indexers),
      query: safeQuery(url.search, indexers),
    };
  } catch {
    return { sameOrigin: false, path: null, query: null };
  }
}

function safeLabel(raw: string | null): { label: string; length: number } | null {
  if (raw === null) return null;
  return { label: KNOWN_LABELS.has(raw) ? raw : '[text]', length: raw.length };
}

function skeletonLine(node: RawNode): string {
  const indent = ' '.repeat(Math.min(Math.max(node.depth, 0), 40));
  if (node.kind === 'text') return `${indent}#text(${finiteNumber(node.length) ?? 0})`;
  if (node.kind === 'comment') {
    return `${indent}<!--${oneOf(KNOWN_COMMENTS, node.data, '[comment]')}-->`;
  }
  // An id's value is never written. A React streaming id is reduced to
  // its kind (`id=B:*`); any other id is recorded as present (`id`).
  const reactKind = typeof node.id === 'string' ? REACT_ID_SHAPE.exec(node.id)?.[1] : undefined;
  const id = node.id === '' ? '' : reactKind ? ` id=${reactKind}:*` : ' id';
  return `${indent}<${safeTag(node.tag)}${id}${node.hidden === true ? ' hidden' : ''}>`;
}

type RouteTree = { segment: string; routes: Record<string, RouteTree> } | '[too-deep]';

/**
 * The route tree Next stores in history.state, reduced to allowlisted
 * segment names. Purpose: which route the client router had committed
 * (e.g. "" → admin → clients → __PAGE__) when the page showed nothing.
 * No other history.state field is kept.
 */
function safeRouteTree(raw: unknown, indexers: Indexers, depth = 0): RouteTree | null {
  if (!Array.isArray(raw)) return null;
  if (depth > 12) return '[too-deep]';
  const [rawSegment, rawRoutes] = raw as unknown[];
  let segment = '[segment]';
  if (typeof rawSegment === 'string') {
    if (rawSegment === '__PAGE__' || rawSegment === '__DEFAULT__') segment = rawSegment;
    else if (rawSegment.startsWith('__PAGE__?')) segment = '__PAGE__?[search]';
    else if (/^\(.*\)$/.test(rawSegment)) {
      segment = `(${safeSegment(rawSegment.slice(1, -1), indexers)})`;
    } else segment = safeSegment(rawSegment, indexers);
  } else if (Array.isArray(rawSegment)) {
    const [name, value, type] = rawSegment as unknown[];
    const safeValue =
      typeof value === 'string' && UUID_SHAPE.test(value)
        ? indexers.uuid(value.toLowerCase())
        : '[value]';
    segment = `[${oneOf(DYNAMIC_PARAM_NAMES, name, '[name]')}=${safeValue}:${oneOf(DYNAMIC_PARAM_TYPES, type, '?')}]`;
  }
  const routes: Record<string, RouteTree> = {};
  if (isRecord(rawRoutes)) {
    let unnamed = 0;
    for (const [slot, child] of Object.entries(rawRoutes).slice(0, 8)) {
      const tree = safeRouteTree(child, indexers, depth + 1);
      if (tree === null) continue;
      unnamed += slot === 'children' ? 0 : 1;
      routes[slot === 'children' ? 'children' : `[slot#${unnamed}]`] = tree;
    }
  }
  return { segment, routes };
}

function safeHistoryState(raw: unknown, indexers: Indexers) {
  if (!isRecord(raw)) return { present: raw !== null && raw !== undefined, routeTree: null };
  const internals = raw.__PRIVATE_NEXTJS_INTERNALS_TREE;
  const tree = isRecord(internals) ? internals.tree : internals;
  const renderedSearch = isRecord(internals) ? internals.renderedSearch : undefined;
  return {
    present: true,
    appRouterEntry: raw.__NA === true,
    renderedSearchLength: typeof renderedSearch === 'string' ? renderedSearch.length : null,
    routeTree: safeRouteTree(tree, indexers),
  };
}

function safeNumbers(numbers: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of [
    'startTime',
    'responseStart',
    'responseEnd',
    'duration',
    'transferSize',
    'encodedBodySize',
    'decodedBodySize',
    'domContentLoadedEventEnd',
    'loadEventEnd',
    'responseStatus',
  ]) {
    if (key in numbers) out[key] = finiteNumber(numbers[key]);
  }
  return out;
}

/** The helper's lists, exported so the isolated validation can check every written string against them. */
export const ALLOWED_WORDS = {
  routeWords: ROUTE_WORDS,
  queryKeys: QUERY_KEYS,
  labels: KNOWN_LABELS,
  comments: KNOWN_COMMENTS,
  tags: STANDARD_TAGS,
  initiatorTypes: INITIATOR_TYPES,
  navigationTypes: NAVIGATION_TYPES,
  readyStates: READY_STATES,
  visibilityStates: VISIBILITY_STATES,
  errorClasses: ERROR_CLASSES,
  dynamicParamNames: DYNAMIC_PARAM_NAMES,
  dynamicParamTypes: DYNAMIC_PARAM_TYPES,
} as const;

const LISTED_WORDS: ReadonlySet<string> = new Set(
  Object.values(ALLOWED_WORDS).flatMap((words) => Array.from(words)),
);

/** Builds the only object that may be written. Exported for the isolated validation. */
export function buildArtifact(raw: RawPageState) {
  const indexers: Indexers = { uuid: indexer('uuid'), rsc: indexer('rsc') };
  const commentCounts: Record<string, number> = {};
  for (const node of raw.mainNodes) {
    if (node.kind !== 'comment') continue;
    const marker = oneOf(KNOWN_COMMENTS, node.data, '[comment]');
    commentCounts[marker] = (commentCounts[marker] ?? 0) + 1;
  }
  return {
    clocks: {
      pageClockMs: finiteNumber(raw.clocks.pageClockMs),
      pageTimeOriginEpochMs: finiteNumber(raw.clocks.timeOriginEpochMs),
      pageEpochMs: finiteNumber(raw.clocks.pageEpochMs),
    },
    location: {
      path: safePath(raw.pathname, indexers),
      query: safeQuery(raw.search, indexers),
      hasFragment: raw.fragmentLength > 0,
    },
    readyState: oneOf(READY_STATES, raw.readyState, '[other]'),
    visibilityState: oneOf(VISIBILITY_STATES, raw.visibilityState, '[other]'),
    main: {
      present: raw.mainPresent === true,
      nodeCount: raw.mainNodes.length,
      truncated: raw.mainTruncated === true,
      commentCounts,
      skeleton: raw.mainNodes.map(skeletonLine),
    },
    bodyChildren: raw.bodyChildren.slice(0, 40).map((child) => ({
      tag: safeTag(child.tag),
      hasId: child.id !== '',
      hidden: child.hidden === true,
      childElementCount: finiteNumber(child.childElementCount),
    })),
    labels: {
      leadStatusBadge: safeLabel(raw.badge),
      mainHeadings: raw.headings.map(safeLabel),
      statusRegions: raw.statusRegions.map(safeLabel),
    },
    resourceTiming: {
      count: raw.resources.length,
      // Chromium's default buffer holds 250 entries per document and drops
      // later ones once full, so at 250 the most recent requests may be
      // the ones missing.
      mayBeIncomplete: raw.resources.length >= 250,
      entries: raw.resources.map((entry) => ({
        ...safeUrl(entry.name, raw.origin, indexers),
        initiatorType: oneOf(INITIATOR_TYPES, entry.initiatorType, '[other]'),
        ...safeNumbers(entry.numbers),
      })),
    },
    navigationTiming: raw.navigations.slice(0, 5).map((entry) => ({
      ...safeUrl(entry.name, raw.origin, indexers),
      type: oneOf(NAVIGATION_TYPES, entry.type, '[other]'),
      ...safeNumbers(entry.numbers),
    })),
    historyState: safeHistoryState(raw.historyState, indexers),
  };
}

// ---------------------------------------------------------------------------
// Second layer: refuse to write.
// ---------------------------------------------------------------------------

/** Encodings of a secret that the finished text is checked against. Exported for the isolated validation. */
export function secretForms(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const hex = bytes.toString('hex');
  const percentAll = Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
  const base64 = bytes.toString('base64');
  const forms = [
    secret,
    secret.toLowerCase(),
    secret.toUpperCase(),
    Array.from(secret).reverse().join(''),
    encodeURIComponent(secret),
    percentAll,
    percentAll.toUpperCase(),
    base64,
    base64.replace(/=+$/, ''),
    bytes.toString('base64url'),
    hex,
    hex.toUpperCase(),
    Array.from(secret, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
    Array.from(secret, (char) => `&#${char.charCodeAt(0)};`).join(''),
    Array.from(secret, (char) => `&#x${char.charCodeAt(0).toString(16)};`).join(''),
  ];
  return Array.from(new Set(forms.filter((form) => form.length > 0)));
}

function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const entry of value) stringValues(entry, out);
  else if (isRecord(value)) for (const entry of Object.values(value)) stringValues(entry, out);
  return out;
}

/** True when the artifact must not be written. Exported for the isolated validation. */
export function mustRefuse(artifact: unknown, knownSecrets: readonly string[]): boolean {
  const serialized = JSON.stringify(artifact);
  if (/token=/i.test(serialized)) return true;
  // No string value may hold 16 or more consecutive characters of the token
  // and password alphabet, unless that run is exactly a listed word.
  const hasLongRun = (value: string): boolean =>
    (value.match(/[A-Za-z0-9_-]{16,}/g) ?? []).some((run) => !LISTED_WORDS.has(run));
  const values = stringValues(artifact);
  if (values.some(hasLongRun)) return true;
  // Checked both as written (JSON escapes a backslash) and as the plain
  // values, so an escaped form cannot hide behind the serialization.
  const checked = [serialized, ...values].join(' ');
  const folded = checked.toLowerCase();
  return knownSecrets.some(
    (secret) =>
      secret.length > 0 &&
      secretForms(secret).some(
        (form) => checked.includes(form) || folded.includes(form.toLowerCase()),
      ),
  );
}

// ---------------------------------------------------------------------------
// Capture.
// ---------------------------------------------------------------------------

type Outcome =
  | 'page state saved'
  | 'page state not read; record saved'
  | 'refused by the secret guard; nothing saved'
  | 'abandoned after its time budget'
  | 'not captured';

async function capture(
  page: Page,
  testInfo: TestInfo,
  knownSecrets: readonly string[],
  isAbandoned: () => boolean,
): Promise<Outcome> {
  const captureStartedAtEpochMs = Date.now();
  let pageState: ReturnType<typeof buildArtifact> | null = null;
  let pageStateError: string | null = null;
  try {
    pageState = buildArtifact(await page.evaluate(readRawPageState));
  } catch (error) {
    // A class name from a fixed list only: an error message can quote a URL.
    pageStateError = oneOf(
      ERROR_CLASSES,
      error instanceof Error ? error.constructor.name : null,
      'other',
    );
  }
  let pageClosed: boolean | null = null;
  let pagesInContext: number | null = null;
  try {
    pageClosed = page.isClosed();
    pagesInContext = page.context().pages().length;
  } catch {
    // leave both unknown
  }
  const artifact = {
    note:
      'Read once, after the test had already failed. It describes the page at capture time, ' +
      'not at the moment of failure. Page times and test-process times are separate clocks.',
    testProcess: {
      captureStartedAtEpochMs,
      captureReadFinishedAtEpochMs: Date.now(),
      pageClosed,
      pagesInContext,
    },
    pageState,
    pageStateError,
  };
  const refused = mustRefuse(artifact, knownSecrets);
  if (isAbandoned()) return 'abandoned after its time budget';
  await fs.mkdir(testInfo.outputPath(EVIDENCE_DIR), { recursive: true });
  if (refused) {
    // A refusal records only that it happened — never the content.
    await fs.writeFile(
      testInfo.outputPath(EVIDENCE_DIR, REFUSAL_FILE),
      '{"written":false,"reason":"secret-guard"}\n',
    );
    return 'refused by the secret guard; nothing saved';
  }
  await fs.writeFile(
    testInfo.outputPath(EVIDENCE_DIR, EVIDENCE_FILE),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return pageStateError === null ? 'page state saved' : 'page state not read; record saved';
}

/**
 * Call from a spec's catch block, after the spec has stored its own error.
 * Bounded by a time budget, never throws, and prints one fixed line.
 */
export async function captureFailureEvidence(
  page: Page,
  testInfo: TestInfo,
  knownSecrets: readonly string[],
  options: { budgetMs?: number } = {},
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let abandoned = false;
  let outcome: Outcome = 'not captured';
  try {
    outcome = await Promise.race([
      capture(page, testInfo, knownSecrets, () => abandoned),
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => {
          abandoned = true;
          resolve('abandoned after its time budget');
        }, options.budgetMs ?? DEFAULT_BUDGET_MS);
      }),
    ]);
  } catch {
    outcome = 'not captured';
  } finally {
    clearTimeout(timer);
  }
  try {
    console.log(`[d059-evidence] ${outcome}`);
  } catch {
    // nothing more to do
  }
}
