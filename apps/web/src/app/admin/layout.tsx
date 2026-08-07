import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';
import { STAFF_ROLES } from '@/lib/auth/roles';

import { SignOutButton } from '@/app/dashboard/sign-out-button';

// D-025 §2's Client-management role boundary, applied to navigation
// visibility itself: unlike the existing Leads link (shown to every staff
// role, relying on that page's own Layer 3 check to deny an excluded role),
// the Clients link must not even be exposed to a role D-025 never
// authorizes for Client management.
const CLIENT_MANAGEMENT_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

// D-027 §8's Proposal navigation visibility rule: "the same
// ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'] role set already used for the
// existing 'Clients' link" — kept as this feature's own copy rather than
// reusing CLIENT_MANAGEMENT_ROLES, matching this codebase's established
// per-feature-constant discipline.
const PROPOSAL_MANAGEMENT_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

// D-028 §3's Booking navigation visibility rule: the same
// ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'] role set as Clients/Proposals,
// kept as this feature's own dedicated constant rather than reusing either
// of the above, matching this codebase's established per-feature-constant
// discipline.
const BOOKING_MANAGEMENT_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

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
            {CLIENT_MANAGEMENT_ROLES.includes(user.role) ? (
              <li>
                <Link href="/admin/clients">Clients</Link>
              </li>
            ) : null}
            {PROPOSAL_MANAGEMENT_ROLES.includes(user.role) ? (
              <li>
                <Link href="/admin/proposals">Proposals</Link>
              </li>
            ) : null}
            {BOOKING_MANAGEMENT_ROLES.includes(user.role) ? (
              <li>
                <Link href="/admin/bookings">Bookings</Link>
              </li>
            ) : null}
          </ul>
        </nav>
        <SignOutButton />
      </header>
      <main>{children}</main>
    </div>
  );
}
