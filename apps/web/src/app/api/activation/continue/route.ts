import { continueSchema } from '@/features/activation/schemas';
import { continueInvitation } from '@/features/activation/service';
import { jsonResponse, parseJsonBody, runActivationAction } from '@/features/activation/http';

export const runtime = 'nodejs';

// The explicit Continue transition (D-034 Section 5; D-037 Sections 3, 6)
// — unauthenticated, public. Origin enforcement, media-type/body-size
// gating, and rate limiting are Stage 5d (D-037 Section 17) and are not
// implemented by this route yet.
export async function POST(request: Request): Promise<Response> {
  const body = await parseJsonBody(request, continueSchema);
  if (!body.success) {
    return body.response;
  }

  return runActivationAction(
    () => continueInvitation(body.data.token),
    (result) => jsonResponse(result, 200),
  );
}
