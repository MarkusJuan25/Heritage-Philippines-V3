import { z } from 'zod';

// The exact raw-token shape `features/invitations/token.ts`'s
// `generateInvitationToken` produces (D-037 Section 4): 24 characters over
// `a-z`,`A-Z`,`0-9`,`-`,`_`. Validated before any digest/lookup is
// attempted, so a malformed value never reaches the database — mirrors
// `.claude/rules/backend.md`'s boundary-validation rule.
export const activationTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{24}$/, 'token must be exactly 24 characters');

export const continueSchema = z.object({
  token: activationTokenSchema,
});
export type ContinueInput = z.infer<typeof continueSchema>;

// D-037 Section 3: password length/confirmation validation is the one
// activation failure mode that is safe to report specifically (it never
// leaks anything about the invitation's existence or state) — the exact
// three messages D-037 approved, never an abbreviated or ellipsis-shaped
// placeholder.
export const activateSchema = z
  .object({
    token: activationTokenSchema,
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters.')
      .max(200, 'Password must not exceed 200 characters.'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });
export type ActivateInput = z.infer<typeof activateSchema>;
