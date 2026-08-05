import { describe, expect, it } from 'vitest';

import {
  createProposalRevisionSchema,
  createProposalSchema,
  listProposalsQuerySchema,
  proposalIdParamSchema,
  proposalVersionIdParamSchema,
  publishProposalVersionSchema,
  recordProposalResponseSchema,
} from './schemas';

const VALID_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const VALID_UUID_2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('createProposalSchema', () => {
  it('accepts a valid clientId and content', () => {
    const result = createProposalSchema.safeParse({
      clientId: VALID_UUID,
      content: 'Day 1: Arrival.',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ clientId: VALID_UUID, content: 'Day 1: Arrival.' });
    }
  });

  it('rejects a missing clientId', () => {
    expect(createProposalSchema.safeParse({ content: 'Day 1: Arrival.' }).success).toBe(false);
  });

  it('rejects a missing content', () => {
    expect(createProposalSchema.safeParse({ clientId: VALID_UUID }).success).toBe(false);
  });

  it('rejects a non-UUID clientId', () => {
    expect(
      createProposalSchema.safeParse({ clientId: 'not-a-uuid', content: 'Day 1.' }).success,
    ).toBe(false);
  });

  it('rejects any unrecognized property, rather than silently stripping it', () => {
    const result = createProposalSchema.safeParse({
      clientId: VALID_UUID,
      content: 'Day 1.',
      title: 'Palawan Package',
    });

    expect(result.success).toBe(false);
  });

  it('trims leading and trailing whitespace from content, preserving internal characters including newlines', () => {
    const result = createProposalSchema.safeParse({
      clientId: VALID_UUID,
      content: '  Day 1: Arrival.\nDay 2: Tour.  ',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe('Day 1: Arrival.\nDay 2: Tour.');
    }
  });

  it('rejects blank content', () => {
    expect(createProposalSchema.safeParse({ clientId: VALID_UUID, content: '' }).success).toBe(
      false,
    );
  });

  it('rejects whitespace-only content', () => {
    expect(
      createProposalSchema.safeParse({ clientId: VALID_UUID, content: '   \n\t  ' }).success,
    ).toBe(false);
  });

  it('accepts content that is exactly 20,000 characters', () => {
    const content = 'a'.repeat(20000);
    const result = createProposalSchema.safeParse({ clientId: VALID_UUID, content });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content.length).toBe(20000);
    }
  });

  it('accepts content that is exactly 20,000 characters only after trimming surrounding whitespace', () => {
    const content = `  ${'a'.repeat(20000)}  `;
    const result = createProposalSchema.safeParse({ clientId: VALID_UUID, content });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content.length).toBe(20000);
    }
  });

  it('rejects content that is 20,001 characters after trimming', () => {
    const content = 'a'.repeat(20001);
    expect(createProposalSchema.safeParse({ clientId: VALID_UUID, content }).success).toBe(false);
  });

  it('preserves a markup-looking string as plain-text data, never interpreting, stripping, or escaping it', () => {
    const markup = '<script>alert(1)</script> & <b>bold</b>';
    const result = createProposalSchema.safeParse({ clientId: VALID_UUID, content: markup });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toBe(markup);
    }
  });
});

