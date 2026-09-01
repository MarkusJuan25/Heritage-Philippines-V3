import { describe, expect, it } from 'vitest';

import { normalizeSourceIdentifier, resolveRequestSource } from './source';

function headersFrom(entries: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

describe('resolveRequestSource', () => {
  it('is default-deny when no trustedHeaderName is configured', () => {
    const headers = headersFrom({ 'x-forwarded-for': '203.0.113.7' });
    expect(resolveRequestSource(headers, {})).toEqual({ trusted: false });
  });

  it('ignores X-Forwarded-For and X-Real-IP unconditionally without an explicit trustConfig', () => {
    const headers = headersFrom({
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '198.51.100.9',
    });
    expect(resolveRequestSource(headers, {})).toEqual({ trusted: false });
  });

  it('is untrusted when the configured header is absent', () => {
    const headers = headersFrom({});
    expect(resolveRequestSource(headers, { trustedHeaderName: 'x-forwarded-for' })).toEqual({
      trusted: false,
    });
  });

  it('trusts a single-valued configured header at the default hop count of 0', () => {
    const headers = headersFrom({ 'x-real-ip': '203.0.113.7' });
    expect(resolveRequestSource(headers, { trustedHeaderName: 'x-real-ip' })).toEqual({
      trusted: true,
      identifier: '203.0.113.7',
    });
  });

  it('selects the entry trustedProxyHopCount positions from the end of a multi-valued header', () => {
    const headers = headersFrom({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' });
    // Two trusted proxies (10.0.0.2 closest, then 10.0.0.1) precede the app;
    // the client's own entry is 2 positions from the end.
    expect(
      resolveRequestSource(headers, {
        trustedHeaderName: 'x-forwarded-for',
        trustedProxyHopCount: 2,
      }),
    ).toEqual({ trusted: true, identifier: '203.0.113.7' });
  });

  it('fails closed when the hop count exceeds the number of entries present', () => {
    const headers = headersFrom({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    expect(
      resolveRequestSource(headers, {
        trustedHeaderName: 'x-forwarded-for',
        trustedProxyHopCount: 5,
      }),
    ).toEqual({ trusted: false });
  });

  it('is untrusted when the configured header value is empty or whitespace-only', () => {
    const headers = headersFrom({ 'x-forwarded-for': '   ' });
    expect(resolveRequestSource(headers, { trustedHeaderName: 'x-forwarded-for' })).toEqual({
      trusted: false,
    });
  });

  it('normalizes the resolved identifier before returning it', () => {
    const headers = headersFrom({ 'x-real-ip': 'FE80::1%eth0' });
    expect(resolveRequestSource(headers, { trustedHeaderName: 'x-real-ip' })).toEqual({
      trusted: true,
      identifier: 'fe80::1',
    });
  });

  it('a simulated attacker cannot flip trust by supplying trust-config-shaped values in a header', () => {
    // trustConfig is never derived from the request itself — a header
    // named "trustedHeaderName" or any request-controlled value has no
    // special meaning.
    const headers = headersFrom({
      trustedheadername: 'x-forwarded-for',
      'x-forwarded-for': '1.2.3.4',
    });
    expect(resolveRequestSource(headers, {})).toEqual({ trusted: false });
  });
});

describe('normalizeSourceIdentifier', () => {
  it('lowercases the identifier', () => {
    expect(normalizeSourceIdentifier('ABCD::1')).toBe('abcd::1');
  });

  it('strips an IPv6 zone identifier', () => {
    expect(normalizeSourceIdentifier('fe80::1%eth0')).toBe('fe80::1');
  });

  it('collapses an IPv4-mapped IPv6 form to its IPv4 equivalent', () => {
    expect(normalizeSourceIdentifier('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('leaves a plain IPv4 address unchanged (aside from casing/trim)', () => {
    expect(normalizeSourceIdentifier(' 203.0.113.7 ')).toBe('203.0.113.7');
  });

  it('leaves a plain, non-mapped IPv6 address unchanged aside from lowercasing', () => {
    expect(normalizeSourceIdentifier('2001:DB8::1')).toBe('2001:db8::1');
  });
});
