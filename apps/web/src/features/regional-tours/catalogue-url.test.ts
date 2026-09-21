import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  V2_CATALOGUE_PATH,
  resolveV2CatalogueLink,
  type V2CatalogueLinkResult,
} from './catalogue-url';

// D-052 §11's Stage 2 test matrix for the pure V2 catalogue-link resolver
// (docs/HERITAGE_V3_DECISIONS_LOG.md D-052 §5). Only the reserved, non-routable
// `.test` namespace (RFC 2606) and documentation-only IP addresses are used
// here — no real V2 origin, credential, or network request appears anywhere.

const UNAVAILABLE = { status: 'unavailable' } as const;

function availableAt(href: string): V2CatalogueLinkResult {
  return { status: 'available', href };
}

// Special characters are built from character codes so the test source stays
// free of invisible or irregular characters.
const BACKSLASH = String.fromCharCode(0x5c);
const NBSP = String.fromCharCode(0x00a0);
const EM_SPACE = String.fromCharCode(0x2003);
const BOM = String.fromCharCode(0xfeff);
const VERTICAL_TAB = String.fromCharCode(0x000b);
const NUL = String.fromCharCode(0x0000);
const UNIT_SEPARATOR = String.fromCharCode(0x001f);
const START_OF_HEADING = String.fromCharCode(0x0001);
const DELETE = String.fromCharCode(0x007f);
const LONE_SURROGATE = String.fromCharCode(0xd800);
const A_WITH_DIAERESIS = String.fromCharCode(0x00e4);

function labelled(values: readonly string[]): Array<[string, string]> {
  return values.map((value) => [JSON.stringify(value), value]);
}

// --- Fixtures ---------------------------------------------------------------

const EMPTY_AND_WHITESPACE_ONLY = [
  '',
  ' ',
  '\t',
  '\n',
  '\r\n',
  ' \t\r\n\f ',
  NBSP,
  EM_SPACE,
  BOM,
  VERTICAL_TAB,
  ` ${NBSP} `,
];

const PROHIBITED_SCHEMES = [
  'http://example.test',
  'HTTP://EXAMPLE.TEST',
  'http://example.test/tour',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,hello',
  'file:///etc/passwd',
  'ftp://example.test',
  'ws://example.test',
  'wss://example.test',
  'mailto:someone@example.test',
  'blob:https://example.test/0a1b2c',
  'about:blank',
  'chrome://settings',
  'tel:+0000000',
];

const SCHEMELESS_AND_PROTOCOL_RELATIVE = [
  'example.test',
  'www.example.test',
  'example.test/tour',
  'example.test:8443',
  'localhost:3000',
  '//example.test',
  '//example.test/tour',
  '///example.test',
  '/tour',
  'tour',
  '?x=1',
  '#fragment',
];

const MALFORMED = [
  'not-a-url',
  'https://',
  'https:///path',
  'https:///example.test',
  'https:example.test',
  'https:/example.test',
  'https://?x=1',
  'https://#fragment',
  'https://:443',
  'https://@',
  'https://[::1',
  'https://example.test:99999',
  'https://example.test:65536',
  'https://example.test:abc',
  'https://ex%zzample.test',
  'https://exa<mple.test',
  'https://exa>mple.test',
  'https://exa^mple.test',
  'https://exa|mple.test',
];

const EMBEDDED_CREDENTIALS = [
  'https://user@example.test',
  'https://user:pass@example.test',
  'https://:pass@example.test',
  'https://user:@example.test',
  'https://user:pass@example.test/tour',
  'https://user:pass@example.test:8443',
  'https://us%40er:pw@example.test',
  'https://a@b@example.test',
  'HTTPS://USER:PASS@EXAMPLE.TEST',
];

