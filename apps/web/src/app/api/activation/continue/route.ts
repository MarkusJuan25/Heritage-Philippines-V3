import { continueSchema } from '@/features/activation/schemas';
import { continueInvitation } from '@/features/activation/service';
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

// The explicit Continue transition (D-034 Section 5; D-037 Sections 3, 6,
// 10, 11) — unauthenticated, public. Gate ordering follows D-037 Section
// 10 exactly and must not be reordered: Origin -> Content-Type -> declared
// Content-Length -> SOURCE rate limit (before any body byte is read) ->
// bounded body read -> JSON/schema validation -> TOKEN rate limit ->
// service call.
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

  const parsed = parseJsonBody(bodyResult.text, continueSchema);
  if (!parsed.success) return parsed.response;

  const tokenHash = hashInvitationToken(parsed.data.token);
  if (await checkTokenRateLimit(tokenHash)) {
    return rateLimitedResponse();
  }

  return runActivationAction(
    () => continueInvitation(parsed.data.token),
    (result) => jsonResponse(result, 200),
  );
}
