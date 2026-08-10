import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';

import { SignOutButton } from './sign-out-button';

// Phase 1 verification surface only — proves login/session/role plumbing
// works end-to-end. This is NOT the admin dashboard or client portal
// (blueprint Sections 2.2/2.3); those are later-phase, role-specific
// features built on top of this foundation.
//
// D-029 §2 (Correction 1): this page is the sole role-aware post-login
// fork. `ADMIN_MANAGER`/`TRAVEL_CONSULTANT` are redirected on to `/admin`
// (the Dashboard Overview) below — closing D-023 §3's previously-accepted
// but never-implemented post-login routing requirement, retargeted from
// its original `/admin/leads` destination to the now-available `/admin`.
// Every other authenticated role retains the Phase-1 verification content
// below, unchanged. `redirect()` is called outside any try/catch — it
// works by throwing a Next.js control-flow signal that a surrounding
// catch would otherwise intercept and treat as an application error.
export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  if (user.role === 'ADMIN_MANAGER' || user.role === 'TRAVEL_CONSULTANT') {
    redirect('/admin');
  }

  return (
    <main>
      <h1>Signed in</h1>
      <dl>
        <dt>Name</dt>
        <dd>{user.name}</dd>
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
      </dl>
      <SignOutButton />
    </main>
  );
}
