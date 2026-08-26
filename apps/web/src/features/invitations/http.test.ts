import { describe, expect, it } from 'vitest';

import type { InvitationRecord } from './repository';
import { toInvitationResponse, toNullableInvitationResponse, toSendResultResponse } from './http';

function fullInvitation(): InvitationRecord {
  return {
    id: 'inv-1',
    clientId: 'client-1',
    status: 'INVITATION_SENT',
    tokenHash: 'a'.repeat(64),
    expiresAt: new Date('2026-01-08T00:00:00.000Z'),
    destinationEmail: 'client@example.test',
    deliveryMethod: 'AUTOMATED_EMAIL',
    deliveryState: 'AUTOMATED_UNCONFIRMED',
    sendOperationId: '11111111-1111-4111-8111-111111111111',
    providerMessageId: null,
    deliveryConfirmedAt: null,
    deliveryConfirmedByStaffId: null,
    sentAt: new Date('2026-01-01T00:00:00.000Z'),
    openedAt: null,
    activatedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('toInvitationResponse', () => {
  it('strips tokenHash while preserving every other field', () => {
    const record = fullInvitation();
    const result = toInvitationResponse(record);

    expect(result).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(result)).not.toContain(record.tokenHash);
    expect(result).toEqual({
      id: record.id,
      clientId: record.clientId,
      status: record.status,
      expiresAt: record.expiresAt,
      destinationEmail: record.destinationEmail,
      deliveryMethod: record.deliveryMethod,
      deliveryState: record.deliveryState,
      sendOperationId: record.sendOperationId,
      providerMessageId: record.providerMessageId,
      deliveryConfirmedAt: record.deliveryConfirmedAt,
      deliveryConfirmedByStaffId: record.deliveryConfirmedByStaffId,
      sentAt: record.sentAt,
      openedAt: record.openedAt,
      activatedAt: record.activatedAt,
      revokedAt: record.revokedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  });

  it('exposes sendOperationId (required for the resend concurrency precondition, §3)', () => {
    const record = fullInvitation();
    expect(toInvitationResponse(record).sendOperationId).toBe(record.sendOperationId);
  });
});

describe('toNullableInvitationResponse', () => {
  it('passes null through unchanged ("Not Invited")', () => {
    expect(toNullableInvitationResponse(null)).toBeNull();
  });

  it('strips tokenHash for a real record', () => {
    const result = toNullableInvitationResponse(fullInvitation());
    expect(result).not.toHaveProperty('tokenHash');
  });
});

describe('toSendResultResponse', () => {
  it('strips tokenHash from the nested invitation while preserving manualInvitationUrl', () => {
    const record = fullInvitation();
    const result = toSendResultResponse({
      invitation: record,
      delivery: 'reserved-only',
      manualInvitationUrl: 'http://localhost:3000/activate/raw-token-value',
    });

    expect(result.invitation).not.toHaveProperty('tokenHash');
    expect(result.manualInvitationUrl).toBe('http://localhost:3000/activate/raw-token-value');
    expect(result.delivery).toBe('reserved-only');
  });

  it('never fabricates a manualInvitationUrl when the result did not carry one', () => {
    const result = toSendResultResponse({
      invitation: fullInvitation(),
      delivery: 'AUTOMATED_ACCEPTED',
    });
    expect(result).not.toHaveProperty('manualInvitationUrl');
  });
});