const INNER_WHITESPACE_CONTROL_AND_BACKSLASH = [
  // inner ASCII whitespace
  'https://exam ple.test',
  'https://example.test/a b',
  'https://example.test /tour',
  'https://example.test/\tx',
  'https://example.test/\nx',
  'https://example.test/\rx',
  'https://example.test/\fx',
  // inner ASCII control characters
  `https://example.test/${VERTICAL_TAB}x`,
  `https://example.test/${NUL}`,
  `https://example.test/${START_OF_HEADING}`,
  `https://example.test/${UNIT_SEPARATOR}`,
  `https://example.test/${DELETE}`,
  `https://exam${NUL}ple.test`,
  // Unicode whitespace is not "ASCII whitespace": it is never trimmed, so a
  // leading, trailing, or inner occurrence is always rejected.
  `${NBSP}https://example.test`,
  `https://example.test${NBSP}`,
  `https://example.test/${NBSP}x`,
  `https://example.test/${EM_SPACE}x`,
  `${VERTICAL_TAB}https://example.test`,
  // backslashes
  `https:${BACKSLASH}${BACKSLASH}example.test`,
  `https://example.test${BACKSLASH}tour`,
  `https://example.test/a${BACKSLASH}b`,
  `${BACKSLASH}${BACKSLASH}example.test`,
  `https://example.test${BACKSLASH}`,
  `https://example.test/${BACKSLASH}`,
];

const ALL_REJECTED_STRINGS = [
  ...EMPTY_AND_WHITESPACE_ONLY,
  ...PROHIBITED_SCHEMES,
  ...SCHEMELESS_AND_PROTOCOL_RELATIVE,
  ...MALFORMED,
  ...EMBEDDED_CREDENTIALS,
  ...INNER_WHITESPACE_CONTROL_AND_BACKSLASH,
];

// [configured value, the one link the resolver must return].
const NORMALIZATION_CASES: Array<[string, string]> = [
  // the plain origin, with and without trailing slashes
  ['https://example.test', 'https://example.test/tour'],
  ['https://example.test/', 'https://example.test/tour'],
  ['https://example.test//', 'https://example.test/tour'],
  ['https://example.test///', 'https://example.test/tour'],
  // a configured path is ignored, never appended to or doubled
  ['https://example.test/some/path', 'https://example.test/tour'],
  ['https://example.test/some/path/', 'https://example.test/tour'],
  ['https://example.test/tour', 'https://example.test/tour'],
  ['https://example.test/tour/', 'https://example.test/tour'],
  ['https://example.test/tour/abra-heritage-route', 'https://example.test/tour'],
  ['https://example.test/packages', 'https://example.test/tour'],
  ['https://example.test/../../etc/passwd', 'https://example.test/tour'],
  // a configured query is ignored
  ['https://example.test?utm_source=x', 'https://example.test/tour'],
  ['https://example.test/?x=1&y=2', 'https://example.test/tour'],
  ['https://example.test/tour?page=2', 'https://example.test/tour'],
  // a configured fragment is ignored
  ['https://example.test#top', 'https://example.test/tour'],
  ['https://example.test/#top', 'https://example.test/tour'],
  ['https://example.test/tour#top', 'https://example.test/tour'],
  // path, query, and fragment together
  ['https://example.test/p/q?x=1#top', 'https://example.test/tour'],
  ['https://example.test:8443/p/q?x=1#top', 'https://example.test:8443/tour'],
  // leading and trailing ASCII whitespace is trimmed
  [' https://example.test ', 'https://example.test/tour'],
  ['\thttps://example.test\n', 'https://example.test/tour'],
  ['\r\n  https://example.test/  \r\n', 'https://example.test/tour'],
  ['\fhttps://example.test\f', 'https://example.test/tour'],
  // scheme and host case are normalized
  ['HTTPS://EXAMPLE.TEST', 'https://example.test/tour'],
  ['https://Example.Test/', 'https://example.test/tour'],
  ['HtTpS://eXaMpLe.TeSt/x', 'https://example.test/tour'],
  // the default port is normalized away
  ['https://example.test:443', 'https://example.test/tour'],
  ['https://example.test:443/', 'https://example.test/tour'],
  ['https://example.test:443/path?x=1#top', 'https://example.test/tour'],
  // valid non-default ports are preserved
  ['https://example.test:8443', 'https://example.test:8443/tour'],
  ['https://example.test:8443/', 'https://example.test:8443/tour'],
  ['https://example.test:8443/x?y#z', 'https://example.test:8443/tour'],
  ['https://example.test:1', 'https://example.test:1/tour'],
  ['https://example.test:65535', 'https://example.test:65535/tour'],
  // other valid https origins
  ['https://catalogue.example.test', 'https://catalogue.example.test/tour'],
  ['https://a.b.c.example.test/', 'https://a.b.c.example.test/tour'],
  [`https://ex${A_WITH_DIAERESIS}mple.test`, 'https://xn--exmple-cua.test/tour'],
  ['https://192.0.2.1', 'https://192.0.2.1/tour'],
  ['https://192.0.2.1:8443/x', 'https://192.0.2.1:8443/tour'],
  ['https://[2001:db8::1]', 'https://[2001:db8::1]/tour'],
  ['https://[2001:db8::1]:8443/', 'https://[2001:db8::1]:8443/tour'],
];

