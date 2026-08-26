import { createHash } from 'node:crypto';

import { generateRandomString } from 'better-auth/crypto';

// Pure, I/O-free token/expiry primitives (D-034 Stage 3 implementation
// authorization). No Prisma, no network — independently unit-testable and
// safely importable from both the service layer and its tests without
// pulling in a database connection.

const TOKEN_LENGTH = 24;
const EXPIRY_DAYS = 7;

/**
 * Generates a raw invitation token — 24 characters over
 * `a-z,A-Z,0-9,-_` (144 bits of entropy), the exact primitive
 * `features/staff/service.ts`'s `createStaffAccount` already uses for
 * generated passwords (D-034 Section 4). The raw token is returned to the
 * caller exactly once, embedded in the activation link this same
 * request/response cycle sends — it is never logged, never persisted (only
 * its SHA-256 digest is, via `hashInvitationToken`), and never written to
 * AuditLog.
 */
export function generateInvitationToken(): string {
  return generateRandomString(TOKEN_LENGTH, 'a-z', 'A-Z', '0-9', '-_');
}

/**
 * SHA-256 digest of a raw invitation token, hex-encoded — the only form of
 * the token ever persisted (`PortalInvitation.tokenHash`,
 * .claude/rules/database-security.md's "a database read alone can't be
 * replayed as a valid token"). Deliberately plain, unsalted SHA-256, not
 * Better Auth's salted `hashPassword`: a salted hash cannot support the
 * exact-match `tokenHash` lookup a redemption/activation request needs
 * (D-034 Section 4) — recompute this same digest from a presented raw
 * token and compare/look-up by equality, never by re-hashing with a stored
 * salt.
 */
export function hashInvitationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * An invitation token is valid for exactly seven calendar days from the
 * moment it is (re)issued (D-034 Section 4; blueprint Section 16.2,
 * resolved). `now` is an injectable parameter so tests can assert the
 * exact boundary without depending on wall-clock time.
 */
export function computeExpiryFromNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

/** The Resend `Idempotency-Key` this feature sends for one send operation — namespaced so a collision with any other feature's idempotency keys is structurally impossible. */
export function buildResendIdempotencyKey(sendOperationId: string): string {
  return `portal-invitation/${sendOperationId}`;
}
