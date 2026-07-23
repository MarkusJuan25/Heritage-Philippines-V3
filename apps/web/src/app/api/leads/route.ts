import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { createLeadSchema, listLeadsQuerySchema } from '@/features/leads/schemas';
import { createLead, listLeads } from '@/features/leads/service';
import { parseJsonBody, parseQuery, runLeadAction } from '@/features/leads/http';

export const runtime = 'nodejs';

// Staff-only Lead listing and manual creation (D-022 §2/§8; blueprint
// Section 6.8). ADMIN_MANAGER has unconditional access; TRAVEL_CONSULTANT
// is further scoped, inside the service/repository layer, to Leads they
// are actively assigned to. Every other role (including CLIENT) is
// rejected here by `withRole` before either handler body runs.
export const GET = withRole(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'], async (request, { user }) => {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams, listLeadsQuerySchema);
  if (!query.success) {
    return query.response;
  }

  const result = await listLeads(user, query.data);
  return NextResponse.json(result);
});

// Creates a Lead (always status NEW). For a TRAVEL_CONSULTANT creator, the
// Lead is atomically self-assigned in the same transaction (D-022 §2) —
// see features/leads/service.ts's `createLead`. Always 201: unlike Booking,
// Lead creation has no idempotent-replay/200 case (no natural request-level
// dedup key).
export const POST = withRole(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'], async (request, { user }) => {
  const body = await parseJsonBody(request, createLeadSchema);
  if (!body.success) {
    return body.response;
  }

  return runLeadAction(
    () => createLead(user, body.data),
    ({ lead, duplicateMatches, restrictedMatchDetected }) =>
      NextResponse.json({ lead, duplicateMatches, restrictedMatchDetected }, { status: 201 }),
  );
});
