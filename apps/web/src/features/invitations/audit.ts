import type {
  PortalInvitationDeliveryMethod,
  PortalInvitationDeliveryState,
  PortalInvitationStatus,
} from '@/generated/prisma/client';

// Action names written to AuditLog.action (D-034 Section 9;
// .claude/rules/backend.md's Auditability rule). RESENT is deliberately
// shared by both the explicit-resend and reissue-after-expiry actions — the
// underlying effect (rotate the token, return to Invitation Sent) is
// identical, so D-034 Section 9 names one audit action for both. OPENED and
// ACTIVATED are listed for completeness (D-034's full 7-action contract)
// but are written by the Stage 5 public activation surface, not this
// feature.
export const INVITATION_AUDIT_ACTIONS = {
  PREPARED: 'PORTAL_INVITATION_PREPARED',
  SENT_AUTOMATED: 'PORTAL_INVITATION_SENT_AUTOMATED',
  SENT_MANUAL_CONFIRMED: 'PORTAL_INVITATION_SENT_MANUAL_CONFIRMED',
  RESENT: 'PORTAL_INVITATION_RESENT',
  REVOKED: 'PORTAL_INVITATION_REVOKED',
  OPENED: 'PORTAL_INVITATION_OPENED',
  ACTIVATED: 'PORTAL_INVITATION_ACTIVATED',
} as const;

export const INVITATION_AUDIT_ENTITY_TYPE = 'PortalInvitation';

export type AuditInvitationSnapshot = {
  id: string;
  clientId: string;
  status: PortalInvitationStatus;
  deliveryMethod: PortalInvitationDeliveryMethod | null;
  deliveryState: PortalInvitationDeliveryState;
  sendOperationId: string | null;
  providerMessageId: string | null;
  expiresAt: string | null;
};

/**
 * Builds an AuditLog before/after snapshot for a PortalInvitation. An
 * explicit allow-list, not a spread of the source record (mirrors
 * features/staff/audit.ts's `sanitizeAccountSnapshot`) — D-034 Section 9
 * forbids the raw token, the token digest (`tokenHash`), and any excess
 * Client PII from ever reaching AuditLog. `destinationEmail` is
 * deliberately excluded too: it is the invitation's own operational
 * concern, not needed to explain *what changed* in an audit trail, and
 * keeping it out is one less place a client's email address is persisted
 * outside the record that owns it.
 */
export function sanitizeInvitationSnapshot(record: {
  id: string;
  clientId: string;
  status: PortalInvitationStatus;
  deliveryMethod: PortalInvitationDeliveryMethod | null;
  deliveryState: PortalInvitationDeliveryState;
  sendOperationId: string | null;
  providerMessageId: string | null;
  expiresAt: Date | null;
}): AuditInvitationSnapshot {
  return {
    id: record.id,
    clientId: record.clientId,
    status: record.status,
    deliveryMethod: record.deliveryMethod,
    deliveryState: record.deliveryState,
    sendOperationId: record.sendOperationId,
    providerMessageId: record.providerMessageId,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
  };
}
