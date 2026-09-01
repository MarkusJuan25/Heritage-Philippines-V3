import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { getServerEnvMock } = vi.hoisted(() => ({ getServerEnvMock: vi.fn() }));
vi.mock('@/lib/env', () => ({ getServerEnv: getServerEnvMock }));

import { ActivationError } from './errors';
import {
  MAX_BODY_BYTES,
  checkContentType,
  checkDeclaredContentLength,
  checkOrigin,
  forbiddenResponse,
  jsonResponse,
  parseJsonBody,
  rateLimitedResponse,
  readBoundedBody,
  runActivationAction,
  validationErrorResponse,
} from './http';

beforeEach(() => {
  getServerEnvMock.mockReturnValue({ BETTER_AUTH_URL: 'http://localhost:3000' });
});

describe('jsonResponse', () => {
  it('sets Cache-Control: no-store and Referrer-Policy: no-referrer', () => {
    const response = jsonResponse({ ok: true }, 200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('uses the given status and body', async () => {
    const response = jsonResponse({ activated: true }, 200);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activated: true });
  });
});

describe('validationErrorResponse', () => {
  it('returns the standard VALIDATION_ERROR envelope at 400, with headers set', async () => {
    const response = validationErrorResponse([{ path: ['password'], message: 'too short' }]);
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: [{ path: 'password', message: 'too short' }],
      },
    });
  });
});

describe('forbiddenResponse', () => {
  it('returns the exact D-037 Section 3 FORBIDDEN envelope at 403', async () => {
    const response = forbiddenResponse();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'Request rejected.' },
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('rateLimitedResponse', () => {
  it('returns the exact D-037 Section 3 RATE_LIMITED envelope at 429', async () => {
    const response = rateLimitedResponse();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
    });
  });
});

describe('checkOrigin', () => {
  it('accepts a matching Origin', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(checkOrigin(request)).toEqual({ ok: true });
  });

  it('accepts a matching Origin even when the incoming Origin has a trailing path-irrelevant form (origin-only compare)', () => {
    getServerEnvMock.mockReturnValue({ BETTER_AUTH_URL: 'http://localhost:3000/' });
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(checkOrigin(request)).toEqual({ ok: true });
  });

  it('rejects a missing Origin header with 403', async () => {
    const request = new Request('http://localhost:3000/api/x', { method: 'POST' });
    const result = checkOrigin(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({
        error: { code: 'FORBIDDEN', message: 'Request rejected.' },
      });
    }
  });

  it('rejects a malformed Origin header with 403', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { Origin: 'not-a-valid-origin' },
    });
    const result = checkOrigin(request);
    expect(result.ok).toBe(false);
  });

  it('rejects a mismatched Origin with 403', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    const result = checkOrigin(request);
    expect(result.ok).toBe(false);
  });

  it('rejects the opaque literal Origin: "null" with 403 (never parses as a valid URL)', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { Origin: 'null' },
    });
    const result = checkOrigin(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });

  it('rejects an Origin that is syntactically a URL but carries no scheme (e.g. "//evil.example")', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { Origin: '//evil.example' },
    });
    expect(checkOrigin(request).ok).toBe(false);
  });
});

describe('checkContentType', () => {
  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])(
    'accepts %s',
    (contentType) => {
      const request = new Request('http://localhost:3000/api/x', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
      });
      expect(checkContentType(request)).toEqual({ ok: true });
    },
  );

  it('rejects a missing Content-Type', () => {
    const request = new Request('http://localhost:3000/api/x', { method: 'POST' });
    expect(checkContentType(request).ok).toBe(false);
  });

  it.each(['text/plain', 'application/json; boundary=foo', 'application/xml'])(
    'rejects %s',
    (contentType) => {
      const request = new Request('http://localhost:3000/api/x', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
      });
      expect(checkContentType(request).ok).toBe(false);
    },
  );
});

describe('checkDeclaredContentLength', () => {
  it('allows an absent Content-Length', () => {
    const request = new Request('http://localhost:3000/api/x', { method: 'POST' });
    expect(checkDeclaredContentLength(request)).toEqual({ ok: true });
  });

  it('allows a declared length within the cap', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { 'Content-Length': '100' },
    });
    expect(checkDeclaredContentLength(request)).toEqual({ ok: true });
  });

  it('rejects a non-numeric Content-Length', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { 'Content-Length': 'abc' },
    });
    expect(checkDeclaredContentLength(request).ok).toBe(false);
  });

  it('rejects a declared length exceeding the cap', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) },
    });
    expect(checkDeclaredContentLength(request).ok).toBe(false);
  });

  it('rejects a negative Content-Length', () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { 'Content-Length': '-100' },
    });
    expect(checkDeclaredContentLength(request).ok).toBe(false);
  });

  it('rejects a Content-Length with a leading-plus, decimal, exponential, or hex form (not a plain non-negative integer)', () => {
    // Note: the Fetch Headers implementation itself trims surrounding
    // whitespace from a header value before this function ever sees it
    // (verified directly against the installed undici), so " 100"/"100 "
    // are not meaningfully malformed by the time they reach here — only
    // genuinely non-digit forms are exercised.
    for (const value of ['+100', '1.5', '1e3', '0x10']) {
      const request = new Request('http://localhost:3000/api/x', {
        method: 'POST',
        headers: { 'Content-Length': value },
      });
      expect(checkDeclaredContentLength(request).ok).toBe(false);
    }
  });
});

