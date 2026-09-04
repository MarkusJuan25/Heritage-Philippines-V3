import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';
import { getClientOverview } from '@/features/client-portal/service';

import { BookingSummarySection } from './_components/BookingSummarySection';
import { ConsultantCard } from './_components/ConsultantCard';
import { IdentityCard } from './_components/IdentityCard';
import { ProposalSummarySection } from './_components/ProposalSummarySection';
import { TravelStatusSection } from './_components/TravelStatusSection';
import styles from './client.module.css';

// D-040 §8: recomputed per request from the caller's own session; never
// statically prerendered or full-route-cached.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// D-040 §2, Layer 3. A pure async Server Component: no 'use client', no
// form, button, or mutation control anywhere in this file. It takes NO
// props — no dynamic segment, no `searchParams`, no caller-controlled
// object of any kind — so a client identifier can never be read from the
// request path, query, body, or a prop. It resolves the authenticated
// actor through `getCurrentUser()` alone and calls the compose-only
// `getClientOverview(actor)` entry point directly (never a repository,
// never Prisma, never an internal `fetch` to an API route). The owned
// `clientId` is derived inside that service exclusively from the session
// identity (Contract A).
//
// `getClientOverview` can throw `ClientPortalError` (`FORBIDDEN` /
// `PROFILE_NOT_SET_UP`), but in the normal flow layout.tsx (Layer 2) has
// already gated both, so neither reaches here; any genuinely unexpected
// failure is intentionally not caught — it rejects this component and
// bubbles to `error.tsx`, exactly as `admin/page.tsx` lets its service
// calls bubble. The rendered DTO is the identifier-minimized
// `ClientOverview` (D-040 §8) — no internal id, proposal content, notes,
// money, currency, traveler count, or invitation data is present in it.
export default async function ClientOverviewPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const overview = await getClientOverview(user);

  return (
    <div className={styles.overview}>
      <h1 className={styles.pageHeading}>Home / Overview</h1>

      <IdentityCard identity={overview.identity} />

      <div className={styles.sections}>
        <ProposalSummarySection proposals={overview.proposals} />
        <BookingSummarySection bookings={overview.bookings} />
        <TravelStatusSection travelStatus={overview.travelStatus} />
      </div>

      <ConsultantCard consultant={overview.consultant} />
    </div>
  );
}
