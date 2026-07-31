import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { clientIdParamSchema, updateClientSchema } from '@/features/clients/schemas';
import { getClientById, updateClient } from '@/features/clients/service';
import { parseJsonBody, runClientAction, validationErrorResponse } from '@/features/clients/http';

export const runtime = 'nodejs';

type RouteParams = { id: string };

// Staff-only single-Client retrieval (D-025 §2/§4). The service
// (`getClientById`) owns `canAccessClient` and the exact
// `ADMIN_MANAGER`-versus-`TRAVEL_CONSULTANT` anti-enumeration split
// (`CLIENT_NOT_FOUND` vs. `CLIENT_FORBIDDEN`) — never duplicated here. A
// malformed id is rejected before the service is ever called.
export const GET = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = clientIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    return runClientAction(
      () => getClientById(user, idResult.data.id),
      (client) => NextResponse.json({ client }),
    );
  },
);

// Edits a Client's ordinary fields (D-025 §5/§7). The id is validated before
// the request body is parsed or acted on. Duplicate-match fields
// (`duplicateMatches`/`restrictedMatchDetected`) are present in the response
// together only when the patch touched `email`/`phone` — see
// features/clients/service.ts's `updateClient`. No `PUT` or `DELETE`
// Client-resource handler exists on this route.
export const PATCH = withRole<RouteParams>(
  ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'],
  async (request, { user, params }) => {
    const idResult = clientIdParamSchema.safeParse(await params);
    if (!idResult.success) {
      return validationErrorResponse(idResult.error.issues);
    }

    const body = await parseJsonBody(request, updateClientSchema);
    if (!body.success) {
      return body.response;
    }

    return runClientAction(
      () => updateClient(user, idResult.data.id, body.data),
      ({ client, duplicateMatches, restrictedMatchDetected }) =>
        NextResponse.json(
          duplicateMatches !== undefined
            ? { client, duplicateMatches, restrictedMatchDetected }
            : { client },
        ),
    );
  },
);