// Non-string values. Several would stringify to a perfectly valid URL, which
// is exactly why they must be rejected without ever being coerced.
const NON_STRING_CASES: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['number 443', 443],
  ['number 0', 0],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['boolean true', true],
  ['boolean false', false],
  ['bigint', BigInt(1)],
  ['symbol', Symbol('https://example.test')],
  ['function', () => 'https://example.test'],
  ['empty object', {}],
  ['object shaped like a URL', { href: 'https://example.test', origin: 'https://example.test' }],
  ['object with a null prototype', Object.create(null)],
  ['empty array', []],
  ['array holding one valid URL string', ['https://example.test']],
  ['array of two strings', ['https://', 'example.test']],
  ['URL instance', new URL('https://example.test')],
  ['String wrapper object', Object('https://example.test')],
];

function makeThrowingProxy(): unknown {
  // Every operation on this value (property read, prototype lookup, `in`, …)
  // throws — only `typeof` is safe, and that is all the resolver may use.
  const handler = new Proxy(
    {},
    {
      get() {
        throw new Error('proxy trap must never be reached');
      },
    },
  );
  return new Proxy({}, handler);
}

function makeThrowingGetterObject(): unknown {
  return Object.defineProperties(
    {},
    {
      toString: {
        get() {
          throw new Error('toString must never be read');
        },
      },
      valueOf: {
        get() {
          throw new Error('valueOf must never be read');
        },
      },
      href: {
        get() {
          throw new Error('href must never be read');
        },
      },
    },
  );
}

