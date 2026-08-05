import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { createProposalSchema, listProposalsQuerySchema } from '@/features/proposals/schemas';
import { createProposal, listProposals } from '@/features/proposals/service';
import { parseJsonBody, parseQuery, runProposalAction } from '@/features/proposals/http';

export const runtime = 'nodejs';

// Paginated, actor-scoped Proposal list (D-027 §3/§6). `ADMIN_MANAGER` has
// unconditional access; `TRAVEL_CONSULTANT` is scoped, entirely inside
// `features/proposals/repository.ts`'s query itself, to Clients they
// actively hold an assignment for — never a per-row `canAccessClient`
// check here or in the service. Every other role is rejected by `withRole`
// before this handler body ever runs. Wrapped in `runProposalAction`, like
// every other handler in this feature, so `listProposals`'s own
// defense-in-depth `ROLE_NOT_PERMITTED` check (unreachable in normal
// operation since `withRole`'s gate already matches it, but still a real
// possible throw) is translated to its controlled envelope rather than
// falling through to `withRole`'s generic 500. Returns the service result
// unchanged — already exactly `{ items, page, pageSize, total }`, D-027
// §6's own response shape.
export const GET = withRole(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'], async (request, { user }) => {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams, listProposalsQuerySchema);
  if (!query.success) {
    return query.response;
  }

  return runProposalAction(
    () => listProposals(user, query.data),
    (result) => NextResponse.json(result),
  );
});

// Creates a Proposal and its first ProposalVersion (D-027 §2/§3/§6) —
// Travel-Consultant-only; `ADMIN_MANAGER` is rejected here by `withRole`
// itself, before the handler body ever runs, matching D-027 §3's
// asymmetric authoring rule. Not idempotent (D-027 §6) — every valid
// request creates a new Proposal. Returns the service result unchanged —
// already exactly `{ proposal, version }`, D-027 §6's own response shape.
export const POST = withRole(['TRAVEL_CONSULTANT'], async (request, { user }) => {
  const body = await parseJsonBody(request, createProposalSchema);
  if (!body.success) {
    return body.response;
  }

  return runProposalAction(
    () => createProposal(user, body.data),
    (result) => NextResponse.json(result, { status: 201 }),
  );
});
