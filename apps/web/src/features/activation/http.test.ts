import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ActivationError } from './errors';
import { jsonResponse, parseJsonBody, runActivationAction, validationErrorResponse } from './http';

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

describe('parseJsonBody', () => {
  const schema = z.object({ token: z.string() });

  it('returns success:true with parsed data for a valid body', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ token: 'abc' }),
    });
    const result = await parseJsonBody(request, schema);
    expect(result).toEqual({ success: true, data: { token: 'abc' } });
  });

  it('returns a 400 VALIDATION_ERROR response for invalid JSON', async () => {
    const request = new Request('http://localhost/x', { method: 'POST', body: 'not json' });
    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
    }
  });

  it('returns a 400 VALIDATION_ERROR response for a schema mismatch', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ token: 123 }),
    });
    const result = await parseJsonBody(request, schema);
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
