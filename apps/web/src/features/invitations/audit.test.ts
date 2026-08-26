import { describe, expect, it } from 'vitest';

import { sanitizeInvitationSnapshot } from './audit';

describe('sanitizeInvitationSnapshot', () => {
  it('picks only the explicitly allow-listed fields, never a raw token, tokenHash, or destinationEmail', () => {
    const record = {
      id: 'inv-1',
      clientId: 'client-1',
      status: 'INVITATION_SENT' as const,
      deliveryMethod: 'AUTOMATED_EMAIL' as const,
      deliveryState: 'AUTOMATED_UNCONFIRMED' as const,
      sendOperationId: 'op-1',
      providerMessageId: 'msg-1',
      expiresAt: new Date('2026-01-08T00:00:00.000Z'),
      // Fields a hypothetically-widened repository select might one day
      // include — sanitizeInvitationSnapshot must never pass these
      // through even if present on the source object, because it builds
      // a fresh object from named fields rather than spreading.
      tokenHash: 'should-never-appear',
      destinationEmail: 'client@example.test',
    };

    const snapshot = sanitizeInvitationSnapshot(record);

    expect(snapshot).toEqual({
      id: 'inv-1',
      clientId: 'client-1',
      status: 'INVITATION_SENT',
      deliveryMethod: 'AUTOMATED_EMAIL',
      deliveryState: 'AUTOMATED_UNCONFIRMED',
      sendOperationId: 'op-1',
      providerMessageId: 'msg-1',
      expiresAt: '2026-01-08T00:00:00.000Z',
    });
    expect(Object.keys(snapshot)).not.toContain('tokenHash');
    expect(Object.keys(snapshot)).not.toContain('destinationEmail');
  });

  it('serializes a null expiresAt as null, not a crash or "null" string', () => {
    const snapshot = sanitizeInvitationSnapshot({
      id: 'inv-2',
      clientId: 'client-2',
      status: 'INVITATION_PREPARED',
      deliveryMethod: null,
      deliveryState: 'NOT_ATTEMPTED',
      sendOperationId: null,
      providerMessageId: null,
      expiresAt: null,
    });

    expect(snapshot.expiresAt).toBeNull();
  });
});
