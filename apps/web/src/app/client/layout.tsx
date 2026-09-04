import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';
import { getOwnClientForUser } from '@/features/clients/service';

import { SignOutButton } from '@/app/dashboard/sign-out-button';

import { ClientPortalNav } from './_components/ClientPortalNav';
import styles from './client.module.css';

// D-040 §8: the authenticated /client portal is never statically
// prerendered, ISR-cached, or full-route-cached — it is recomputed per
// request from the caller's own session. `next.config.ts`'s scoped
// `headers()` matcher additionally sets `Cache-Control: private, no-store`
// and `Referrer-Policy: no-referrer` for `/client/:path*`.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// D-040 §2, Layer 2 of the four-layer authorization model. This async
// Server Component independently resolves the real, database-backed
// authenticated user (never trusting proxy.ts's Layer-1 cookie-presence
// check) and gates the whole /client namespace:
//
//  - no session            -> redirect('/login')
//  - role !== 'CLIENT'      -> a single-<main> "Client area" panel; {children} NOT rendered
//  - CLIENT, Contract A null -> a single-<main> "Account setup in progress" panel;
//                              {children} NOT rendered (never reveals that no
//                              ClientProfile row exists — D-040 §7)
//  - CLIENT, Contract A ok  -> the portal chrome + the single <main> landmark
//                              wrapping {children} (page.tsx's Layer 3 composition)
//
// This layout owns the ONE <main> landmark for the whole namespace
// (D-040 §7). Its two known-state panels each render their own single
// <main> and stop; loading.tsx, error.tsx, page.tsx, and the _components
// render <div>/<section> only, never a nested <main>.
export default async function ClientLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  if (user.role !== 'CLIENT') {
    return (
      <main className={styles.panel}>
        <h1>Client area</h1>
        <p>This area is for Heritage Philippines client accounts.</p>
      </main>
    );
  }

  // D-040 §2/§3 Contract A: resolve the owned Client strictly from the
  // session identity. A `null` result is the "account not set up yet"
  // state — calm, generic, non-revealing.
  const owned = await getOwnClientForUser(user);
  if (!owned) {
    return (
      <main className={styles.panel}>
        <h1>Account setup in progress</h1>
        <p>
          Your client account isn&apos;t fully set up yet. Please contact your Heritage Philippines
          travel consultant for help completing your account setup.
        </p>
      </main>
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.chrome}>
        <p className={styles.brand}>Heritage Philippines</p>
        <ClientPortalNav />
        <SignOutButton />
      </header>
      <main>{children}</main>
    </div>
  );
}
