// D-037 Section 3/6: a single, deliberately generic domain error for every
// activation-eligibility failure and every collision cause — a caller must
// never be able to distinguish "not found" from "expired" from "revoked"
// from "already activated" from "email collision" from "profile
// collision" by response shape, status code, or message text (D-034
// Section 6's anti-enumeration requirement). This is why this feature
// defines exactly one error code, unlike `features/invitations/errors.ts`'s
// several distinct staff-facing codes — the two features have opposite
// transparency requirements by design.
export class ActivationError extends Error {
  readonly status = 409 as const;
  readonly code = 'ACTIVATION_NOT_POSSIBLE' as const;

  constructor() {
    super('This invitation link is no longer valid.');
    this.name = 'ActivationError';
  }
}
