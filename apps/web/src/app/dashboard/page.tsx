import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';

import { SignOutButton } from './sign-out-button';

// Phase 1 verification surface only — proves login/session/role plumbing
// works end-to-end. This is NOT the admin dashboard or client portal
// (blueprint Sections 2.2/2.3); those are later-phase, role-specific
// features built on top of this foundation.
export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
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
