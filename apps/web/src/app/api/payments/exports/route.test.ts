import { beforeEach, describe, expect, it, vi } from 'vitest';

// See apps/web/src/app/api/leads/[id]/assignment/route.test.ts for why
// `./auth` and `next/headers` must be mocked before the route is imported.
const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock('@/lib/auth/auth', () => ({ auth: { api: { getSession: getSessionMock } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

// The trusted origin comes from server configuration only.
const env = vi.hoisted(() => ({ BETTER_AUTH_URL: 'https://app.heritage.example' }));
vi.mock('@/lib/env', () => ({ getServerEnv: () => env }));

const { generateFinanceExportMock } = vi.hoisted(() => ({ generateFinanceExportMock: vi.fn() }));
vi.mock('@/features/payments/export-service', () => ({
  generateFinanceExport: generateFinanceExportMock,
}));

import { PaymentError } from '@/features/payments/errors';
import { FinanceExportRequestError } from '@/features/payments/export-schemas';

import * as routeModule from './route';

const { POST } = routeModule;

const TRUSTED = 'https://app.heritage.example';
const REFERENCE = 'HPB-0123456789ABCDEF0123';
const VALID_BODY = { dataset: 'payments', bookingReference: REFERENCE };
const FILENAME = 'heritage-finance-payments-v1-all-dates-20261006T093000+0800.csv';
const CSV_BYTES = new TextEncoder().encode(
  '\uFEFF"paymentId","amount"\r\n"p-1","150.00"\r\n"p-2","=Niño, ""Jun"""\r\n',
);

const ROLES = [
  'SYSTEM_ADMINISTRATOR',
  'ADMIN_MANAGER',
  'TRAVEL_CONSULTANT',
  'FINANCE_ACCOUNTING',
  'VISA_DOCUMENTATION',
  'CLIENT',
] as const;
const EXPORT_ROLES = ['ADMIN_MANAGER', 'FINANCE_ACCOUNTING'] as const;

function user(role: (typeof ROLES)[number]) {
  return { id: `user-${role}`, email: `${role}@example.test`, name: role, role };
}

function exportResult() {
  return {
    exportId: 'export-1',
    dataset: 'payments',
    formatVersion: 'v1',
    asOf: new Date('2026-10-06T01:30:00.000Z'),
    scope: 'ASSIGNED_BOOKINGS',
    rowCount: 2,
    bookingCount: 1,
    filename: FILENAME,
    content: CSV_BYTES,
  };
}

type RequestOptions = {
  origin?: string | null;
  contentType?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
};

function post(options: RequestOptions = {}): Request {
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? TRUSTED : options.origin;
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (origin !== null) headers.set('Origin', origin);
  const raw = options.body === undefined ? VALID_BODY : options.body;
  const request = new Request('https://app.heritage.example/api/payments/exports', {
    method: 'POST',
    headers,
    body: typeof raw === 'string' ? raw : JSON.stringify(raw),
  });
  // `Request` adds a default text/plain content type for a string body; set
  // or remove it afterwards so the test controls the header exactly.
  if (contentType === null) request.headers.delete('Content-Type');
  else request.headers.set('Content-Type', contentType);
  return request;
}

const context = { params: Promise.resolve({}) };

async function call(options: RequestOptions = {}): Promise<Response> {
  return POST(post(options), context);
}

beforeEach(() => {
  vi.clearAllMocks();
  env.BETTER_AUTH_URL = TRUSTED;
  getSessionMock.mockResolvedValue({ user: user('FINANCE_ACCOUNTING') });
  generateFinanceExportMock.mockResolvedValue(exportResult());
});

describe('POST /api/payments/exports — authentication and roles', () => {
  it('returns 401 without a session, never calling the service', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
    expect(generateFinanceExportMock).not.toHaveBeenCalled();
  });

  it.each(ROLES.filter((role) => !EXPORT_ROLES.includes(role as never)))(
    'returns 403 for %s, never calling the service',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: user(role) });
      const response = await call();
      expect(response.status).toBe(403);
      expect(generateFinanceExportMock).not.toHaveBeenCalled();
    },
  );

  it.each(EXPORT_ROLES)(
    'calls the service for %s with the session user and the parsed body',
    async (role) => {
      getSessionMock.mockResolvedValue({ user: user(role) });
      const response = await call();
      expect(response.status).toBe(200);
      expect(generateFinanceExportMock).toHaveBeenCalledTimes(1);
      expect(generateFinanceExportMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: `user-${role}`, role }),
        VALID_BODY,
      );
    },
  );

  it('checks authentication before the origin: an unauthenticated cross-site request gets 401', async () => {
    getSessionMock.mockResolvedValue(null);
    const response = await call({ origin: 'https://evil.example' });
    expect(response.status).toBe(401);
  });

  it('exposes POST only', () => {
    expect(Object.keys(routeModule).sort()).toEqual(['POST', 'runtime']);
  });
});

