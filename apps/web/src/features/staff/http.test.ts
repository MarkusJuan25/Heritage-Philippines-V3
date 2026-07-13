import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { StaffManagementError } from './errors';
import {
  parseJsonBody,
  parseQuery,
  runStaffAction,
  staffManagementErrorResponse,
  validationErrorResponse,
} from './http';

describe('validationErrorResponse', () => {
  it('returns a 400 with the standard error envelope and field-level details', async () => {
    const response = validationErrorResponse([{ path: ['email'], message: 'Invalid email' }]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: [{ path: 'email', message: 'Invalid email' }],
      },
    });
  });
});

describe('staffManagementErrorResponse', () => {
  it('maps a StaffManagementError to its declared status and a { code, message } body', async () => {
    const error = new StaffManagementError('STAFF_ACCOUNT_NOT_FOUND', 'Staff account not found.');
    const response = staffManagementErrorResponse(error);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'STAFF_ACCOUNT_NOT_FOUND', message: 'Staff account not found.' },
    });
  });
});

const schema = z.object({ name: z.string().min(1) });

describe('parseJsonBody', () => {
  it('returns success with parsed data for a valid body', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify({ name: 'Jordan' }),
    });

    const result = await parseJsonBody(request, schema);
    expect(result).toEqual({ success: true, data: { name: 'Jordan' } });
  });

  it('returns a 400 validation response for malformed JSON', async () => {
    const request = new Request('http://localhost/api/test', { method: 'POST', body: '{not json' });

    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
    }
  });

  it('returns a 400 validation response for a schema violation', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    });

    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('parseQuery', () => {
  it('returns success with parsed data for valid query params', () => {
    const params = new URLSearchParams({ name: 'Jordan' });
    const result = parseQuery(params, schema);
    expect(result).toEqual({ success: true, data: { name: 'Jordan' } });
  });

  it('returns a 400 validation response for invalid query params', () => {
    const params = new URLSearchParams({ name: '' });
    const result = parseQuery(params, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
    }
  });
});

describe('runStaffAction', () => {
  it('returns onSuccess(result) when the action resolves', async () => {
    const response = await runStaffAction(
      async () => ({ id: 'user-1' }),
      (result) => Response.json(result),
    );
    await expect(response.json()).resolves.toEqual({ id: 'user-1' });
  });

  it('translates a thrown StaffManagementError into its error envelope', async () => {
    const response = await runStaffAction(async () => {
      throw new StaffManagementError(
        'SELF_ACTION_FORBIDDEN',
        'You cannot perform this action on your own account.',
      );
    }, vi.fn());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'SELF_ACTION_FORBIDDEN',
        message: 'You cannot perform this action on your own account.',
      },
    });
  });

  it('rethrows an unexpected error rather than swallowing it', async () => {
    await expect(
      runStaffAction(async () => {
        throw new Error('boom: unexpected internal failure');
      }, vi.fn()),
    ).rejects.toThrow('boom: unexpected internal failure');
  });
});
