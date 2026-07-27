import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { NewLeadForm } from './_components/NewLeadForm';

// Layer 3 of D-023 §2's defense-in-depth authorization — identical gate to
// /admin/leads and /admin/leads/[id]: independently re-resolves the
// authenticated user (never trusting app/admin/layout.tsx's own Layer 2
// check) and narrows the Lead surface to exactly the two roles D-022
// authorizes to manage Leads. This page never calls createLead or any
// repository itself (D-023 §9) — manual creation is a browser mutation
// through the existing POST /api/leads, performed entirely by the client
// NewLeadForm below.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

/**
 * Manual Lead creation (D-022 §2/§3; D-023 §4's `/admin/leads/new`).
 */
export default async function NewLeadPage() {
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
      <Link href="/admin/leads">← Back to Leads</Link>
      <h1>New Lead</h1>
      <NewLeadForm />
    </div>
  );
}
