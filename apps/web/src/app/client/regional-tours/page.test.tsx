// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Passes through to the REAL resolver (its own rules are covered by
// `features/regional-tours/catalogue-url.test.ts`) while recording the exact
// value the page hands it, so this file can prove the page passes the raw,
// untrimmed configuration value and nothing else.
const { resolverSpy } = vi.hoisted(() => ({ resolverSpy: vi.fn() }));
vi.mock('@/features/regional-tours/catalogue-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/regional-tours/catalogue-url')>();
  return {
    ...actual,
    resolveV2CatalogueLink: (rawValue: unknown) => {
      resolverSpy(rawValue);
      return actual.resolveV2CatalogueLink(rawValue);
    },
  };
});

import ClientRegionalToursPage, { dynamic, revalidate } from './page';

// D-052 §6/§7/§8/§11, Stage 3. The page is a synchronous Server Component
// with two states and no other behavior: it reads no session, database, or
// service, so — unlike the data routes — there is nothing to mock but the
// one environment variable it reads. Only a reserved, non-routable `.test`
// origin is used here; no real V2 origin appears in this file.
const ENV_NAME = 'APP_V2_PUBLIC_SITE_URL';
const V2_ORIGIN = 'https://v2-public-site.example.test';
const CATALOGUE_HREF = `${V2_ORIGIN}/tour`;

const HEADING = 'Regional Tours';
const AVAILABLE_COPY =
  'Browse the Heritage Philippines tour catalogue on our public website. The catalogue is separate from your client portal.';
const LINK_TEXT = 'View the tour catalogue (opens in a new tab)';
const UNAVAILABLE_COPY =
  "The tour catalogue link isn't available right now. Please contact your Heritage Philippines travel team for help.";

function setConfigured(value: string | undefined) {
  if (value === undefined) {
    delete process.env.APP_V2_PUBLIC_SITE_URL;
  } else {
    process.env.APP_V2_PUBLIC_SITE_URL = value;
  }
}

function attributeNames(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('*')).flatMap((element) => element.getAttributeNames());
}

// jsdom replaces the global `URL`, which `node:fs` rejects, so files next to this
// test are addressed by path rather than by `new URL(..., import.meta.url)`.
function siblingPath(name: string): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), name);
}