describe('createProposalRevisionSchema', () => {
  it('accepts a valid content-only body', () => {
    const result = createProposalRevisionSchema.safeParse({ content: 'Revised itinerary.' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ content: 'Revised itinerary.' });
    }
  });

  it('rejects a missing content', () => {
    expect(createProposalRevisionSchema.safeParse({}).success).toBe(false);
  });

  it('rejects blank content', () => {
    expect(createProposalRevisionSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('rejects whitespace-only content', () => {
    expect(createProposalRevisionSchema.safeParse({ content: '   ' }).success).toBe(false);
  });

  it('rejects content over 20,000 characters after trimming', () => {
    expect(createProposalRevisionSchema.safeParse({ content: 'a'.repeat(20001) }).success).toBe(
      false,
    );
  });

  it('rejects a caller-supplied clientId — the target Proposal is fixed by the route param, never re-supplied in the body', () => {
    const result = createProposalRevisionSchema.safeParse({
      content: 'Revised itinerary.',
      clientId: VALID_UUID,
    });

    expect(result.success).toBe(false);
  });

  it('rejects any other unrecognized property', () => {
    expect(
      createProposalRevisionSchema.safeParse({ content: 'Revised.', versionNumber: 2 }).success,
    ).toBe(false);
  });
});

describe('publishProposalVersionSchema', () => {
  it('accepts a valid UUID expectedCurrentVersionId', () => {
    const result = publishProposalVersionSchema.safeParse({
      expectedCurrentVersionId: VALID_UUID,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ expectedCurrentVersionId: VALID_UUID });
    }
  });

  it('accepts an explicit null expectedCurrentVersionId', () => {
    const result = publishProposalVersionSchema.safeParse({ expectedCurrentVersionId: null });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ expectedCurrentVersionId: null });
    }
  });

  it('rejects an omitted expectedCurrentVersionId — D-027 §5 requires the key on every request, never merely optional', () => {
    expect(publishProposalVersionSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-UUID, non-null expectedCurrentVersionId', () => {
    expect(
      publishProposalVersionSchema.safeParse({ expectedCurrentVersionId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('rejects any unrecognized property', () => {
    expect(
      publishProposalVersionSchema.safeParse({
        expectedCurrentVersionId: VALID_UUID,
        force: true,
      }).success,
    ).toBe(false);
  });
});

describe('recordProposalResponseSchema', () => {
  const validBody = {
    responseType: 'ACCEPT' as const,
    respondedAt: '2026-08-04T10:00:00.000Z',
    responseMethod: 'phone',
    evidenceReference: 'Call log #4821',
  };

  it('accepts a valid ACCEPT response body', () => {
    const result = recordProposalResponseSchema.safeParse(validBody);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validBody);
    }
  });

  it('accepts DECLINE and REQUEST_CHANGES as responseType', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, responseType: 'DECLINE' }).success,
    ).toBe(true);
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, responseType: 'REQUEST_CHANGES' })
        .success,
    ).toBe(true);
  });

  it('rejects an invalid responseType', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, responseType: 'MAYBE' }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO-8601 respondedAt', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, respondedAt: '08/04/2026' }).success,
    ).toBe(false);
  });

  it('accepts a respondedAt with a UTC Z suffix', () => {
    expect(
      recordProposalResponseSchema.safeParse({
        ...validBody,
        respondedAt: '2026-08-04T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('accepts a respondedAt with a numeric UTC offset, such as Philippine time (+08:00)', () => {
    expect(
      recordProposalResponseSchema.safeParse({
        ...validBody,
        respondedAt: '2026-08-04T18:00:00+08:00',
      }).success,
    ).toBe(true);
  });

  it('rejects a timezone-less local respondedAt — D-027 §6 requires an ISO-8601 string, and a bare local datetime carries no timezone information at all', () => {
    expect(
      recordProposalResponseSchema.safeParse({
        ...validBody,
        respondedAt: '2026-08-04T18:00:00',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing responseType', () => {
    expect(
      recordProposalResponseSchema.safeParse({
        respondedAt: validBody.respondedAt,
        responseMethod: validBody.responseMethod,
        evidenceReference: validBody.evidenceReference,
      }).success,
    ).toBe(false);
  });

  it('rejects a missing respondedAt', () => {
    expect(
      recordProposalResponseSchema.safeParse({
        responseType: validBody.responseType,
        responseMethod: validBody.responseMethod,
        evidenceReference: validBody.evidenceReference,
      }).success,
    ).toBe(false);
  });

  it('rejects a missing responseMethod', () => {
    expect(
      recordProposalResponseSchema.safeParse({
        responseType: validBody.responseType,
        respondedAt: validBody.respondedAt,
        evidenceReference: validBody.evidenceReference,
      }).success,
    ).toBe(false);
  });

  it('rejects a missing evidenceReference', () => {
    expect(
      recordProposalResponseSchema.safeParse({
        responseType: validBody.responseType,
        respondedAt: validBody.respondedAt,
        responseMethod: validBody.responseMethod,
      }).success,
    ).toBe(false);
  });

  it('rejects blank responseMethod', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, responseMethod: '  ' }).success,
    ).toBe(false);
  });

  it('rejects blank evidenceReference', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, evidenceReference: '  ' }).success,
    ).toBe(false);
  });

  it('rejects responseMethod over 100 characters', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, responseMethod: 'a'.repeat(101) })
        .success,
    ).toBe(false);
  });

  it('accepts responseMethod at exactly 100 characters', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, responseMethod: 'a'.repeat(100) })
        .success,
    ).toBe(true);
  });

  it('rejects evidenceReference over 500 characters', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, evidenceReference: 'a'.repeat(501) })
        .success,
    ).toBe(false);
  });

  it('accepts evidenceReference at exactly 500 characters', () => {
    expect(
      recordProposalResponseSchema.safeParse({ ...validBody, evidenceReference: 'a'.repeat(500) })
        .success,
    ).toBe(true);
  });

  it('trims responseMethod and evidenceReference', () => {
    const result = recordProposalResponseSchema.safeParse({
      ...validBody,
      responseMethod: '  phone  ',
      evidenceReference: '  Call log #4821  ',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseMethod).toBe('phone');
      expect(result.data.evidenceReference).toBe('Call log #4821');
    }
  });

  it('rejects any unrecognized property, such as a caller-supplied recordedByStaffUserId', () => {
    const result = recordProposalResponseSchema.safeParse({
      ...validBody,
      recordedByStaffUserId: VALID_UUID,
    });

    expect(result.success).toBe(false);
  });
});

describe('listProposalsQuerySchema', () => {
  it('defaults page to 1 and pageSize to 20 when omitted', () => {
    const result = listProposalsQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ page: 1, pageSize: 20 });
    }
  });

  it('coerces string query-param values to numbers', () => {
    const result = listProposalsQuerySchema.safeParse({ page: '3', pageSize: '50' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ page: 3, pageSize: 50 });
    }
  });

  it('rejects a pageSize above 100', () => {
    expect(listProposalsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });

  it('accepts a pageSize at exactly 100', () => {
    expect(listProposalsQuerySchema.safeParse({ pageSize: '100' }).success).toBe(true);
  });

  it('rejects a page below 1', () => {
    expect(listProposalsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('rejects an unrecognized query parameter, such as a client filter this checkpoint does not authorize', () => {
    expect(listProposalsQuerySchema.safeParse({ clientId: VALID_UUID }).success).toBe(false);
  });
});

describe('proposalIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(proposalIdParamSchema.safeParse({ id: VALID_UUID }).success).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(proposalIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects a missing id', () => {
    expect(proposalIdParamSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unrecognized property', () => {
    expect(proposalIdParamSchema.safeParse({ id: VALID_UUID, extra: 'x' }).success).toBe(false);
  });
});

describe('proposalVersionIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(proposalVersionIdParamSchema.safeParse({ id: VALID_UUID_2 }).success).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(proposalVersionIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects a missing id', () => {
    expect(proposalVersionIdParamSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unrecognized property', () => {
    expect(proposalVersionIdParamSchema.safeParse({ id: VALID_UUID_2, extra: 'x' }).success).toBe(
      false,
    );
  });
});
