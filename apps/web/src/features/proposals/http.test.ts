import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ProposalError, type ProposalErrorCode } from './errors';
import {
  parseJsonBody,
  parseQuery,
  proposalErrorResponse,
  runProposalAction,
  validationErrorResponse,
} from './http';

describe('validationErrorResponse', () => {
  it('produces the standard envelope with field-level details', async () => {
    const response = validationErrorResponse([{ path: ['content'], message: 'invalid' }]);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: [{ path: 'content', message: 'invalid' }],
      },
    });
  });

  it('joins a nested issue path consistently with the existing Lead/Booking/Client helpers (dot-joined string)', async () => {
    const response = validationErrorResponse([{ path: ['nested', 'field'], message: 'too long' }]);
    const json = await response.json();

    expect(json.error.details).toEqual([{ path: 'nested.field', message: 'too long' }]);
  });

  it('joins an empty path to an empty string (whole-object refinement issues)', async () => {
    const response = validationErrorResponse([{ path: [], message: 'nothing supplied' }]);
    const json = await response.json();

    expect(json.error.details).toEqual([{ path: '', message: 'nothing supplied' }]);
  });

  it('carries no other keys beyond code/message/details', async () => {
    const response = validationErrorResponse([{ path: ['clientId'], message: 'required' }]);
    const json = await response.json();

    expect(Object.keys(json.error).sort()).toEqual(['code', 'details', 'message']);
  });
});

describe('proposalErrorResponse', () => {
  const EXPECTED_STATUS: Record<ProposalErrorCode, number> = {
    VALIDATION_ERROR: 400,
    ROLE_NOT_PERMITTED: 403,
    CLIENT_NOT_FOUND: 404,
    CLIENT_FORBIDDEN: 403,
    PROPOSAL_NOT_FOUND: 404,
    PROPOSAL_FORBIDDEN: 403,
    PROPOSAL_VERSION_NOT_FOUND: 404,
    PROPOSAL_VERSION_FORBIDDEN: 403,
    PROPOSAL_VERSION_SUPERSEDED: 409,
    PROPOSAL_VERSION_NOT_CURRENT: 409,
    PROPOSAL_RESPONSE_ALREADY_RECORDED: 409,
    PROPOSAL_CONFLICT: 409,
  };

  for (const [code, status] of Object.entries(EXPECTED_STATUS) as [ProposalErrorCode, number][]) {
    it(`maps ${code} to HTTP ${status}`, async () => {
      const response = proposalErrorResponse(new ProposalError(code, 'message'));
      const json = await response.json();

      expect(response.status).toBe(status);
      expect(json).toEqual({ error: { code, message: 'message' } });
    });
  }

  it("carries D-027 §5's exact PROPOSAL_CONFLICT publish message unchanged", async () => {
    const response = proposalErrorResponse(
      new ProposalError(
        'PROPOSAL_CONFLICT',
        'The current version has changed since you last loaded this proposal. Refresh and try again.',
      ),
    );
    const json = await response.json();

    expect(json.error.message).toBe(
      'The current version has changed since you last loaded this proposal. Refresh and try again.',
    );
  });

  it('never adds a details key for a domain ProposalError', async () => {
    const response = proposalErrorResponse(new ProposalError('PROPOSAL_CONFLICT', 'message'));
    const json = await response.json();

    expect(Object.keys(json.error).sort()).toEqual(['code', 'message']);
  });

  it('never leaks a stack trace or constructor name beyond the error envelope', async () => {
    const response = proposalErrorResponse(
      new ProposalError(
        'PROPOSAL_VERSION_FORBIDDEN',
        'Proposal version not found or not accessible.',
      ),
    );
    const json = await response.json();

    expect(JSON.stringify(json)).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(json).not.toHaveProperty('stack');
  });
});

describe('parseJsonBody', () => {
  const schema = z.object({ content: z.string() }).strict();

  it('parses a valid body through the schema', async () => {
    const request = new Request('http://localhost/api/proposals', {
      method: 'POST',
      body: JSON.stringify({ content: 'Day 1.' }),
    });
    const result = await parseJsonBody(request, schema);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.content).toBe('Day 1.');
  });

  it('returns VALIDATION_ERROR for malformed JSON', async () => {
    const request = new Request('http://localhost/api/proposals', {
      method: 'POST',
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

  it('returns VALIDATION_ERROR for a schema-invalid body (e.g. an unrecognized property)', async () => {
    const request = new Request('http://localhost/api/proposals', {
      method: 'POST',
      body: JSON.stringify({ content: 'Day 1.', title: 'Palawan Package' }),
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
    const request = new Request('http://localhost/api/proposals', {
      method: 'POST',
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

describe('runProposalAction', () => {
  it('shapes a successful result', async () => {
    const response = await runProposalAction(
      async () => ({ proposal: { id: 'proposal-1' } }),
      (result) => Response.json(result),
    );
    const json = await response.json();

    expect(json).toEqual({ proposal: { id: 'proposal-1' } });
  });

  it('translates a ProposalError into the standard envelope', async () => {
    const response = await runProposalAction(
      async () => {
        throw new ProposalError('PROPOSAL_VERSION_SUPERSEDED', 'Already superseded.');
      },
      (result) => Response.json(result),
    );
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json).toEqual({
      error: { code: 'PROPOSAL_VERSION_SUPERSEDED', message: 'Already superseded.' },
    });
  });

  it('preserves distinct NOT_FOUND vs. FORBIDDEN codes rather than collapsing them', async () => {
    const notFound = await runProposalAction(
      async () => {
        throw new ProposalError('PROPOSAL_VERSION_NOT_FOUND', 'Proposal version not found.');
      },
      (result) => Response.json(result),
    );
    const forbidden = await runProposalAction(
      async () => {
        throw new ProposalError(
          'PROPOSAL_VERSION_FORBIDDEN',
          'Proposal version not found or not accessible.',
        );
      },
      (result) => Response.json(result),
    );

    expect(notFound.status).toBe(404);
    expect(forbidden.status).toBe(403);
    expect((await notFound.json()).error.code).toBe('PROPOSAL_VERSION_NOT_FOUND');
    expect((await forbidden.json()).error.code).toBe('PROPOSAL_VERSION_FORBIDDEN');
  });

  it('rethrows an unexpected error unchanged, never converting it to a ProposalError', async () => {
    await expect(
      runProposalAction(
        async () => {
          throw new Error('unexpected db failure: connection string user=admin pass=secret');
        },
        (result) => Response.json(result),
      ),
    ).rejects.toThrow('unexpected db failure: connection string user=admin pass=secret');
  });

  it('never catches a plain Error as if it were a ProposalError (no response is produced for it here)', async () => {
    let caught: unknown;
    try {
      await runProposalAction(
        async () => {
          throw new Error('boom');
        },
        (result) => Response.json(result),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ProposalError);
  });
});
