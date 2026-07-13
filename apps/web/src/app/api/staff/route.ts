import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

import { createStaffAccountSchema, listStaffAccountsQuerySchema } from '@/features/staff/schemas';
import { createStaffAccount, listStaffAccounts } from '@/features/staff/service';
import { parseJsonBody, parseQuery, runStaffAction } from '@/features/staff/http';

export const runtime = 'nodejs';

// Staff account listing and creation (blueprint Section 4.1: "Create...
// platform user accounts"). System Administrator only — see
// docs/HERITAGE_V3_DECISIONS_LOG.md D-012 and the schema invariants in
// apps/web/prisma/schema.prisma.
export const GET = withRole(['SYSTEM_ADMINISTRATOR'], async (request) => {
  const url = new URL(request.url);
  const query = parseQuery(url.searchParams, listStaffAccountsQuerySchema);
  if (!query.success) {
    return query.response;
  }

  const result = await listStaffAccounts(query.data);
  return NextResponse.json(result);
});

export const POST = withRole(['SYSTEM_ADMINISTRATOR'], async (request, { user }) => {
  const body = await parseJsonBody(request, createStaffAccountSchema);
  if (!body.success) {
    return body.response;
  }

  return runStaffAction(
    () => createStaffAccount(user, body.data),
    (result) => NextResponse.json(result, { status: 201 }),
  );
});
