import { hashPassword } from 'better-auth/crypto';

import { activateSchema } from '@/features/activation/schemas';
import { activateAccount } from '@/features/activation/service';
import { jsonResponse, parseJsonBody, runActivationAction } from '@/features/activation/http';

export const runtime = 'nodejs';

// The activation transition (D-034 Sections 5, 6; D-037 Sections 3, 8) —
// unauthenticated, public, single-use. Origin enforcement, media-type/
// body-size gating, and rate limiting are Stage 5d (D-037 Section 17) and
// are not implemented by this route yet.
export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, activateSchema);
  if (!body.success) {
    return body.response;
  }

  // D-037 Section 8 step (c) / Correction C: the deliberately slow
  // password hash is computed here, outside any database transaction,
  // before `activateAccount` opens its own `runSerializableWithRetry`
  // transaction — never inside it.
  const passwordHash = await hashPassword(body.data.password);

  return runActivationAction(
    () => activateAccount(body.data.token, passwordHash),
    (result) => jsonResponse(result, 200),
  );
}
