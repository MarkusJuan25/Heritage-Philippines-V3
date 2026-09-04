import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';

import { SignOutButton } from './sign-out-button';

// Phase 1 verification surface only — proves login/session/role plumbing
// works end-to-end. This is NOT the admin dashboard or client portal
// (blueprint Sections 2.2/2.3); those are later-phase, role-specific
// features built on top of this foundation.
//
// D-029 §2 (Correction 1) and D-040 §2: this page is the sole role-aware
// post-login fork. `ADMIN_MANAGER`/`TRAVEL_CONSULTANT` are redirected on to
// `/admin` (the Dashboard Overview); `CLIENT` is redirected on to `/client`
// (the Client Home / Overview — D-040 §2). The three remaining non-staff
// roles — `SYSTEM_ADMINISTRATOR`, `FINANCE_ACCOUNTING`,
// `VISA_DOCUMENTATION` — retain the Phase-1 "Signed in" verification
// content below, unchanged. Each `redirect()` is called outside any
// try/catch — it works by throwing a Next.js control-flow signal that a
// surrounding catch would otherwise intercept and treat as an application
// error.
export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  if (user.role === 'ADMIN_MANAGER' || user.role === 'TRAVEL_CONSULTANT') {
    redirect('/admin');
  }

  if (user.role === 'CLIENT') {
    redirect('/client');
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