// Executable code only: drop block comments and whole-line comments.
function pageCode(): string {
  const source = readFileSync(siblingPath('page.tsx'), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

let originalValue: string | undefined;

beforeEach(() => {
  originalValue = process.env[ENV_NAME];
  delete process.env.APP_V2_PUBLIC_SITE_URL;
  resolverSpy.mockClear();
});

afterEach(() => {
  setConfigured(originalValue);
});

describe('/client/regional-tours page — route configuration', () => {
  it('is per-request dynamic and never cached, so the server-only value is read on every request', () => {
    expect(dynamic).toBe('force-dynamic');
    expect(revalidate).toBe(0);
  });

  it('is a synchronous Server Component: it returns an element, not a promise', () => {
    setConfigured(V2_ORIGIN);

    const result = ClientRegionalToursPage();

    expect(Object.prototype.toString.call(ClientRegionalToursPage)).toBe('[object Function]');
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
  });
});

describe('/client/regional-tours page — available state', () => {
  beforeEach(() => {
    setConfigured(V2_ORIGIN);
  });

  it('renders exactly one <h1> reading "Regional Tours"', () => {
    render(<ClientRegionalToursPage />);

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe(HEADING);
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('renders the exact D-052 §6 paragraph and nothing else in prose', () => {
    const { container } = render(<ClientRegionalToursPage />);

    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.textContent).toBe(AVAILABLE_COPY);
  });

  it('renders exactly one real outbound anchor with the exact visible text, the resolver href, a new tab, and noopener noreferrer', () => {
    const { container } = render(<ClientRegionalToursPage />);

    expect(container.querySelectorAll('a')).toHaveLength(1);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);

    const link = links[0]!;
    expect(link.tagName).toBe('A');
    expect(link.textContent).toBe(LINK_TEXT);
    expect(link.getAttribute('href')).toBe(CATALOGUE_HREF);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // The new-tab disclosure is visible text and part of the accessible name.
    expect(screen.getByRole('link', { name: LINK_TEXT })).toBe(link);
  });

  it('gives the link no attribute beyond href, target, rel, and its class: no aria-label, download, handler, or data-*', () => {
    render(<ClientRegionalToursPage />);

    const link = screen.getByRole('link', { name: LINK_TEXT });
    const names = link.getAttributeNames().filter((name) => name !== 'class');
    expect([...names].sort()).toEqual(['href', 'rel', 'target']);
  });

  it('points at the catalogue only: no client identifier, query, fragment, credential, or tracking value on the href', () => {
    render(<ClientRegionalToursPage />);

    const href = screen.getByRole('link', { name: LINK_TEXT }).getAttribute('href')!;
    expect(href).toBe(CATALOGUE_HREF);
    expect(href).not.toMatch(/[?#@]/);
    expect(href.endsWith('/tour')).toBe(true);
    expect(href).not.toContain('/packages');
  });

  it.each([
    ['a trailing slash', `${V2_ORIGIN}/`, CATALOGUE_HREF],
    ['surrounding whitespace', `  ${V2_ORIGIN}  `, CATALOGUE_HREF],
    [
      'a supplied path, query, and fragment',
      `${V2_ORIGIN}/packages?utm_source=portal#section`,
      CATALOGUE_HREF,
    ],
    [
      'an upper-case host and the default port',
      'https://V2-PUBLIC-SITE.EXAMPLE.TEST:443/',
      CATALOGUE_HREF,
    ],
    [
      'a non-default port',
      `${V2_ORIGIN}:8443/anything`,
      'https://v2-public-site.example.test:8443/tour',
    ],
  ])('uses exactly the resolver result for %s', (_label, configured, expectedHref) => {
    setConfigured(configured);
    render(<ClientRegionalToursPage />);

    expect(screen.getByRole('link', { name: LINK_TEXT }).getAttribute('href')).toBe(expectedHref);
  });

  it('renders no nested <main>, no hidden input, no form control, no image, no frame, and no data-* attribute', () => {
    const { container } = render(<ClientRegionalToursPage />);

    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
    expect(container.querySelector('button, select, textarea, form')).toBeNull();
    expect(container.querySelector('img, iframe, embed, object, svg')).toBeNull();
    expect(attributeNames(container).filter((name) => name.startsWith('data-'))).toEqual([]);
  });
});

describe('/client/regional-tours page — unavailable state', () => {
  const UNAVAILABLE_VALUES: Array<[string, string | undefined]> = [
    ['an unset variable', undefined],
    ['an empty string', ''],
    ['a whitespace-only string', '   \t  '],
    ['an http: origin', 'http://v2-public-site.example.test'],
    ['an ftp: origin', 'ftp://v2-public-site.example.test'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a scheme-less host', 'v2-public-site.example.test'],
    ['a protocol-relative URL', '//v2-public-site.example.test'],
    ['a malformed URL', 'not a url'],
    ['an https: URL with no host', 'https://'],
    ['an https: URL with an empty authority', 'https:///v2-public-site.example.test'],
    ['embedded credentials', 'https://portal-user:secret-pass@v2-public-site.example.test'],
    ['inner whitespace', 'https://v2-public site.example.test'],
    ['a backslash', 'https://v2-public-site.example.test\\tour'],
  ];

  it.each(UNAVAILABLE_VALUES)(
    'renders the calm unavailable copy with one <h1> and no <a> element at all for %s',
    (_label, configured) => {
      setConfigured(configured);

      const { container } = render(<ClientRegionalToursPage />);

      const headings = screen.getAllByRole('heading');
      expect(headings).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(HEADING);

      const paragraphs = container.querySelectorAll('p');
      expect(paragraphs).toHaveLength(1);
      expect(paragraphs[0]!.textContent).toBe(UNAVAILABLE_COPY);

      expect(container.querySelector('a')).toBeNull();
      expect(screen.queryAllByRole('link')).toHaveLength(0);
      expect(container.querySelector('[href]')).toBeNull();
    },
  );

  it.each(UNAVAILABLE_VALUES)(
    'renders nothing derived from the configured value, and no configuration wording, for %s',
    (_label, configured) => {
      setConfigured(configured);

      const { container } = render(<ClientRegionalToursPage />);

      const html = container.innerHTML;
      const text = container.textContent ?? '';
      if (configured !== undefined && configured.trim() !== '') {
        expect(html).not.toContain(configured.trim());
        expect(text).not.toContain(configured.trim());
      }
      expect(html).not.toMatch(/example\.test|portal-user|secret-pass|alert\(1\)/);
      expect(html).not.toMatch(/https?:|APP_V2|environment|configur|variable|\bV2\b/i);
    },
  );

  it('renders no nested <main>, no hidden input, no form control, and no data-* attribute', () => {
    setConfigured(undefined);

    const { container } = render(<ClientRegionalToursPage />);

    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
    expect(container.querySelector('button, select, textarea, form')).toBeNull();
    expect(container.querySelector('img, iframe, embed, object, svg')).toBeNull();
    expect(attributeNames(container).filter((name) => name.startsWith('data-'))).toEqual([]);
  });

  it('never throws, whatever the configured value', () => {
    for (const [, configured] of UNAVAILABLE_VALUES) {
      setConfigured(configured);
      expect(() => ClientRegionalToursPage()).not.toThrow();
    }
  });
});

describe('/client/regional-tours page — configuration is read per request and passed raw', () => {
  it.each([
    ['an unset variable', undefined],
    ['an empty string', ''],
    ['a padded valid origin, untrimmed', `  ${V2_ORIGIN}/ignored?query=1  `],
    ['a valid origin', V2_ORIGIN],
    ['garbage', 'not a url'],
  ] as Array<[string, string | undefined]>)(
    'hands the resolver exactly the raw value, once, for %s',
    (_label, configured) => {
      setConfigured(configured);

      render(<ClientRegionalToursPage />);

      expect(resolverSpy).toHaveBeenCalledTimes(1);
      expect(resolverSpy).toHaveBeenCalledWith(configured);
    },
  );

  it('reads the variable on each call rather than caching it: the same module reflects a changed value', () => {
    setConfigured(V2_ORIGIN);
    const first = render(<ClientRegionalToursPage />);
    expect(screen.getByRole('link', { name: LINK_TEXT }).getAttribute('href')).toBe(CATALOGUE_HREF);
    first.unmount();

    setConfigured('https://other-v2-site.example.test');
    const second = render(<ClientRegionalToursPage />);
    expect(screen.getByRole('link', { name: LINK_TEXT }).getAttribute('href')).toBe(
      'https://other-v2-site.example.test/tour',
    );
    second.unmount();

    setConfigured(undefined);
    const { container } = render(<ClientRegionalToursPage />);
    expect(container.querySelector('a')).toBeNull();
  });

  it('does not read the variable when the module is imported — a value set after import is still honored', async () => {
    vi.resetModules();
    setConfigured(undefined);
    resolverSpy.mockClear();

    const fresh = await import('./page');
    expect(resolverSpy).not.toHaveBeenCalled();

    setConfigured(V2_ORIGIN);
    render(<fresh.default />);

    expect(resolverSpy).toHaveBeenCalledTimes(1);
    expect(resolverSpy).toHaveBeenCalledWith(V2_ORIGIN);
    expect(screen.getByRole('link', { name: LINK_TEXT }).getAttribute('href')).toBe(CATALOGUE_HREF);
  });
});

describe('/client/regional-tours page — source contract (D-052 §4, §8, §9)', () => {
  it('imports only the resolver and its own CSS module: no Prisma, service, session, authentication, or environment-schema module', () => {
    const code = pageCode();

    const imported = Array.from(code.matchAll(/\bfrom\s+'([^']+)'/g)).map((match) => match[1]);
    expect(imported).toEqual([
      '@/features/regional-tours/catalogue-url',
      './regional-tours.module.css',
    ]);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bprisma\b/i);
    expect(code).not.toMatch(/getCurrentUser|getCurrentSession|getOwnClientForUser|getServerEnv/);
    expect(code).not.toMatch(/\bsession\b/i);
  });

  it('is synchronous and performs no network, database, or awaited work', () => {
    const code = pageCode();

    expect(code).not.toMatch(/\basync\b|\bawait\b|\bPromise\b|\.then\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|node:/);
    expect(code).not.toMatch(/\bredirect\b|\bnotFound\b|\bheaders\s*\(|\bcookies\s*\(/);
  });

  it('reads process.env exactly once, inside the page function and never at module scope', () => {
    const code = pageCode();

    const reads = code.match(/process\.env\.[A-Z0-9_]+/g) ?? [];
    expect(reads).toEqual(['process.env.APP_V2_PUBLIC_SITE_URL']);
    expect(code.match(/\bprocess\b/g)).toHaveLength(1);

    const pageStart = code.indexOf('export default function ClientRegionalToursPage');
    expect(pageStart).toBeGreaterThan(-1);
    expect(code.indexOf('process.env.APP_V2_PUBLIC_SITE_URL')).toBeGreaterThan(pageStart);
  });

  it('renders no <main>, no hidden input, no data-* attribute, no handler, no aria-label, and no framing element in its markup', () => {
    const code = pageCode();

    expect(code).not.toMatch(/<main\b/);
    expect(code).not.toMatch(/type=["']hidden["']|<input\b/);
    expect(code).not.toMatch(/\bdata-[a-z]/);
    expect(code).not.toMatch(/\bon[A-Z][A-Za-z]*=/);
    expect(code).not.toMatch(/\baria-label\b|\bdownload\b|dangerouslySetInnerHTML/);
    expect(code).not.toMatch(/<iframe\b|<img\b|<Image\b|<Link\b/);
  });

  it('adds no route-local loading.tsx or error.tsx while the page stays synchronous (D-052 §9)', () => {
    expect(existsSync(siblingPath('loading.tsx'))).toBe(false);
    expect(existsSync(siblingPath('error.tsx'))).toBe(false);
  });
});

describe('regional-tours.module.css — responsive and accessibility rules (D-052 §7)', () => {
  const css = readFileSync(siblingPath('regional-tours.module.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\r\n/g, '\n');

  function rule(selector: string): string {
    const escaped = selector.replace(/[.:()[\]-]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    expect(match, `rule ${selector} exists`).not.toBeNull();
    return match![1]!;
  }

  it('gives the link a tap target of at least 44 by 44 CSS pixels', () => {
    const link = rule('.catalogueLink');
    expect(link).toMatch(/min-height:\s*44px/);
    expect(link).toMatch(/min-width:\s*44px/);
  });

  it('gives the link a visible :focus-visible treatment', () => {
    expect(rule('.catalogueLink:focus-visible')).toMatch(/outline:\s*2px solid\s+#/);
  });

  it('wraps long text instead of scrolling sideways, and uses no fixed pixel width that could overflow 320 px', () => {
    expect(rule('.description')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.heading')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.catalogueLink')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.catalogueLink')).toMatch(/max-width:\s*100%/);
    expect(css.match(/(?<![-\w])width:\s*\d+(?:px|rem|em)/g) ?? []).toEqual([]);
    expect(css).not.toMatch(/\bmax-width:\s*\d+px/);
    expect(css).not.toMatch(/\boverflow-x:\s*(?:scroll|auto)/);
  });
});
