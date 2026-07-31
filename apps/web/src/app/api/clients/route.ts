import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { listClientsQuerySchema } from '@/features/clients/schemas';
import { listClients } from '@/features/clients/service';
import { parseQuery } from '@/features/clients/http';

export const runtime = 'nodejs';

// Staff-only, paginated Client listing (D-025 §2/§3). `ADMIN_MANAGER` has
// unconditional access; `TRAVEL_CONSULTANT` is scoped, entirely inside
// `features/clients/repository.ts`'s query itself, to Clients they actively
// hold an assignment for — never a per-row `canAccessClient` check here or
// in the service. Every other role (including `CLIENT`) is rejected by
// `withRole` before this handler body ever runs. No `POST` handler exists on
// this route: direct Client creation is not authorized (D-025 §1) — Clients
// are created only through the existing, unchanged Lead-to-Client
// conversion workflow (`POST /api/leads/[id]/conversion`).
export const GET = withRole(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'], async (request, { user }) => {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams, listClientsQuerySchema);
  if (!query.success) {
    return query.response;
  }

  const result = await listClients(user, query.data);
  return NextResponse.json(result);
});
