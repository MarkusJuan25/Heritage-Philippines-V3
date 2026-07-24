import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

// Layer 3 of D-023 §2's defense-in-depth authorization: independently
// re-resolves the authenticated user (never trusting app/admin/layout.tsx's
// own check, Layer 2) and narrows the Lead surface to exactly the two
// roles D-022 authorizes to manage Leads. Every other staff role — and
// CLIENT, though the layout above already excludes it before this page
// ever renders — receives an in-place permission-denied state here too,
// consistent with this checkpoint's defense-in-depth discipline.
//
// This is a minimal Stage 1 scaffold only: Lead listing, filters,
// pagination, creation, detail, editing, status transitions, assignment,
// and status history are all later, separately authorized stages.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

export default async function AdminLeadsPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, ALLOWED_ROLES);
  if (!access.authorized) {
    return (
      <div>
        <h1>Access denied</h1>
        <p>Only Admin/Manager and Travel Consultant staff can access Lead management.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Leads</h1>
      <p>Lead management for Heritage Philippines V3 will be built here.</p>
    </div>
  );
}
