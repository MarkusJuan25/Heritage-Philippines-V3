import Link from 'next/link';
import { redirect } from 'next/navigation';

import { authorize } from '@/lib/auth/authorize';
import { getCurrentUser } from '@/lib/auth/guards';
import type { AppRole } from '@/lib/auth/roles';

import { ProposalError } from '@/features/proposals/errors';
import { proposalIdParamSchema } from '@/features/proposals/schemas';
import { getProposalById } from '@/features/proposals/service';

import styles from '../proposals.module.css';
import { CreateProposalRevisionPanel } from './_components/CreateProposalRevisionPanel';
import { ProposalVersionHistory } from './_components/ProposalVersionHistory';

// D-027 §3/§8: exactly ADMIN_MANAGER and TRAVEL_CONSULTANT may read a
// Proposal's detail — mirrors admin/clients/[id]/page.tsx's identical
// Layer 3 role-gate pattern exactly.
const ALLOWED_ROLES: readonly AppRole[] = ['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'];

type PageParams = Promise<{ id: string }>;

/**
 * Proposal detail (D-027 §8's `/admin/proposals/[id]`). A Server Component
 * that authenticates the actor, validates the route `id` through
 * `proposalIdParamSchema`, and calls the `getProposalById` application
 * service directly — never a repository, never an internal fetch to
 * `GET /api/proposals/[id]` — mirroring admin/clients/[id]/page.tsx's
 * identical established pattern exactly. As of Stage 7F, this page
 * integrates the complete read-only Proposal/version history
 * (`ProposalVersionHistory`), Travel-Consultant-only revision creation
 * (`CreateProposalRevisionPanel`, Stage 7D), Travel-Consultant-only version
 * publishing (`PublishProposalVersionButton`, Stage 7E), and externally
 * received Accept/Decline/Request-Changes response recording
 * (`RecordProposalResponsePanel`, available to both `ADMIN_MANAGER` and
 * `TRAVEL_CONSULTANT`, Stage 7F) — both rendered per eligible version inside
 * `ProposalVersionHistory` — on one page. Portal-based (client-authenticated)
 * responses remain deferred to Phase 3.
 *
 * `PROPOSAL_NOT_FOUND`/`PROPOSAL_FORBIDDEN` are handled explicitly inline
 * and render the identical "Proposal not found" state, preserving D-027
 * §3's anti-enumeration property exactly as the service layer already
 * shapes it: a `TRAVEL_CONSULTANT` can never distinguish "this Proposal
 * does not exist" from "this Proposal exists but is not assigned to you"
 * from this page's rendered output — neither branch renders any
 * Proposal-specific content (Client identity, version content, or
 * lifecycle/response state). Any other error bubbles to this route
 * segment's nearest error boundary, exactly as the Client detail page
 * already establishes for an unexpected service failure.
 *
 * `proposal.versions` is rendered by `ProposalVersionHistory` exactly as
 * `getProposalById` returns it — already ordered `versionNumber desc` by
 * the repository/service layer (D-027 §6) — this page never re-queries,
 * re-sorts, or re-filters it. `canPublish={user.role === 'TRAVEL_CONSULTANT'}`
 * is the sole gate `ProposalVersionHistory` uses to decide whether to render
 * a publish action per eligible draft — no role name or user object is ever
 * passed to an individual publish button (Stage 7E §G).
 *
 * For a `TRAVEL_CONSULTANT` only, `CreateProposalRevisionPanel` (D-027 §8's
 * revision-creation entry point, Stage 7D) is additionally rendered,
 * receiving this page's own already-validated `proposalId` — never a
 * Proposal picker or Client picker of any kind. `ADMIN_MANAGER` never sees
 * this panel, and never sees any publish control, at all (D-027 §3:
 * Admin/Manager may not create a revision or publish a version).
 *
 * `canRecordResponse={user.role === 'ADMIN_MANAGER' || user.role ===
 * 'TRAVEL_CONSULTANT'}` (Stage 7F) is the sole gate `ProposalVersionHistory`
 * uses to decide whether to render a response-recording panel for the
 * current client-visible version once it has no recorded response yet — no
 * role name or user object is ever passed to an individual panel. Unlike
 * revision creation and publishing, response recording is shared by both
 * allowed roles (D-027 §3's Section 9.1 capability).
 */
export default async function AdminProposalDetailPage({ params }: { params: PageParams }) {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  const access = authorize(user.role, ALLOWED_ROLES);
  if (!access.authorized) {
    return (
      <div>
        <h1>Access denied</h1>
        <p>Only Admin/Manager and Travel Consultant staff can access Proposal management.</p>
      </div>
    );
  }

  const idResult = proposalIdParamSchema.safeParse(await params);
  if (!idResult.success) {
    return (
      <div>
        <Link href="/admin/proposals">← Back to Proposals</Link>
        <h1>Proposal not found</h1>
        <p>This proposal link is invalid.</p>
      </div>
    );
  }

  const proposalId = idResult.data.id;

  let proposal;
  try {
    proposal = await getProposalById(user, proposalId);
  } catch (error) {
    if (
      error instanceof ProposalError &&
      (error.code === 'PROPOSAL_NOT_FOUND' || error.code === 'PROPOSAL_FORBIDDEN')
    ) {
      return (
        <div>
          <Link href="/admin/proposals">← Back to Proposals</Link>
          <h1>Proposal not found</h1>
          <p>This proposal was not found or is not accessible to you.</p>
        </div>
      );
    }
    throw error;
  }

  return (
    <div>
      <Link href="/admin/proposals">← Back to Proposals</Link>
      <h1>Proposal</h1>

      <dl className={styles.detailFields}>
        <div className={styles.detailField}>
          <dt>Client</dt>
          <dd>
            <Link href={`/admin/clients/${proposal.client.id}`}>{proposal.client.fullName}</Link>
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Created</dt>
          <dd>
            <time dateTime={proposal.createdAt.toISOString()}>
              {proposal.createdAt.toLocaleString('en-PH')}
            </time>
          </dd>
        </div>
        <div className={styles.detailField}>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={proposal.updatedAt.toISOString()}>
              {proposal.updatedAt.toLocaleString('en-PH')}
            </time>
          </dd>
        </div>
      </dl>

      <ProposalVersionHistory
        versions={proposal.versions}
        canPublish={user.role === 'TRAVEL_CONSULTANT'}
        canRecordResponse={user.role === 'ADMIN_MANAGER' || user.role === 'TRAVEL_CONSULTANT'}
      />

      {user.role === 'TRAVEL_CONSULTANT' ? (
        <CreateProposalRevisionPanel proposalId={proposalId} />
      ) : null}
    </div>
  );
}
