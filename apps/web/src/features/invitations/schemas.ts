import { z } from 'zod';

export const clientIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

export const portalInvitationDeliveryMethodSchema = z.enum(['AUTOMATED_EMAIL', 'MANUAL_EMAIL']);

export const sendInvitationSchema = z.object({
  deliveryMethod: portalInvitationDeliveryMethodSchema,
});
export type SendInvitationInput = z.infer<typeof sendInvitationSchema>;

// Stage 3 Correction and Security Review Pass 1 §3: closes the
// stale-resend race (resend A succeeds, resend B later succeeds and
// becomes current, a delayed retry of A must never rotate the token
// again). The caller must have just read the invitation's current
// `sendOperationId`/`updatedAt` (exposed by `GET
// /api/clients/[id]/invitation`, unchanged) and echo them back — mirrors
// features/clients/schemas.ts's already-established `expectedUpdatedAt`
// optimistic-concurrency pattern exactly (same `z.iso.datetime({
// precision: 3 })` shape). `expectedCurrentSendOperationId` is nullable
// because the current value can genuinely be null (never yet sent, or
// sent manually and not yet confirmed).
export const resendInvitationSchema = z.object({
  deliveryMethod: portalInvitationDeliveryMethodSchema,
  expectedCurrentSendOperationId: z.string().uuid().nullable(),
  expectedUpdatedAt: z.iso.datetime({ precision: 3 }),
});
export type ResendInvitationInput = z.infer<typeof resendInvitationSchema>;

export const revokeInvitationSchema = z.object({
  // Required — admin-dashboard.md's "Destructive and Irreversible Actions"
  // rule requires irreversible/sensitive actions to be logged with a
  // reason; this feeds directly into the AuditLog entry (see
  // features/invitations/service.ts). Mirrors
  // features/staff/schemas.ts's deactivateStaffAccountSchema exactly.
  reason: z.string().trim().min(1, 'reason is required').max(500),
});
export type RevokeInvitationInput = z.infer<typeof revokeInvitationSchema>;

/**
 * Validates the client-supplied `Idempotency-Key` header (user-authorized
 * Stage 3 contract, Section 5) required on every send/resend request. A
 * validated UUID — Stage 4 (or any future caller) must generate one UUID
 * per deliberate send/resend action and reuse that exact value only when
 * retrying that same action; a new deliberate action always uses a new
 * UUID. Parsed from the request header directly (see
 * features/invitations/http.ts), not from the JSON body.
 */
export const idempotencyKeySchema = z.string().uuid('Idempotency-Key header must be a valid UUID');
