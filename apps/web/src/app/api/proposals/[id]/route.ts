import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { proposalIdParamSchema } from '@/features/proposals/schemas';
import { getProposalById } from '@/features/proposals/service';
import { runProposalAction, validationErrorResponse } from '@/features/proposals/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Actor-scoped single-Proposal detail read (D-027 §3/§6). The service
// (`getProposalById`) owns `canAccessClient` and the exact
// `ADMIN_MANAGER`-versus-`TRAVEL_CONSULTANT` anti-enumeration split
// (`PROPOSAL_NOT_FOUND` vs. `PROPOSAL_FORBIDDEN`) — never duplicated here,
// and returned to the HTTP layer unchanged by `runProposalAction`. A
// malformed id is rejected before the service is ever called.
//
// D-027 §6's response shape is `{ proposal, versions }` — two separate
// top-level keys — while `getProposalById` returns a single flat
// `ProposalDetailRecord` (`{ id, client, createdAt, updatedAt, versions }`,
// features/proposals/repository.ts). This handler performs the one thin,
// required reshape D-027 §6 itself demands: `versions` is split out, and
// the remaining identity fields (`id`, `client`, `createdAt`, `updatedAt`)
// become the `proposal` object — never any other transformation, and never
// a reshape merely invented by this route.
export const GET = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = proposalIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    return runProposalAction(
      () => getProposalById(user, idResult.data.id),
      ({ versions, ...proposal }) => NextResponse.json({ proposal, versions }),
    );
  },
);
