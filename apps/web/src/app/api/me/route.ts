import { NextResponse } from 'next/server';

import { withRole } from '@/lib/auth/guards';

export const runtime = 'nodejs';

// Minimal example of a role-guarded API route (Phase 1 verification
// surface, not a real feature endpoint): returns the caller's own identity
// and role. Any authenticated user may call it — it demonstrates
// `withRole` without adding a role restriction beyond "signed in".
export const GET = withRole(undefined, async (_request, { user }) => {
  return NextResponse.json({ user });
});