function deeplyNestedArray(depth: number): unknown {
  let value: unknown = 'https://example.test';
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

const HOSTILE_INPUTS: unknown[] = [
  makeThrowingProxy(),
  makeThrowingGetterObject(),
  deeplyNestedArray(5_000),
  LONE_SURROGATE,
  `https://${LONE_SURROGATE}.test`,
  `https://example.test/${LONE_SURROGATE}`,
  `https://example.test/${LONE_SURROGATE}${String.fromCharCode(0xdc00)}`,
  `https://${'a'.repeat(100_000)}.test`,
  `https://example.test/${'a'.repeat(200_000)}`,
  '@'.repeat(10_000),
  `https://${'@'.repeat(10_000)}example.test`,
  `https://${'a:'.repeat(5_000)}@example.test`,
  '%'.repeat(10_000),
  `https://example.test/${'%zz'.repeat(5_000)}`,
  `https://[${':'.repeat(2_000)}]`,
  Symbol.for('regional-tours'),
];

// --- Assertions shared by several tests ------------------------------------

function expectWellFormed(result: V2CatalogueLinkResult): void {
  if (result.status === 'unavailable') {
    expect(Object.keys(result)).toEqual(['status']);
    return;
  }

  expect(Object.keys(result).sort()).toEqual(['href', 'status']);
  const url = new URL(result.href);
  expect(url.protocol).toBe('https:');
  expect(url.username).toBe('');
  expect(url.password).toBe('');
  expect(url.pathname).toBe(V2_CATALOGUE_PATH);
  expect(url.search).toBe('');
  expect(url.hash).toBe('');
  // origin + the fixed path, character for character.
  expect(result.href).toBe(`${url.origin}${V2_CATALOGUE_PATH}`);
  expect(result.href).not.toMatch(/[@?#\s\\]/);
}

// --- Tests -------------------------------------------------------------------

describe('resolveV2CatalogueLink — fixed application-owned destination (D-052 §5 rule 8)', () => {
  it('owns the fixed catalogue path "/tour" — never V2 "/packages"', () => {
    expect(V2_CATALOGUE_PATH).toBe('/tour');
    expect(V2_CATALOGUE_PATH).not.toBe('/packages');
  });

  it('returns exactly the origin plus "/tour" for a plain origin', () => {
    expect(resolveV2CatalogueLink('https://example.test')).toEqual(
      availableAt('https://example.test/tour'),
    );
  });
});

describe('resolveV2CatalogueLink — non-string input (D-052 §5)', () => {
  it.each(NON_STRING_CASES)('%s → unavailable', (_label, value) => {
    expect(resolveV2CatalogueLink(value)).toEqual(UNAVAILABLE);
  });

  it('never coerces or stringifies a non-string value', () => {
    const toString = vi.fn(() => 'https://example.test');
    const valueOf = vi.fn(() => 'https://example.test');
    const toPrimitive = vi.fn(() => 'https://example.test');
    const toJSON = vi.fn(() => 'https://example.test');
    const coercible = {
      toString,
      valueOf,
      toJSON,
      [Symbol.toPrimitive]: toPrimitive,
    };
    expect(resolveV2CatalogueLink(coercible)).toEqual(UNAVAILABLE);

    const arrayToString = vi.fn(() => 'https://example.test');
    const arrayWithOwnToString = Object.assign(['https://example.test'], {
      toString: arrayToString,
    });
    expect(resolveV2CatalogueLink(arrayWithOwnToString)).toEqual(UNAVAILABLE);

    const callable = vi.fn(() => 'https://example.test');
    expect(resolveV2CatalogueLink(callable)).toEqual(UNAVAILABLE);

    for (const spy of [toString, valueOf, toPrimitive, toJSON, arrayToString, callable]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('resolveV2CatalogueLink — empty and whitespace-only strings (rule 1)', () => {
  it.each(labelled(EMPTY_AND_WHITESPACE_ONLY))('%s → unavailable', (_label, value) => {
    expect(resolveV2CatalogueLink(value)).toEqual(UNAVAILABLE);
  });
});

describe('resolveV2CatalogueLink — prohibited schemes (rule 4)', () => {
  it.each(labelled(PROHIBITED_SCHEMES))('%s → unavailable', (_label, value) => {
    expect(resolveV2CatalogueLink(value)).toEqual(UNAVAILABLE);
  });
});

describe('resolveV2CatalogueLink — scheme-less and protocol-relative values (rule 3)', () => {
  it.each(labelled(SCHEMELESS_AND_PROTOCOL_RELATIVE))('%s → unavailable', (_label, value) => {
    expect(resolveV2CatalogueLink(value)).toEqual(UNAVAILABLE);
  });
});

describe('resolveV2CatalogueLink — malformed URLs (rules 3 and 6)', () => {
  it.each(labelled(MALFORMED))('%s → unavailable', (_label, value) => {
    expect(resolveV2CatalogueLink(value)).toEqual(UNAVAILABLE);
  });

  it('requires an explicit "//" authority, even where the URL parser is lenient', () => {
    // WHATWG parses these three as if they named a host; D-052 §11 treats
    // `https:///path` as malformed, so none of them may resolve.
    for (const lenient of ['https:///path', 'https:example.test', 'https:/example.test']) {
      expect(new URL(lenient).hostname).not.toBe('');
      expect(resolveV2CatalogueLink(lenient)).toEqual(UNAVAILABLE);
    }
  });
});

describe('resolveV2CatalogueLink — embedded credentials (rule 5)', () => {
  it.each(labelled(EMBEDDED_CREDENTIALS))('%s → unavailable', (_label, value) => {
    expect(resolveV2CatalogueLink(value)).toEqual(UNAVAILABLE);
  });
});

describe('resolveV2CatalogueLink — inner whitespace, control characters, and backslashes (rule 2)', () => {
  it.each(labelled(INNER_WHITESPACE_CONTROL_AND_BACKSLASH))('%s → unavailable', (_label, value) => {
    expect(resolveV2CatalogueLink(value)).toEqual(UNAVAILABLE);
  });
});

describe('resolveV2CatalogueLink — normalization to origin plus "/tour" (rules 2, 7, and 8)', () => {
  it.each(NORMALIZATION_CASES.map(([input, href]) => [JSON.stringify(input), input, href]))(
    '%s → %s',
    (_label, input, href) => {
      expect(resolveV2CatalogueLink(input)).toEqual(availableAt(href as string));
    },
  );

  it('ignores a configured path, query, and fragment rather than rejecting them', () => {
    const withEverything = 'https://example.test/some/path?token=abc#section';
    expect(resolveV2CatalogueLink(withEverything)).toEqual(
      availableAt('https://example.test/tour'),
    );
  });

  it('treats a trailing slash exactly like no trailing slash — one "/tour", never "//tour"', () => {
    const bare = resolveV2CatalogueLink('https://example.test');
    for (const value of [
      'https://example.test/',
      'https://example.test//',
      'https://example.test///',
    ]) {
      expect(resolveV2CatalogueLink(value)).toEqual(bare);
    }
    expect(JSON.stringify(bare)).not.toContain('//tour');
  });

  it('drops the default port 443 but preserves any other explicit port', () => {
    expect(resolveV2CatalogueLink('https://example.test:443')).toEqual(
      availableAt('https://example.test/tour'),
    );
    expect(resolveV2CatalogueLink('https://example.test:8443')).toEqual(
      availableAt('https://example.test:8443/tour'),
    );
  });

  it('lower-cases the scheme and host', () => {
    expect(resolveV2CatalogueLink('HTTPS://EXAMPLE.TEST')).toEqual(
      availableAt('https://example.test/tour'),
    );
  });

  it('never lets a configured path replace or extend the fixed "/tour" path', () => {
    for (const configured of [
      'https://example.test/packages',
      'https://example.test/tour/abra-heritage-route',
      'https://example.test/tour/tour',
    ]) {
      expect(resolveV2CatalogueLink(configured)).toEqual(availableAt('https://example.test/tour'));
    }
  });
});

describe('resolveV2CatalogueLink — never throws (rule "total")', () => {
  it.each(NON_STRING_CASES)('does not throw for non-string input: %s', (_label, value) => {
    expect(() => resolveV2CatalogueLink(value)).not.toThrow();
  });

  it.each(labelled(ALL_REJECTED_STRINGS))(
    'does not throw for string input: %s',
    (_label, value) => {
      expect(() => resolveV2CatalogueLink(value)).not.toThrow();
    },
  );

  it.each(NORMALIZATION_CASES.map(([input]) => [JSON.stringify(input), input]))(
    'does not throw for accepted input: %s',
    (_label, value) => {
      expect(() => resolveV2CatalogueLink(value)).not.toThrow();
    },
  );

  it('does not throw for hostile, degenerate, or oversized input', () => {
    expect(HOSTILE_INPUTS.length).toBeGreaterThan(10);
    for (const hostile of HOSTILE_INPUTS) {
      expect(() => resolveV2CatalogueLink(hostile)).not.toThrow();
      expectWellFormed(resolveV2CatalogueLink(hostile));
    }
  });

  it('answers a value whose every property access would throw without touching it', () => {
    expect(resolveV2CatalogueLink(makeThrowingProxy())).toEqual(UNAVAILABLE);
    expect(resolveV2CatalogueLink(makeThrowingGetterObject())).toEqual(UNAVAILABLE);
  });
});

describe('resolveV2CatalogueLink — result shape invariants', () => {
  it('returns only { status: "unavailable" } or { status: "available", href } for every input', () => {
    const everything: unknown[] = [
      ...NON_STRING_CASES.map(([, value]) => value),
      ...ALL_REJECTED_STRINGS,
      ...NORMALIZATION_CASES.map(([input]) => input),
      ...HOSTILE_INPUTS,
    ];
    expect(everything.length).toBeGreaterThan(150);
    for (const input of everything) {
      expectWellFormed(resolveV2CatalogueLink(input));
    }
  });

  it('every available result is the origin plus "/tour" with no credential, query, or fragment', () => {
    for (const [input, expectedHref] of NORMALIZATION_CASES) {
      const result = resolveV2CatalogueLink(input);
      expect(result).toEqual(availableAt(expectedHref));
      expectWellFormed(result);

      const url = new URL(expectedHref);
      expect(url.pathname).toBe('/tour');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
    }
  });

  it('never resolves any rejected string to an available result', () => {
    for (const input of ALL_REJECTED_STRINGS) {
      expect(resolveV2CatalogueLink(input)).toEqual(UNAVAILABLE);
    }
  });

  it('never leaks a rejected value, or any credential, into its result', () => {
    for (const input of EMBEDDED_CREDENTIALS) {
      const serialized = JSON.stringify(resolveV2CatalogueLink(input));
      expect(serialized).toBe(JSON.stringify(UNAVAILABLE));
      expect(serialized).not.toContain('pass');
      expect(serialized).not.toContain('user');
    }
  });
});

describe('resolveV2CatalogueLink — purity (D-052 §5: no I/O, no shared state)', () => {
  it('returns a fresh object on every call, so a caller can never mutate a shared result', () => {
    const first = resolveV2CatalogueLink(undefined);
    const second = resolveV2CatalogueLink(undefined);
    expect(first).not.toBe(second);
    (first as { status: string }).status = 'tampered';
    expect(resolveV2CatalogueLink(undefined)).toEqual(UNAVAILABLE);
    expect(second).toEqual(UNAVAILABLE);

    const linkA = resolveV2CatalogueLink('https://example.test');
    const linkB = resolveV2CatalogueLink('https://example.test');
    expect(linkA).toEqual(linkB);
    expect(linkA).not.toBe(linkB);
  });

  it('is deterministic — the same input always yields the same result', () => {
    for (const [input] of NORMALIZATION_CASES) {
      expect(resolveV2CatalogueLink(input)).toEqual(resolveV2CatalogueLink(input));
    }
  });

  it('never reads the environment itself — only the value it is passed matters', () => {
    vi.stubEnv('APP_V2_PUBLIC_SITE_URL', 'https://from-the-environment.example.test');
    try {
      expect(resolveV2CatalogueLink(undefined)).toEqual(UNAVAILABLE);
      expect(resolveV2CatalogueLink('https://passed-in.example.test')).toEqual(
        availableAt('https://passed-in.example.test/tour'),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('makes no network or filesystem call', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      resolveV2CatalogueLink('https://example.test');
      resolveV2CatalogueLink(undefined);
      resolveV2CatalogueLink('http://example.test');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('imports nothing — no Prisma, authentication, session, or environment-schema module — and performs no I/O in its code', () => {
    const source = readFileSync(new URL('./catalogue-url.ts', import.meta.url), 'utf8');
    // Executable code only: drop block comments and whole-line comments.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/@\/(lib|features|generated|app)/);
    expect(code).not.toMatch(/\bprisma\b/i);
    expect(code).not.toMatch(/\bauth(entication)?\b|\bsession\b/i);
    expect(code).not.toMatch(/getServerEnv|serverEnvSchema/);
    expect(code).not.toMatch(/\bprocess\b/);
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|node:/);
  });
});
