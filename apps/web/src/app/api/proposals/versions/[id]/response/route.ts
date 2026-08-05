import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import {
  proposalVersionIdParamSchema,
  recordProposalResponseSchema,
} from '@/features/proposals/schemas';
import { recordProposalResponse } from '@/features/proposals/service';
import {
  parseJsonBody,
  runProposalAction,
  validationErrorResponse,
} from '@/features/proposals/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Records a Section 9.1 externally received Accept/Decline/Request
// Changes response (D-027 §3/§4/§7/§9.1) — `ADMIN_MANAGER` and
// `TRAVEL_CONSULTANT` both allowed; every other role is rejected by
// `withRole` before the handler body ever runs. The version id is
// validated before the request body is parsed. `recordProposalResponse`
// owns D-027 §7's exact existing-response-then-current-version check
// ordering and returns the created `ProposalAcceptanceRecord` directly
// (unwrapped); this handler performs the one `{ acceptance }` wrap D-027
// §6's response shape requires — `200`, exactly as D-027 §6 states
// (`→ 200 { acceptance }`), not `201`: this endpoint records a response
// against an existing ProposalVersion rather than creating a new primary
// resource of its own, and D-027 §6 is this checkpoint's authoritative,
// self-contained contract for every endpoint's response shape and status.
export const POST = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = proposalVersionIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, recordProposalResponseSchema);
    if (!body.success) {
      return body.response;
    }

    return runProposalAction(
      () => recordProposalResponse(user, idResult.data.id, body.data),
      (acceptance) => NextResponse.json({ acceptance }),
    );
  },
);
