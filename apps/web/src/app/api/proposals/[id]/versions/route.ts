import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { createProposalRevisionSchema, proposalIdParamSchema } from '@/features/proposals/schemas';
import { createProposalRevision } from '@/features/proposals/service';
import {
  parseJsonBody,
  runProposalAction,
  validationErrorResponse,
} from '@/features/proposals/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Creates a new ProposalVersion (revision) for an existing Proposal
// (D-027 §2/§3/§6) — Travel-Consultant-only; `ADMIN_MANAGER` is rejected
// here by `withRole` itself, before the handler body ever runs. Not
// idempotent (D-027 §6) — multiple coexisting unpublished drafts are
// permitted. The Proposal id is validated before the request body is
// parsed or acted on. `createProposalRevision` returns the created
// `ProposalVersionRecord` directly (unwrapped); D-027 §6's response shape
// is `{ version }`, so this handler wraps it — the one thin reshape the
// accepted contract requires, never anything further.
export const POST = withRole<RouteParams>(
  ['TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = proposalIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, createProposalRevisionSchema);
    if (!body.success) {
      return body.response;
    }

    return runProposalAction(
      () => createProposalRevision(user, idResult.data.id, body.data),
      (version) => NextResponse.json({ version }, { status: 201 }),
    );
  },
);
