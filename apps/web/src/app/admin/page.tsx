import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { LeadStatus } from '@/generated/prisma/client';
import type { BookingStatus } from '@/generated/prisma/client';
import { listLeads } from '@/features/leads/service';
import { listClients } from '@/features/clients/service';
import { listProposals } from '@/features/proposals/service';
import { listBookings } from '@/features/bookings/service';

import { LEAD_STATUS_LABELS } from '@/app/admin/leads/_components/leadStatusLabels';

import styles from './dashboard.module.css';

// D-029 §3: exactly ADMIN_MANAGER and TRAVEL_CONSULTANT may view /admin —
// mirrors D-022 through D-028's identical Layer 3 `ALLOWED_ROLES` pattern,
// present in this exact form on admin/leads/page.tsx, admin/clients/page.tsx,
// admin/proposals/page.tsx, and admin/bookings/page.tsx.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

// Duplicated from admin/bookings/_components/BookingTable.tsx rather than
// imported/shared — mirrors this codebase's established per-feature-copy
// convention for this specific label map (unlike `LEAD_STATUS_LABELS`
// below, which that feature already exports for reuse). Never inventing a
// status the schema doesn't define (.claude/rules/admin-dashboard.md).
const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  DRAFT: 'Draft',
  PENDING_CONFIRMATION: 'Pending Confirmation',
  CONFIRMED: 'Confirmed',
  IN_PREPARATION: 'In Preparation',
  DOCUMENTS_REQUIRED: 'Documents Required',
  VISA_PROCESSING: 'Visa Processing',
  READY_FOR_TRAVEL: 'Ready for Travel',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** `createdAt` rendered exactly as every existing list table already
 * renders it (`LeadTable.tsx`, `ClientTable.tsx`, `ProposalTable.tsx`,
 * `BookingTable.tsx`'s identical convention): the full ISO timestamp in
 * `dateTime`, a date-only `en-PH` string as the visible text. */
function RecentItemDate({ date }: { date: Date }) {
  return <time dateTime={date.toISOString()}>{date.toLocaleDateString('en-PH')}</time>;
}

/**
 * Admin Dashboard Overview (D-029 §2-§11's `/admin`, Stage 2B). A pure
 * async Server Component — no `'use client'` directive, no form, button,
 * or other mutation control anywhere in this file. Authenticates the
 * actor, applies the exact Layer 3 `ALLOWED_ROLES` gate (D-029 §3), and —
 * only once that succeeds — calls `listLeads`, `listClients`,
 * `listProposals`, and `listBookings` directly, exactly as every other
 * Phase 2 list page already calls its own feature's service: never a
 * repository, never an internal `fetch` to an API route, no dashboard-
 * owned data-access module of any kind (D-029 §8).
 *
 * Exactly five service calls, inside one outer `Promise.all` (D-029 §6/§8):
 * two `listLeads` calls (a status-filtered `pageSize: 1` call for the
 * "New inquiries" metric, and a separate unfiltered `pageSize: 5` call for
 * "Recent Leads" — deliberately never combined, since a `0` New-inquiries
 * count must never be read as, or hide, a non-empty Recent Leads list),
 * and one `pageSize: 5` call each for Clients/Proposals/Bookings, each
 * call's single result reused for both that feature's metric (`.total`)
 * and its recent-item list (`.items`). No sixth call, no additional query
 * parameter, and no post-fetch sorting, filtering, or slicing of any kind.
 * Any one of the five calls rejecting (including an unexpected,
 * non-`ROLE_NOT_PERMITTED` failure) is intentionally not caught here — it
 * rejects this whole component and bubbles to this route segment's
 * nearest error boundary, exactly mirroring `admin/bookings/page.tsx`'s/
 * `admin/proposals/page.tsx`'s identical single-source convention,
 * extended here to five sources with fail-together `Promise.all`
 * semantics (D-029 §9) — never a partially-rendered dashboard.
 *
 * Renders exactly four sections, in order — Leads, Clients, Proposals,
 * Bookings — each a semantic `<section>` with its own heading, a labelled
 * `<dl>/<dt>/<dd>` metric that always renders its numeric value including
 * `0`, a "Recent {Feature}" heading, either a bounded (at most 5 items)
 * semantic list or that call's own exact empty-state message (decided
 * solely by that call's own `items.length`, never a different feature's
 * or a different call's total), and one "View all …" link to that
 * feature's existing list page (D-029 §5/§7). Every recent-item field
 * rendered is drawn only from the existing DTO shapes these four services
 * already return — no additional contact, notes, assignment, proposal-
 * content, or internal Booking field is ever exposed here (D-029 §6).
 */
export default async function AdminDashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, ALLOWED_ROLES);
  if (!access.authorized) {
    return (
      <div>
        <h1>Access denied</h1>
        <p>Only Admin/Manager and Travel Consultant staff can access the admin dashboard.</p>
      </div>
    );
  }

  const [newInquiries, recentLeads, clientsResult, proposalsResult, bookingsResult] =
    await Promise.all([
      listLeads(user, { status: LeadStatus.NEW, page: 1, pageSize: 1 }),
      listLeads(user, { page: 1, pageSize: 5 }),
      listClients(user, { page: 1, pageSize: 5 }),
      listProposals(user, { page: 1, pageSize: 5 }),
      listBookings(user, { page: 1, pageSize: 5 }),
    ]);

  return (
    <div>
      <h1 className={styles.heading}>Dashboard overview</h1>

      <div className={styles.sections}>
        <section className={styles.section}>
          <h2>Leads</h2>
          <dl className={styles.metric}>
            <dt>New inquiries</dt>
            <dd>{newInquiries.total}</dd>
          </dl>
          <h3 className={styles.recentHeading}>Recent Leads</h3>
          {recentLeads.items.length === 0 ? (
            <p className={styles.emptyState}>
              No leads yet. Leads created by staff will appear here.
            </p>
          ) : (
            <ul className={styles.recentList}>
              {recentLeads.items.map((lead) => (
                <li key={lead.id} className={styles.recentItem}>
                  <Link href={`/admin/leads/${lead.id}`}>{lead.fullName}</Link>
                  <span className={styles.recentItemMeta}>{LEAD_STATUS_LABELS[lead.status]}</span>
                  <RecentItemDate date={lead.createdAt} />
                </li>
              ))}
            </ul>
          )}
          <Link className={styles.viewAllLink} href="/admin/leads">
            View all leads
          </Link>
        </section>

        <section className={styles.section}>
          <h2>Clients</h2>
          <dl className={styles.metric}>
            <dt>Total Clients</dt>
            <dd>{clientsResult.total}</dd>
          </dl>
          <h3 className={styles.recentHeading}>Recent Clients</h3>
          {clientsResult.items.length === 0 ? (
            <p className={styles.emptyState}>
              No clients yet. Clients created through lead conversion will appear here.
            </p>
          ) : (
            <ul className={styles.recentList}>
              {clientsResult.items.map((client) => (
                <li key={client.id} className={styles.recentItem}>
                  <Link href={`/admin/clients/${client.id}`}>{client.fullName}</Link>
                  <RecentItemDate date={client.createdAt} />
                </li>
              ))}
            </ul>
          )}
          <Link className={styles.viewAllLink} href="/admin/clients">
            View all clients
          </Link>
        </section>

        <section className={styles.section}>
          <h2>Proposals</h2>
          <dl className={styles.metric}>
            <dt>Total Proposals</dt>
            <dd>{proposalsResult.total}</dd>
          </dl>
          <h3 className={styles.recentHeading}>Recent Proposals</h3>
          {proposalsResult.items.length === 0 ? (
            <p className={styles.emptyState}>No proposals yet.</p>
          ) : (
            <ul className={styles.recentList}>
              {proposalsResult.items.map((proposal) => (
                <li key={proposal.id} className={styles.recentItem}>
                  <Link href={`/admin/proposals/${proposal.id}`}>
                    Proposal for {proposal.client.fullName}
                  </Link>
                  <RecentItemDate date={proposal.createdAt} />
                </li>
              ))}
            </ul>
          )}
          <Link className={styles.viewAllLink} href="/admin/proposals">
            View all proposals
          </Link>
        </section>

        <section className={styles.section}>
          <h2>Bookings</h2>
          <dl className={styles.metric}>
            <dt>Total Bookings</dt>
            <dd>{bookingsResult.total}</dd>
          </dl>
          <h3 className={styles.recentHeading}>Recent Bookings</h3>
          {bookingsResult.items.length === 0 ? (
            <p className={styles.emptyState}>No bookings yet.</p>
          ) : (
            <ul className={styles.recentList}>
              {bookingsResult.items.map((booking) => (
                <li key={booking.id} className={styles.recentItem}>
                  <Link href={`/admin/bookings/${booking.id}`}>{booking.bookingReference}</Link>
                  <span className={styles.recentItemMeta}>
                    {BOOKING_STATUS_LABELS[booking.status]}
                  </span>
                  <RecentItemDate date={booking.createdAt} />
                </li>
              ))}
            </ul>
          )}
          <Link className={styles.viewAllLink} href="/admin/bookings">
            View all bookings
          </Link>
        </section>
      </div>
    </div>
  );
}
