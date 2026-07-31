import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ClientError, type ClientErrorCode } from './errors';
import {
  clientErrorResponse,
  parseJsonBody,
  parseQuery,
  runClientAction,
  validationErrorResponse,
} from './http';

describe('validationErrorResponse', () => {
  it('produces the standard envelope with field-level details', async () => {
    const response = validationErrorResponse([{ path: ['email'], message: 'invalid' }]);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: [{ path: 'email', message: 'invalid' }],
      },
    });
  });

  it('joins a nested issue path consistently with the existing Lead/Booking/Assignment helpers (dot-joined string)', async () => {
    const response = validationErrorResponse([{ path: ['address', 'line1'], message: 'too long' }]);
    const json = await response.json();

    expect(json.error.details).toEqual([{ path: 'address.line1', message: 'too long' }]);
  });

  it('joins an empty path to an empty string (whole-object refinement issues, e.g. the "at least one editable field" check)', async () => {
    const response = validationErrorResponse([{ path: [], message: 'nothing supplied' }]);
    const json = await response.json();

    expect(json.error.details).toEqual([{ path: '', message: 'nothing supplied' }]);
  });

  it('carries no other keys beyond code/message/details', async () => {
    const response = validationErrorResponse([{ path: ['fullName'], message: 'required' }]);
    const json = await response.json();

    expect(Object.keys(json.error).sort()).toEqual(['code', 'details', 'message']);
  });
});

describe('clientErrorResponse', () => {
  const EXPECTED_STATUS: Record<ClientErrorCode, number> = {
    VALIDATION_ERROR: 400,
    ROLE_NOT_PERMITTED: 403,
    CLIENT_FORBIDDEN: 403,
    CLIENT_NOT_FOUND: 404,
    CLIENT_CONFLICT: 409,
  };

  for (const [code, status] of Object.entries(EXPECTED_STATUS) as [ClientErrorCode, number][]) {
    it(`maps ${code} to HTTP ${status}`, async () => {
      const response = clientErrorResponse(new ClientError(code, 'message'));
      const json = await response.json();

      expect(response.status).toBe(status);
      expect(json).toEqual({ error: { code, message: 'message' } });
    });
  }

  it('carries the exact D-025 §9 CLIENT_NOT_FOUND message unchanged', async () => {
    const response = clientErrorResponse(new ClientError('CLIENT_NOT_FOUND', 'Client not found.'));
    const json = await response.json();
    expect(json).toEqual({ error: { code: 'CLIENT_NOT_FOUND', message: 'Client not found.' } });
  });

  it('carries the exact D-025 §9 CLIENT_CONFLICT message unchanged', async () => {
    const response = clientErrorResponse(
      new ClientError(
        'CLIENT_CONFLICT',
        'This client has changed since it was last loaded. Refresh and try again.',
      ),
    );
    const json = await response.json();
    expect(json.error.message).toBe(
      'This client has changed since it was last loaded. Refresh and try again.',
    );
  });

  it('never adds a details key for a domain ClientError', async () => {
    const response = clientErrorResponse(new ClientError('CLIENT_CONFLICT', 'message'));
    const json = await response.json();
    expect(Object.keys(json.error).sort()).toEqual(['code', 'message']);
  });
});

describe('parseJsonBody', () => {
  const schema = z.object({ fullName: z.string() }).strict();

  it('parses a valid body through the schema', async () => {
    const request = new Request('http://localhost/api/clients/client-1', {
      method: 'PATCH',
      body: JSON.stringify({ fullName: 'Juan' }),
    });
    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.fullName).toBe('Juan');
  });

  it('returns VALIDATION_ERROR for malformed JSON', async () => {
    const request = new Request('http://localhost/api/clients/client-1', {
      method: 'PATCH',
      body: 'not json',
    });
    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      const json = await result.response.json();
      expect(result.response.status).toBe(400);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns VALIDATION_ERROR for a schema-invalid body', async () => {
    const request = new Request('http://localhost/api/clients/client-1', {
      method: 'PATCH',
      body: JSON.stringify({ unknownProperty: true }),
    });
    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      const json = await result.response.json();
      expect(result.response.status).toBe(400);
      expect(json.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('never leaks the malformed-JSON parse exception message', async () => {
    const request = new Request('http://localhost/api/clients/client-1', {
      method: 'PATCH',
      body: '{not valid json at all',
    });
    const result = await parseJsonBody(request, schema);
    if (!result.success) {
      const json = await result.response.json();
      expect(JSON.stringify(json)).not.toMatch(/SyntaxError|Unexpected token/i);
    }
  });
});

describe('parseQuery', () => {
  const schema = z.object({ page: z.coerce.number().default(1) });

  it('parses valid query params', () => {
    const result = parseQuery(new URLSearchParams('page=2'), schema);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.page).toBe(2);
  });

  it('returns a validation error for an invalid value', () => {
    const strictSchema = z.object({ page: z.coerce.number().max(1) });
    const result = parseQuery(new URLSearchParams('page=5'), strictSchema);
    expect(result.success).toBe(false);
  });
});

describe('runClientAction', () => {
  it('shapes a successful result', async () => {
    const response = await runClientAction(
      async () => ({ client: { id: 'client-1' } }),
      (result) => Response.json(result),
    );
    const json = await response.json();
    expect(json).toEqual({ client: { id: 'client-1' } });
  });

  it('translates a ClientError into the standard envelope', async () => {
    const response = await runClientAction(
      async () => {
        throw new ClientError('CLIENT_CONFLICT', 'Refresh and try again.');
      },
      (result) => Response.json(result),
    );
    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json).toEqual({ error: { code: 'CLIENT_CONFLICT', message: 'Refresh and try again.' } });
  });

  it('rethrows an unexpected error unchanged, never converting it to a ClientError', async () => {
    await expect(
      runClientAction(
        async () => {
          throw new Error('unexpected db failure: connection string user=admin pass=secret');
        },
        (result) => Response.json(result),
      ),
    ).rejects.toThrow('unexpected db failure: connection string user=admin pass=secret');
  });

  it('never catches a plain Error as if it were a ClientError (no response is produced for it here)', async () => {
    let caught: unknown;
    try {
      await runClientAction(
        async () => {
          throw new Error('boom');
        },
        (result) => Response.json(result),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ClientError);
  });
});
