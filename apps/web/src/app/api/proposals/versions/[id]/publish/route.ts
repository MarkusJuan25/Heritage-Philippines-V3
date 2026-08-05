import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import {
  proposalVersionIdParamSchema,
  publishProposalVersionSchema,
} from '@/features/proposals/schemas';
import { publishProposalVersion } from '@/features/proposals/service';
import {
  parseJsonBody,
  runProposalAction,
  validationErrorResponse,
} from '@/features/proposals/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Publishes a ProposalVersion (D-027 §3/§5) — Travel-Consultant-only;
// `ADMIN_MANAGER` is rejected here by `withRole` itself, before the
// handler body ever runs. The version id is validated before the request
// body is parsed. `publishProposalVersion` owns D-027 §5's exact idempotent/
// superseded/optimistic-concurrency check ordering and returns a single
// stable `ProposalVersionActorContext` on both the idempotent and
// successful paths — this handler performs no lifecycle logic of its own,
// only the `{ version }` wrap D-027 §6's response shape requires.
export const POST = withRole<RouteParams>(
  ['TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = proposalVersionIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, publishProposalVersionSchema);
    if (!body.success) {
      return body.response;
    }

    return runProposalAction(
      () => publishProposalVersion(user, idResult.data.id, body.data),
      (version) => NextResponse.json({ version }),
    );
  },
);
