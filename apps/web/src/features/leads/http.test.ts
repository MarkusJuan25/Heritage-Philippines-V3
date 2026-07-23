import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { LeadError } from './errors';
import {
  leadErrorResponse,
  parseJsonBody,
  parseQuery,
  runLeadAction,
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
});

describe('leadErrorResponse', () => {
  it('maps a LeadError to its code/status', async () => {
    const response = leadErrorResponse(new LeadError('LEAD_NOT_FOUND', 'Lead not found.'));
    const json = await response.json();

    expect(response.status).toBe(404);
    expect(json).toEqual({ error: { code: 'LEAD_NOT_FOUND', message: 'Lead not found.' } });
  });
});

describe('parseJsonBody', () => {
  const schema = z.object({ fullName: z.string() }).strict();

  it('parses a valid body', async () => {
    const request = new Request('http://localhost/api/leads', {
      method: 'POST',
      body: JSON.stringify({ fullName: 'Juan' }),
    });
    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.fullName).toBe('Juan');
  });

  it('returns a validation error for malformed JSON', async () => {
    const request = new Request('http://localhost/api/leads', {
      method: 'POST',
      body: 'not json',
    });
    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.response.status).toBe(400);
  });

  it('returns a validation error for a schema violation', async () => {
    const request = new Request('http://localhost/api/leads', {
      method: 'POST',
      body: JSON.stringify({ notAField: true }),
    });
    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.response.status).toBe(400);
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

describe('runLeadAction', () => {
  it('shapes a successful result', async () => {
    const response = await runLeadAction(
      async () => ({ lead: { id: 'lead-1' } }),
      (result) => Response.json(result),
    );
    const json = await response.json();
    expect(json).toEqual({ lead: { id: 'lead-1' } });
  });

  it('translates a LeadError into the standard envelope', async () => {
    const response = await runLeadAction(
      async () => {
        throw new LeadError('LEAD_CONFLICT', 'Refresh and try again.');
      },
      (result) => Response.json(result),
    );
    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json).toEqual({ error: { code: 'LEAD_CONFLICT', message: 'Refresh and try again.' } });
  });

  it('rethrows an unexpected error', async () => {
    await expect(
      runLeadAction(
        async () => {
          throw new Error('unexpected');
        },
        (result) => Response.json(result),
      ),
    ).rejects.toThrow('unexpected');
  });
});
