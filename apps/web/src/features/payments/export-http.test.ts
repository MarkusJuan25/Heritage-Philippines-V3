import { describe, expect, it } from 'vitest';

import {
  financeExportResponse,
  forbiddenResponse,
  isJsonContentType,
  isTrustedOrigin,
  trustedOriginFrom,
  unsupportedMediaTypeResponse,
} from './export-http';

describe('trustedOriginFrom', () => {
  it('reads scheme, hostname, and effective port from the configured base URL', () => {
    expect(trustedOriginFrom('https://app.heritage.example')).toEqual({
      scheme: 'https',
      hostname: 'app.heritage.example',
      port: 443,
    });
    expect(trustedOriginFrom('http://localhost:3000')).toEqual({
      scheme: 'http',
      hostname: 'localhost',
      port: 3000,
    });
    expect(trustedOriginFrom('http://intranet.example')).toMatchObject({ port: 80 });
  });

  it('ignores a path on the configured base URL and lowercases its host', () => {
    expect(trustedOriginFrom('https://App.Heritage.Example/base/path?x=1')).toEqual({
      scheme: 'https',
      hostname: 'app.heritage.example',
      port: 443,
    });
  });

  it('refuses a configured base URL that is not http or https', () => {
    expect(() => trustedOriginFrom('ftp://app.heritage.example')).toThrow(/http or https/);
  });
});

describe('isTrustedOrigin', () => {
  const trusted = trustedOriginFrom('https://app.heritage.example');

  it('accepts the exact origin, with or without the explicit default port', () => {
    expect(isTrustedOrigin('https://app.heritage.example', trusted)).toBe(true);
    expect(isTrustedOrigin('https://app.heritage.example:443', trusted)).toBe(true);
  });

  it.each([
    [null],
    ['null'],
    [''],
    ['https://evil.example'],
    ['http://app.heritage.example'],
    ['https://app.heritage.example:8443'],
    ['https://app.heritage.example:80'],
    ['https://app.heritage.example/'],
    ['https://app.heritage.example/path'],
    ['https://app.heritage.example?x'],
    ['https://app.heritage.example#x'],
    ['https://user@app.heritage.example'],
    ['https://app.heritage.example@evil.example'],
    ['https://APP.heritage.example'],
    ['HTTPS://app.heritage.example'],
    // A header value never reaches the route with surrounding space — the
    // platform strips it — so these are asserted here, on the raw string.
    [' https://app.heritage.example'],
    ['https://app.heritage.example '],
    ['https://app.heritage.example\n'],
    ['https://app.heritage.example, https://app.heritage.example'],
    ['https://app.heritage.example:0443'],
    ['https://app.heritage.example:443443'],
    ['https://app.heritage.example:'],
    ['https://app.heritage.example.'],
    ['https://app..heritage.example'],
    ['https://-app.heritage.example'],
    ['https://app%2eheritage.example'],
    ['https://app.heritage.example.evil.example'],
    ['//app.heritage.example'],
    ['app.heritage.example'],
    ['ftp://app.heritage.example'],
  ])('refuses %j', (header) => {
    expect(isTrustedOrigin(header, trusted)).toBe(false);
  });

  it('compares an IPv6 literal exactly', () => {
    const loopback = trustedOriginFrom('http://[::1]:3000');
    expect(isTrustedOrigin('http://[::1]:3000', loopback)).toBe(true);
    expect(isTrustedOrigin('http://[::2]:3000', loopback)).toBe(false);
    expect(isTrustedOrigin('http://::1:3000', loopback)).toBe(false);
  });

  it('treats a port above 65535 as malformed', () => {
    expect(isTrustedOrigin('https://app.heritage.example:65536', trusted)).toBe(false);
    expect(
      isTrustedOrigin('https://app.heritage.example:65535', {
        scheme: 'https',
        hostname: 'app.heritage.example',
        port: 65535,
      }),
    ).toBe(true);
  });
});

describe('isJsonContentType', () => {
  it.each([
    'application/json',
    'application/json;charset=utf-8',
    'application/json; charset=UTF-8',
    'APPLICATION/JSON ; charset = "utf-8"',
  ])('accepts %s', (header) => {
    expect(isJsonContentType(header)).toBe(true);
  });

  it.each([
    [null],
    [''],
    ['text/plain'],
    ['application/x-www-form-urlencoded'],
    ['multipart/form-data'],
    ['application/jsonp'],
    ['application/vnd.api+json'],
    ['application/json; charset=utf-16'],
    ['application/json; charset=utf-8; boundary=x'],
    ['application/json; boundary=x'],
    ['application/json, text/plain'],
    ['text/plain; application/json'],
  ])('refuses %j', (header) => {
    expect(isJsonContentType(header)).toBe(false);
  });
});

describe('responses', () => {
  it('builds the generic 403', async () => {
    const response = forbiddenResponse();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'You do not have permission to access this resource.' },
    });
  });

  it('builds the 415', async () => {
    const response = unsupportedMediaTypeResponse();
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('builds the download with the required headers and the exact bytes', async () => {
    const content = new Uint8Array([0xef, 0xbb, 0xbf, 0x22, 0x61, 0x22, 0x0d, 0x0a]);
    const response = financeExportResponse({
      exportId: 'export-1',
      dataset: 'bookings',
      formatVersion: 'v1',
      asOf: new Date('2026-10-06T01:30:00.000Z'),
      scope: 'ALL_BOOKINGS',
      rowCount: 0,
      bookingCount: 0,
      filename: 'heritage-finance-bookings-v1-all-dates-20261006T093000+0800.csv',
      content,
    });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      'cache-control': 'no-store',
      'content-disposition':
        'attachment; filename="heritage-finance-bookings-v1-all-dates-20261006T093000+0800.csv"',
      'content-type': 'text/csv; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...content]);
  });
});
