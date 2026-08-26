import { describe, expect, it } from 'vitest';

import {
  clientIdParamSchema,
  idempotencyKeySchema,
  resendInvitationSchema,
  revokeInvitationSchema,
  sendInvitationSchema,
} from './schemas';

describe('clientIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(
      clientIdParamSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(clientIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});

const VALID_RESEND_CONCURRENCY = {
  expectedCurrentSendOperationId: null,
  expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
};

describe('sendInvitationSchema / resendInvitationSchema', () => {
  it.each(['AUTOMATED_EMAIL', 'MANUAL_EMAIL'])('accepts deliveryMethod %s', (deliveryMethod) => {
    expect(sendInvitationSchema.safeParse({ deliveryMethod }).success).toBe(true);
    expect(
      resendInvitationSchema.safeParse({ deliveryMethod, ...VALID_RESEND_CONCURRENCY }).success,
    ).toBe(true);
  });

  it('rejects an unrecognized deliveryMethod', () => {
    expect(sendInvitationSchema.safeParse({ deliveryMethod: 'CARRIER_PIGEON' }).success).toBe(
      false,
    );
  });

  it('rejects a missing deliveryMethod', () => {
    expect(sendInvitationSchema.safeParse({}).success).toBe(false);
  });

  it('resendInvitationSchema accepts a null expectedCurrentSendOperationId (never yet sent or manual-unconfirmed)', () => {
    const result = resendInvitationSchema.safeParse({
      deliveryMethod: 'MANUAL_EMAIL',
      ...VALID_RESEND_CONCURRENCY,
    });
    expect(result.success).toBe(true);
  });

  it('resendInvitationSchema accepts a real UUID expectedCurrentSendOperationId', () => {
    const result = resendInvitationSchema.safeParse({
      deliveryMethod: 'AUTOMATED_EMAIL',
      expectedCurrentSendOperationId: '11111111-1111-4111-8111-111111111111',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('resendInvitationSchema rejects a missing expectedCurrentSendOperationId', () => {
    const result = resendInvitationSchema.safeParse({
      deliveryMethod: 'MANUAL_EMAIL',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('resendInvitationSchema rejects a missing expectedUpdatedAt', () => {
    const result = resendInvitationSchema.safeParse({
      deliveryMethod: 'MANUAL_EMAIL',
      expectedCurrentSendOperationId: null,
    });
    expect(result.success).toBe(false);
  });

  it('resendInvitationSchema rejects a non-UUID expectedCurrentSendOperationId', () => {
    const result = resendInvitationSchema.safeParse({
      deliveryMethod: 'MANUAL_EMAIL',
      expectedCurrentSendOperationId: 'not-a-uuid',
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('resendInvitationSchema rejects a non-ISO-datetime expectedUpdatedAt', () => {
    const result = resendInvitationSchema.safeParse({
      deliveryMethod: 'MANUAL_EMAIL',
      expectedCurrentSendOperationId: null,
      expectedUpdatedAt: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });
});

describe('revokeInvitationSchema', () => {
  it('requires a non-empty reason', () => {
    expect(revokeInvitationSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(revokeInvitationSchema.safeParse({}).success).toBe(false);
  });

  it('trims and accepts a real reason', () => {
    const result = revokeInvitationSchema.safeParse({
      reason: '  client requested cancellation  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('client requested cancellation');
    }
  });
});

describe('idempotencyKeySchema', () => {
  it('accepts a valid UUID', () => {
    expect(idempotencyKeySchema.safeParse('11111111-1111-4111-8111-111111111111').success).toBe(
      true,
    );
  });

  it.each(['not-a-uuid', '', '12345', 'ffffffff-ffff-ffff-ffff-fffffffffffZ'])(
    'rejects %s',
    (value) => {
      expect(idempotencyKeySchema.safeParse(value).success).toBe(false);
    },
  );
});
