import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { LeadError } from '@/features/leads/errors';
import { leadIdParamSchema, listLeadStatusHistoryQuerySchema } from '@/features/leads/schemas';
import { getConversionOptions, getLeadById, getLeadStatusHistory } from '@/features/leads/service';
import { getTransitionOutcome, isReasonRequired } from '@/features/leads/transitions';

import { LEAD_STATUS_VALUES } from '../_components/leadStatusLabels';
import { LeadStatusBadge } from '../_components/LeadStatusBadge';
import { Pagination } from '../_components/Pagination';
import { StatusHistoryTimeline } from '../_components/StatusHistoryTimeline';
import styles from '../leads.module.css';
import { ConvertToClientPanel } from './_components/ConvertToClientPanel';
import { EditLeadForm } from './_components/EditLeadForm';
import { StatusTransitionPanel } from './_components/StatusTransitionPanel';

// Layer 3 of D-023 §2's defense-in-depth authorization — identical to
// /admin/leads's own gate, independently re-checked here (never trusting
// app/admin/layout.tsx's Layer 2, and never trusting the list page either).
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

type PageParams = Promise<{ id: string }>;
type PageSearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/**
 * Lead detail (D-023 §4's `/admin/leads/[id]`): read-only summary fields,
 * status history, ordinary-field editing (`EditLeadForm`), and lifecycle
 * status-transition controls (`StatusTransitionPanel`). Assignment
 * management remains a separate, later stage — this page still has no
 * assignment-change controls. Calls `getLeadById` and
 * `getLeadStatusHistory` (application services, never repositories)
 * directly, per D-023 §9. `LEAD_NOT_FOUND`/`LEAD_FORBIDDEN` are handled
 * explicitly inline, preserving D-022 §8's anti-enumeration property
 * exactly as the service layer already shapes it — this page never adds
 * its own logic to distinguish "missing" from "inaccessible" beyond what
 * `getLeadById` itself returns. Any other error bubbles to this route
 * segment's `error.tsx` boundary. Both `EditLeadForm` and
 * `StatusTransitionPanel` call the existing, unchanged `PATCH
 * /api/leads/[id]` and `PUT /api/leads/[id]/status` routes directly from
 * the browser — this page performs no internal server-side HTTP fetch.
 */
