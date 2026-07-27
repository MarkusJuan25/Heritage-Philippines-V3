import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import { STAFF_ROLES } from '@/lib/auth/roles';

import { SignOutButton } from '@/app/dashboard/sign-out-button';

// Layer 2 of D-023 §2's defense-in-depth authorization: independently
// resolves the real, database-backed authenticated user via the existing
// getCurrentUser() guard — never trusting proxy.ts's cookie-presence-only
// check (Layer 1). Permits the five staff roles into the shared /admin
// namespace and renders an in-place permission-denied state for a CLIENT
// session, per .claude/rules/frontend.md's distinct permission-denied
// UI-state rule, rather than a silent redirect. Each /admin/leads/** page
// still independently narrows further (Layer 3) — this layout is not a
// substitute for that.
export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, STAFF_ROLES);
  if (!access.authorized) {
    return (
      <main>
        <h1>Access denied</h1>
        <p>Your account does not have access to the Heritage Philippines admin dashboard.</p>
      </main>
    );
  }

  return (
    <div>
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <div>
          <strong>Heritage Philippines — Admin</strong>
          <p>
            {user.name} · {user.role}
          </p>
        </div>
        <nav aria-label="Admin navigation">
          <ul
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '1rem',
              listStyle: 'none',
              margin: 0,
              padding: 0,
            }}
          >
            <li>
              <Link href="/admin/leads">Leads</Link>
            </li>
          </ul>
        </nav>
        <SignOutButton />
      </header>
      <main>{children}</main>
    </div>
  );
}
