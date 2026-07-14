import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AssignmentError } from './errors';
import {
  assignmentErrorResponse,
  parseJsonBody,
  runAssignmentAction,
  validationErrorResponse,
} from './http';

describe('validationErrorResponse', () => {
  it('returns a 400 with the standard error envelope and field-level details', async () => {
    const response = validationErrorResponse([
      { path: ['assignedStaffId'], message: 'Invalid uuid' },
    ]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request did not pass validation.',
        details: [{ path: 'assignedStaffId', message: 'Invalid uuid' }],
      },
    });
  });
});

describe('assignmentErrorResponse', () => {
  it('maps an AssignmentError to its declared status and a { code, message } body', () => {
    const error = new AssignmentError('LEAD_NOT_FOUND', 'Lead not found.');
    const response = assignmentErrorResponse(error);
    expect(response.status).toBe(404);
  });

  it('maps a 409-class AssignmentError correctly', async () => {
    const error = new AssignmentError(
      'REASON_REQUIRED',
      'A reason is required when replacing an existing assignment.',
    );
    const response = assignmentErrorResponse(error);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'REASON_REQUIRED',
        message: 'A reason is required when replacing an existing assignment.',
      },
    });
  });
});

const schema = z.object({ assignedStaffId: z.string().min(1) });

describe('parseJsonBody', () => {
  it('returns success with parsed data for a valid body', async () => {
    const request = new Request('http://localhost/api/leads/lead-1/assignment', {
      method: 'PUT',
      body: JSON.stringify({ assignedStaffId: 'staff-1' }),
    });

    const result = await parseJsonBody(request, schema);
    expect(result).toEqual({ success: true, data: { assignedStaffId: 'staff-1' } });
  });

  it('returns a 400 validation response for malformed JSON', async () => {
    const request = new Request('http://localhost/api/leads/lead-1/assignment', {
      method: 'PUT',
      body: '{not json',
    });

    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns a 400 validation response for a schema violation', async () => {
    const request = new Request('http://localhost/api/leads/lead-1/assignment', {
      method: 'PUT',
      body: JSON.stringify({}),
    });

    const result = await parseJsonBody(request, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
    }
  });
});

describe('runAssignmentAction', () => {
  it('returns onSuccess(result) when the action resolves', async () => {
    const response = await runAssignmentAction(
      async () => ({ id: 'assignment-1' }),
      (result) => Response.json(result),
    );
    await expect(response.json()).resolves.toEqual({ id: 'assignment-1' });
  });

  it('translates a thrown AssignmentError into its error envelope', async () => {
    const response = await runAssignmentAction(async () => {
      throw new AssignmentError(
        'ASSIGNEE_INELIGIBLE_ROLE',
        'Only a Travel Consultant may be assigned.',
      );
    }, vi.fn());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'ASSIGNEE_INELIGIBLE_ROLE',
        message: 'Only a Travel Consultant may be assigned.',
      },
    });
  });

  it('rethrows an unexpected error rather than swallowing it', async () => {
    await expect(
      runAssignmentAction(async () => {
        throw new Error('boom: unexpected internal failure');
      }, vi.fn()),
    ).rejects.toThrow('boom: unexpected internal failure');
  });
});