export default async function AdminLeadDetailPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: PageSearchParams;
}) {
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

  const idResult = leadIdParamSchema.safeParse(await params);
  if (!idResult.success) {
    return (
      <div>
        <h1>Lead not found</h1>
        <p>This lead link is invalid.</p>
        <Link href="/admin/leads">Back to Leads</Link>
      </div>
    );
  }

  const leadId = idResult.data.id;

  let lead;
  try {
    lead = await getLeadById(user, leadId);
  } catch (error) {
    if (
      error instanceof LeadError &&
      (error.code === 'LEAD_NOT_FOUND' || error.code === 'LEAD_FORBIDDEN')
    ) {
      return (
        <div>
          <h1>Lead not found</h1>
          <p>This lead was not found or is not accessible to you.</p>
          <Link href="/admin/leads">Back to Leads</Link>
        </div>
      );
    }
    throw error;
  }

  const rawSearchParams = await searchParams;
  const historyQueryResult = listLeadStatusHistoryQuerySchema.safeParse(rawSearchParams);
  // Falls back to defaults rather than blocking the whole page on an
  // invalid secondary pagination param — the primary Lead detail above
  // already rendered successfully.
  const historyQuery = historyQueryResult.success
    ? historyQueryResult.data
    : { page: 1, pageSize: 20 };
  const history = await getLeadStatusHistory(user, leadId, historyQuery);

  function buildHistoryHref(targetPage: number): string {
    const params = new URLSearchParams();
    params.set('page', String(targetPage));
    params.set('pageSize', String(history.pageSize));
    return `/admin/leads/${leadId}?${params.toString()}`;
  }

  // Stage 3 correction (Finding 2): a status-history page beyond the last
  // valid page for a genuinely non-empty history must redirect there,
  // preserving pageSize, rather than rendering a false "no status
  // history" empty state or an impossible "Page N of M". `total === 0` is
  // excluded so a Lead with no history rows at all still renders the real
  // empty state. `lastValidHistoryPage` depends only on
  // `history.total`/`history.pageSize` (never the requested page), so the
  // corrected page always satisfies `page <= lastValidHistoryPage` on the
  // very next request — this cannot loop.
  const lastValidHistoryPage = Math.max(1, Math.ceil(history.total / history.pageSize));
  if (history.total > 0 && history.page > lastValidHistoryPage) {
    redirect(buildHistoryHref(lastValidHistoryPage));
  }

  // Server-computed status-transition options (D-022 §6; D-023 §4) — the
  // real, authoritative features/leads/transitions.ts matrix decides
  // exactly what StatusTransitionPanel is allowed to offer. The current
  // status and CONVERTED_TO_CLIENT are both excluded explicitly: the
  // ALLOWED-only filter below already excludes CONVERTED_TO_CLIENT on its
  // own (it is reachable only as DEFERRED_TO_CONVERSION_ENDPOINT from
  // QUALIFIED, never ALLOWED), but naming it here documents the exclusion
  // rather than relying on that as an implicit side effect.
  const statusOptions = LEAD_STATUS_VALUES.filter(
    (candidate) => candidate !== lead.status && candidate !== 'CONVERTED_TO_CLIENT',
  )
    .filter((candidate) => getTransitionOutcome(lead.status, candidate) === 'ALLOWED')
    .map((candidate) => ({
      status: candidate,
      reasonRequired: isReasonRequired(lead.status, candidate),
    }));

  // D-024 §10: the conversion-options read — and the panel it powers — are
  // authorized, called, and rendered only for a QUALIFIED Lead, never for
  // any other status, including CONVERTED_TO_CLIENT (which continues to
  // show only the existing locked/no-transitions state above). Only the
  // client-safe fields getConversionOptions itself already returns
  // (accessible candidates' id/fullName/matched channels, plus
  // restrictedMatchDetected) are ever passed to the client component.
  const conversionOptions =
    lead.status === 'QUALIFIED' ? await getConversionOptions(user, leadId) : null;

  return (
    <div>
      <Link href="/admin/leads">← Back to Leads</Link>
      <h1>{lead.fullName}</h1>
      <LeadStatusBadge status={lead.status} />

      <StatusTransitionPanel leadId={leadId} currentStatus={lead.status} options={statusOptions} />

      {conversionOptions ? (
        <ConvertToClientPanel
          leadId={leadId}
          accessibleMatches={conversionOptions.accessibleMatches}
          restrictedMatchDetected={conversionOptions.restrictedMatchDetected}
        />
      ) : null}

      <dl className={styles.detailFields}>
        <div className={styles.detailField}>
          <dt>Assigned Consultant</dt>
          <dd>{lead.assignment ? lead.assignment.staffName : 'Unassigned'}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Created</dt>
          <dd>
            <time dateTime={lead.createdAt.toISOString()}>
              {lead.createdAt.toLocaleString('en-PH')}
            </time>
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={lead.updatedAt.toISOString()}>
              {lead.updatedAt.toLocaleString('en-PH')}
            </time>
          </dd>
        </div>
      </dl>

      <h2>Edit Lead</h2>
      <EditLeadForm
        leadId={leadId}
        initialFullName={lead.fullName}
        initialSource={lead.source}
        initialEmail={lead.email}
        initialPhone={lead.phone}
        initialNotes={lead.notes}
        initiallyLocked={lead.status === 'CONVERTED_TO_CLIENT'}
      />

      <h2>Status History</h2>
      <StatusHistoryTimeline items={history.items} />
      <Pagination
        page={history.page}
        pageSize={history.pageSize}
        total={history.total}
        buildHref={buildHistoryHref}
      />
    </div>
  );
}