describe('POST /api/payments/exports — origin', () => {
  const FORBIDDEN_BODY = {
    error: { code: 'FORBIDDEN', message: 'You do not have permission to access this resource.' },
  };

  it.each([
    ['a missing Origin', null],
    ['the literal null', 'null'],
    ['an empty value', ''],
    ['another host', 'https://evil.example'],
    ['another scheme', 'http://app.heritage.example'],
    ['another port', 'https://app.heritage.example:8443'],
    ['a subdomain of the trusted host', 'https://admin.app.heritage.example'],
    ['a parent domain of the trusted host', 'https://heritage.example'],
    ['the trusted host as a prefix of another', 'https://app.heritage.example.evil.example'],
    ['the trusted host as a suffix of another', 'https://evilapp.heritage.example'],
    ['a trailing slash', 'https://app.heritage.example/'],
    ['a path', 'https://app.heritage.example/admin/payments'],
    ['a query', 'https://app.heritage.example?x=1'],
    ['a fragment', 'https://app.heritage.example#x'],
    ['credentials', 'https://user:pass@app.heritage.example'],
    ['the trusted host as credentials for another', 'https://app.heritage.example@evil.example'],
    ['an uppercase host', 'https://APP.heritage.example'],
    ['an uppercase scheme', 'HTTPS://app.heritage.example'],
    ['two origins', 'https://app.heritage.example, https://evil.example'],
    ['the trusted origin twice', 'https://app.heritage.example, https://app.heritage.example'],
    ['a port with a leading zero', 'https://app.heritage.example:0443'],
    ['a port out of range', 'https://app.heritage.example:99999'],
    ['an empty port', 'https://app.heritage.example:'],
    ['a trailing dot on the host', 'https://app.heritage.example.'],
    ['a percent-encoded host', 'https://app%2eheritage.example'],
    ['a scheme-relative value', '//app.heritage.example'],
    ['a bare host', 'app.heritage.example'],
    ['another scheme entirely', 'ftp://app.heritage.example'],
    ['a backslash', 'https://app.heritage.example\\@evil.example'],
  ])('refuses %s with the generic 403, never calling the service', async (_label, origin) => {
    const response = await call({ origin });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(FORBIDDEN_BODY);
    expect(generateFinanceExportMock).not.toHaveBeenCalled();
  });

  it('gives the origin refusal the same body as a forbidden role', async () => {
    const originRefusal = await (await call({ origin: 'https://evil.example' })).json();
    getSessionMock.mockResolvedValue({ user: user('TRAVEL_CONSULTANT') });
    const roleRefusal = await (await call()).json();
    expect(originRefusal).toEqual(roleRefusal);
  });

  it('has no Referer fallback: a trusted Referer does not replace a missing Origin', async () => {
    const response = await call({
      origin: null,
      headers: { Referer: 'https://app.heritage.example/admin/payments' },
    });
    expect(response.status).toBe(403);
    expect(generateFinanceExportMock).not.toHaveBeenCalled();
  });

  it('trusts no Host or forwarded header', async () => {
    const response = await call({
      origin: 'https://evil.example',
      headers: {
        Host: 'evil.example',
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'https',
        Forwarded: 'host=evil.example;proto=https',
      },
    });
    expect(response.status).toBe(403);
    expect(generateFinanceExportMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the exact origin', 'https://app.heritage.example', 'https://app.heritage.example'],
    [
      'an explicit default https port',
      'https://app.heritage.example',
      'https://app.heritage.example:443',
    ],
    [
      'a configured explicit default port',
      'https://app.heritage.example:443',
      'https://app.heritage.example',
    ],
    [
      'a configured base URL with a path',
      'https://app.heritage.example/base/',
      'https://app.heritage.example',
    ],
    [
      'a configured non-default port',
      'https://app.heritage.example:8443',
      'https://app.heritage.example:8443',
    ],
    ['local http with a port', 'http://localhost:3000', 'http://localhost:3000'],
    ['an explicit default http port', 'http://intranet.example', 'http://intranet.example:80'],
    ['an IPv6 loopback', 'http://[::1]:3000', 'http://[::1]:3000'],
  ])('accepts %s', async (_label, configured, origin) => {
    env.BETTER_AUTH_URL = configured;
    const response = await call({ origin });
    expect(response.status).toBe(200);
    expect(generateFinanceExportMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'the default port when a non-default one is configured',
      'https://app.heritage.example:8443',
      'https://app.heritage.example',
    ],
    [
      'the https default port against configured http',
      'http://localhost:3000',
      'http://localhost:443',
    ],
    ['127.0.0.1 when localhost is configured', 'http://localhost:3000', 'http://127.0.0.1:3000'],
  ])('refuses %s', async (_label, configured, origin) => {
    env.BETTER_AUTH_URL = configured;
    const response = await call({ origin });
    expect(response.status).toBe(403);
    expect(generateFinanceExportMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/payments/exports — content type', () => {
  it.each([
    ['a missing Content-Type', null],
    ['text/plain', 'text/plain'],
    ['a form post', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data; boundary=x'],
    ['text/json', 'text/json'],
    ['a JSON-like suffix type', 'application/vnd.api+json'],
    ['a longer type starting with application/json', 'application/jsonp'],
    ['another charset', 'application/json; charset=utf-16'],
    ['an unknown parameter', 'application/json; boundary=x'],
    ['a second parameter', 'application/json; charset=utf-8; boundary=x'],
    ['two media types', 'application/json, text/plain'],
  ])('refuses %s with 415, never calling the service', async (_label, contentType) => {
    const response = await call({ contentType });
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(generateFinanceExportMock).not.toHaveBeenCalled();
  });

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'Application/JSON; Charset="utf-8"',
  ])('accepts %s', async (contentType) => {
    const response = await call({ contentType });
    expect(response.status).toBe(200);
  });

  it('checks the origin before the content type', async () => {
    const response = await call({ origin: 'https://evil.example', contentType: 'text/plain' });
    expect(response.status).toBe(403);
  });
});

describe('POST /api/payments/exports — request and error mapping', () => {
  it('returns the 400 validation envelope for malformed JSON, never calling the service', async () => {
    const response = await call({ body: '{"dataset":' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: [{ path: '', message: 'Request body must be valid JSON.' }],
      },
    });
    expect(generateFinanceExportMock).not.toHaveBeenCalled();
  });

  it('passes any JSON value to the service, which validates it', async () => {
    for (const body of [null, [], 'bookings', 42]) {
      await call({ body: JSON.stringify(body) });
    }
    expect(generateFinanceExportMock.mock.calls.map((args) => args[1])).toEqual([
      null,
      [],
      'bookings',
      42,
    ]);
  });

  it('maps FinanceExportRequestError to the 400 validation envelope with field details', async () => {
    generateFinanceExportMock.mockRejectedValue(
      new FinanceExportRequestError([
        { path: ['from'], message: 'A date range needs both from and to.' },
        {
          path: ['bookingReference'],
          message: 'bookingReference is not a valid booking reference',
        },
      ]),
    );
    const response = await call();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: [
          { path: 'from', message: 'A date range needs both from and to.' },
          {
            path: 'bookingReference',
            message: 'bookingReference is not a valid booking reference',
          },
        ],
      },
    });
  });

  it("keeps the service's 403 when the stored role no longer permits export", async () => {
    generateFinanceExportMock.mockRejectedValue(
      new PaymentError(
        'ROLE_NOT_PERMITTED',
        'This account is not permitted to export finance records.',
      ),
    );
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 'ROLE_NOT_PERMITTED',
        message: 'This account is not permitted to export finance records.',
      },
    });
  });

  it('keeps the 422 row-limit refusal', async () => {
    generateFinanceExportMock.mockRejectedValue(
      new PaymentError('EXPORT_ROW_LIMIT_EXCEEDED', 'This export would hold more than 10000 rows.'),
    );
    const response = await call();
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('EXPORT_ROW_LIMIT_EXCEEDED');
  });

  it('returns the generic 500 for an integrity refusal and exposes nothing about it', async () => {
    generateFinanceExportMock.mockRejectedValue(
      new Error(
        'Finance export refused: stored data failed the integrity check for payments.derivedUnallocated.',
      ),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call();
    errorSpy.mockRestore();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
    const text = JSON.stringify(body);
    for (const leaked of ['integrity', 'derivedUnallocated', 'payments.', 'stored data']) {
      expect(text).not.toContain(leaked);
    }
    expect(response.headers.get('Content-Disposition')).toBeNull();
  });

  it('returns the generic 500 for any other unexpected error', async () => {
    generateFinanceExportMock.mockRejectedValue(new Error('connection to db-host failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call();
    errorSpy.mockRestore();
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('db-host');
  });
});

describe('POST /api/payments/exports — the file', () => {
  it('returns the required download headers', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toBe(`attachment; filename="${FILENAME}"`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it("returns the service's bytes exactly, byte-order mark included", async () => {
    const response = await call();
    const received = new Uint8Array(await response.arrayBuffer());
    expect([...received.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect([...received]).toEqual([...CSV_BYTES]);
  });

  it('grants no cross-origin access on any response', async () => {
    const responses = [
      await call(),
      await call({ origin: 'https://evil.example' }),
      await call({ contentType: 'text/plain' }),
      await call({ body: '{' }),
    ];
    for (const response of responses) {
      for (const name of [...response.headers.keys()]) {
        expect(name.toLowerCase().startsWith('access-control-')).toBe(false);
      }
    }
  });

  it('does not put a booking reference or client name in the filename it relays', async () => {
    const response = await call();
    expect(response.headers.get('Content-Disposition')).not.toContain('HPB-');
  });
});