describe('readBoundedBody', () => {
  it('reads a body within the cap', async () => {
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      body: JSON.stringify({ token: 'abc' }),
    });
    const result = await readBoundedBody(request);
    expect(result).toEqual({ ok: true, text: JSON.stringify({ token: 'abc' }) });
  });

  it('returns an empty string for a request with no body', async () => {
    const request = new Request('http://localhost:3000/api/x', { method: 'GET' });
    const result = await readBoundedBody(request);
    expect(result).toEqual({ ok: true, text: '' });
  });

  it('rejects a body exceeding MAX_BODY_BYTES even when Content-Length under-declares it', async () => {
    const oversized = 'a'.repeat(MAX_BODY_BYTES + 1);
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      // Deliberately no Content-Length header set by us — verified
      // directly against the installed undici that a string-body Request
      // does not auto-populate one, so this genuinely exercises "missing
      // Content-Length, oversized real body". The point of this test is
      // that the byte-counting reader itself, not Content-Length, enforces
      // the cap.
      body: oversized,
    });
    const result = await readBoundedBody(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it('rejects a body exceeding MAX_BODY_BYTES even when a caller-set Content-Length header contradicts it (declares far less)', async () => {
    const oversized = 'b'.repeat(MAX_BODY_BYTES + 500);
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      // A deliberately wrong, small declared value — checkDeclaredContentLength
      // only validates the declared value's own shape/cap, never cross-checks
      // it against the real stream; readBoundedBody must still catch this.
      headers: { 'Content-Length': '10' },
      body: oversized,
    });
    const result = await readBoundedBody(request);
    expect(result.ok).toBe(false);
  });

  it('correctly reads a body whose actual UTF-8 byte length differs from its character length (multi-byte characters)', async () => {
    // '€' is 1 UTF-16 code unit / 3 UTF-8 bytes — proves the cap is a real
    // byte count, not a JS string .length count.
    const body = JSON.stringify({ token: '€'.repeat(100) });
    const request = new Request('http://localhost:3000/api/x', { method: 'POST', body });
    const result = await readBoundedBody(request);
    expect(result).toEqual({ ok: true, text: body });
  });

  it('gracefully rejects a stream that errors partway through (prematurely terminated), rather than throwing', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"token":"'));
        controller.error(new Error('connection reset'));
      },
    });
    const request = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);

    const result = await readBoundedBody(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });
});

describe('parseJsonBody', () => {
  const schema = z.object({ token: z.string() });

  it('returns success:true with parsed data for valid text', () => {
    const result = parseJsonBody(JSON.stringify({ token: 'abc' }), schema);
    expect(result).toEqual({ success: true, data: { token: 'abc' } });
  });

  it('returns a 400 VALIDATION_ERROR response for invalid JSON text', () => {
    const result = parseJsonBody('not json', schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
    }
  });

  it('returns a 400 VALIDATION_ERROR response for a schema mismatch', () => {
    const result = parseJsonBody(JSON.stringify({ token: 123 }), schema);
    expect(result.success).toBe(false);
  });

  it('treats empty text as an empty/undefined body rather than throwing', () => {
    const result = parseJsonBody('', schema);
    expect(result.success).toBe(false);
  });
});

describe('runActivationAction', () => {
  it('returns onSuccess(result) when the action resolves', async () => {
    const response = await runActivationAction(
      async () => ({ opened: true as const }),
      (result) => jsonResponse(result, 200),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ opened: true });
  });

  it('translates a thrown ActivationError into the generic 409 envelope', async () => {
    const response = await runActivationAction(
      async () => {
        throw new ActivationError();
      },
      (result) => jsonResponse(result, 200),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'ACTIVATION_NOT_POSSIBLE',
        message: 'This invitation link is no longer valid.',
      },
    });
  });

  it('rethrows any other error rather than swallowing it', async () => {
    await expect(
      runActivationAction(
        async () => {
          throw new Error('unexpected');
        },
        (result) => jsonResponse(result, 200),
      ),
    ).rejects.toThrow('unexpected');
  });
});
