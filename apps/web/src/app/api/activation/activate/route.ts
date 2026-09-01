import { hashPassword } from 'better-auth/crypto';

import { activateSchema } from '@/features/activation/schemas';
import { activateAccount } from '@/features/activation/service';
import {
  checkContentType,
  checkDeclaredContentLength,
  checkOrigin,
  jsonResponse,
  parseJsonBody,
  rateLimitedResponse,
  readBoundedBody,
  runActivationAction,
} from '@/features/activation/http';
import { checkSourceRateLimit, checkTokenRateLimit } from '@/features/activation/rate-limit';
import { resolveRequestSource } from '@/features/activation/source';
import { hashInvitationToken } from '@/features/invitations/token';

export const runtime = 'nodejs';

// The activation transition (D-034 Sections 5, 6; D-037 Sections 3, 8, 10,
// 11) — unauthenticated, public, single-use. Gate ordering follows D-037
// Section 10 exactly and must not be reordered: Origin -> Content-Type ->
// declared Content-Length -> SOURCE rate limit (before any body byte is
// read) -> bounded body read -> JSON/schema validation (password
// length/confirmation included, D-037 Section 10 step 9) -> TOKEN rate
// limit -> password hash (outside any transaction, D-037 Section 8 step
// (c)) -> service call.
export async function POST(request: Request): Promise<Response> {
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) return originCheck.response;

  const contentTypeCheck = checkContentType(request);
  if (!contentTypeCheck.ok) return contentTypeCheck.response;

  const lengthCheck = checkDeclaredContentLength(request);
  if (!lengthCheck.ok) return lengthCheck.response;

  const source = resolveRequestSource(request.headers, {});
  if (await checkSourceRateLimit(source)) {
    return rateLimitedResponse();
  }

  const bodyResult = await readBoundedBody(request);
  if (!bodyResult.ok) return bodyResult.response;

  const parsed = parseJsonBody(bodyResult.text, activateSchema);
  if (!parsed.success) return parsed.response;

  const tokenHash = hashInvitationToken(parsed.data.token);
  if (await checkTokenRateLimit(tokenHash)) {
    return rateLimitedResponse();
  }

  // D-037 Section 8 step (c) / Correction C: the deliberately slow
  // password hash is computed here, outside any database transaction,
  // before `activateAccount` opens its own `runSerializableWithRetry`
  // transaction — never inside it.
  const passwordHash = await hashPassword(parsed.data.password);

  return runActivationAction(
    () => activateAccount(parsed.data.token, passwordHash),
    (result) => jsonResponse(result, 200),
  );
}
