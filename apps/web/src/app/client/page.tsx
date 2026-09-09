import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/guards';
import { ClientPortalError } from '@/features/client-portal/errors';
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
// `PROFILE_NOT_SET_UP`). In the normal flow layout.tsx (Layer 2) has
// already gated both and rendered the matching known-state panel without
// `{children}`, so that panel — not anything here — is the committed,
// user-visible output. This component still executes alongside the layout
// during the App Router render, though (D-045 §2; see
// `e2e/client-overview.spec.ts`), and `getClientOverview` throws that same
// known state here. It is caught for exactly those two `code` values and
// `null` is returned — the page renders nothing and adds no data path — so
// the known state does not escape this component into the renderer /
// server error log. Every other value rethrows unchanged: a
// non-`ClientPortalError`, any genuinely unexpected failure, and any other
// `ClientPortalError` `code` all reject this component and bubble to
// `error.tsx`, exactly as `admin/leads/[id]/page.tsx` and
// `admin/clients/[id]/page.tsx` bubble theirs. `redirect('/login')` throws
// a Next.js navigation signal before the call and is never in scope of the
// catch. The rendered DTO is the identifier-minimized `ClientOverview`
// (D-040 §8) — no internal id, proposal content, notes, money, currency,
// traveler count, or invitation data is present in it.
export default async function ClientOverviewPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  let overview;
  try {
    overview = await getClientOverview(user);
  } catch (error) {
    if (
      error instanceof ClientPortalError &&
      (error.code === 'FORBIDDEN' || error.code === 'PROFILE_NOT_SET_UP')
    ) {
      return null;
    }
    throw error;
  }

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
