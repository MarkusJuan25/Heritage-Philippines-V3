import type { ProposalDetailRecord } from '@/features/proposals/repository';

import styles from '../../proposals.module.css';
import { PublishProposalVersionButton } from './PublishProposalVersionButton';
import { RecordProposalResponsePanel } from './RecordProposalResponsePanel';

export type ProposalVersionEntry = ProposalDetailRecord['versions'][number];

/**
 * Lifecycle state exactly as `prisma/schema.prisma`'s `ProposalVersion` doc
 * comment defines it: `supersededAt` set → superseded, regardless of
 * `clientVisibleAt`; else `clientVisibleAt` set → published (the current
 * client-visible version); else → an unpublished draft. Never a stored
 * field — always derived, matching D-027 §4.
 */
function lifecycleLabel(version: ProposalVersionEntry): string {
  if (version.supersededAt !== null) return 'Superseded';
  if (version.clientVisibleAt !== null) return 'Published';
  return 'Draft';
}

/**
 * Response state (D-027 §4/§9.1), derived from `acceptance` — always
 * rendered as a label separate from `lifecycleLabel` (D-027 §8: "presents
 * the two as separate, clearly labeled indicators rather than collapsing
 * them into one combined label").
 */
function responseLabel(version: ProposalVersionEntry): string {
  if (!version.acceptance) return 'No response';
  switch (version.acceptance.responseType) {
    case 'ACCEPT':
      return 'Accepted';
    case 'DECLINE':
      return 'Declined';
    case 'REQUEST_CHANGES':
      return 'Changes requested';
    default: {
      const exhaustiveCheck: never = version.acceptance.responseType;
      throw new Error(`Unhandled ProposalResponseType: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * D-027 §5/§8, Stage 7E §E.3-§E.5: a version is eligible for a publish
 * action exactly when it is an unpublished draft — never currently
 * client-visible (`clientVisibleAt === null`) and never superseded
 * (`supersededAt === null`). This is exactly `lifecycleLabel`'s `'Draft'`
 * branch, expressed as its own named predicate so the eligibility rule
 * reads directly at each call site rather than string-comparing a display
 * label. The current client-visible version and every superseded version
 * are both ineligible — a superseded version must never be resurrected.
 */
function isEligibleForPublish(version: ProposalVersionEntry): boolean {
  return version.clientVisibleAt === null && version.supersededAt === null;
}

/**
 * D-027 §7/§9.1, Stage 7F §D: a version is eligible for a response-recording
 * action exactly when it is the current client-visible version
 * (`clientVisibleAt !== null && supersededAt === null` — the identical
 * "current" definition `publishedVersion` below already uses) and has no
 * response recorded yet (`acceptance === null`). This check depends only on
 * the version's own fields — never on any other version in the list — so a
 * newer draft (whose own `clientVisibleAt` is always `null`) can never take
 * the response control away from an older current published version: at
 * most one version can ever satisfy "current" at a time (the schema's own
 * partial unique index guarantees this), and that is always the one this
 * predicate matches, regardless of which version has the highest
 * `versionNumber`.
 */
function isEligibleForResponse(version: ProposalVersionEntry): boolean {
  return (
    version.clientVisibleAt !== null && version.supersededAt === null && version.acceptance === null
  );
}

/**
 * Renders a Proposal's complete version history (D-027 §8) in exactly the
 * order supplied — this component never sorts or filters `versions` itself.
 * `features/proposals/repository.ts`'s `findProposalByIdForActor` already
 * orders them `versionNumber desc` (newest first, the same ordering
 * `GET /api/proposals/[id]` returns), so `versions[0]` is always the latest
 * revision — never independently recomputed here as a max/sort.
 *
 * "Latest version" (the highest `versionNumber`) and "Published version"
 * (the one version, if any, with `clientVisibleAt` set and `supersededAt`
 * null — D-027 §5's own literal definition of "current") are two distinct
 * concepts that may point at different versions: creating a revision does
 * not itself publish it (D-027 §4), so an unpublished draft can be the
 * latest version while an older version remains the current published one.
 *
 * Content is rendered as a plain-text node only (`white-space: pre-wrap` in
 * CSS) — never via `dangerouslySetInnerHTML` or any HTML/Markdown
 * interpretation, per D-027 §1. A `null` or empty `content` (a legacy row,
 * Stage 1) renders the required "Content unavailable" state instead of
 * blank space.
 *
 * `canPublish` (Stage 7E) is the sole gate on rendering a
 * `PublishProposalVersionButton` for each eligible draft — the caller
 * (`admin/proposals/[id]/page.tsx`) passes exactly
 * `user.role === 'TRAVEL_CONSULTANT'`; no role name or user object is ever
 * passed into this component or forwarded to an individual button. Every
 * button on the page receives the identical `expectedCurrentVersionId`:
 * `publishedVersion`, the one already computed below from this same
 * rendered snapshot (D-027 §5's own literal "current" definition) — never
 * the latest/highest-numbered version merely because it appears first, and
 * never a fresh query or client fetch. `ADMIN_MANAGER` (`canPublish=false`)
 * sees the identical, unfiltered, unreordered history with no publish
 * control anywhere.
 *
 * `canRecordResponse` (Stage 7F) is the sole gate on rendering a
 * `RecordProposalResponsePanel` for the current client-visible version once
 * it has no recorded response yet — the caller passes exactly
 * `user.role === 'ADMIN_MANAGER' || user.role === 'TRAVEL_CONSULTANT'`; no
 * role name or user object is ever passed into this component or forwarded
 * to an individual panel. Unlike publishing, response recording is never
 * gated to `TRAVEL_CONSULTANT` alone (D-027 §3's Section 9.1 capability is
 * shared by both roles).
 */
export function ProposalVersionHistory({
  versions,
  canPublish,
  canRecordResponse,
}: {
  versions: ProposalVersionEntry[];
  canPublish: boolean;
  canRecordResponse: boolean;
}) {
  const latestVersion = versions[0] ?? null;
  const publishedVersion =
    versions.find((version) => version.clientVisibleAt !== null && version.supersededAt === null) ??
    null;
  const expectedCurrentVersionId = publishedVersion?.id ?? null;

  return (
    <div>
      <dl className={styles.detailFields}>
        <div className={styles.detailField}>
          <dt>Latest version</dt>
          <dd>{latestVersion ? `Version ${latestVersion.versionNumber}` : 'No versions yet.'}</dd>
        </div>
        <div className={styles.detailField}>
          <dt>Published version</dt>
          <dd>
            {publishedVersion
              ? `Version ${publishedVersion.versionNumber}`
              : 'No published version yet.'}
          </dd>
        </div>
      </dl>

      <h2>Version history</h2>
      {versions.length === 0 ? (
        <p>No versions yet.</p>
      ) : (
        <ol className={styles.versionList}>
          {versions.map((version) => (
            <li key={version.id} className={styles.versionItem}>
              <h3 className={styles.versionHeader}>Version {version.versionNumber}</h3>
              {/* D-027 §8: lifecycle state and response state are separate,
                  clearly LABELED indicators — the "Lifecycle: "/"Response: "
                  prefixes are visible text, not an aria-label or visually
                  hidden text, so a sighted reader sees the same disambiguation
                  a screen reader does. */}
              <div className={styles.versionBadges}>
                <span className={styles.badge}>Lifecycle: {lifecycleLabel(version)}</span>
                <span className={styles.badge}>Response: {responseLabel(version)}</span>
              </div>
              {canPublish && isEligibleForPublish(version) ? (
                <PublishProposalVersionButton
                  versionId={version.id}
                  versionNumber={version.versionNumber}
                  expectedCurrentVersionId={expectedCurrentVersionId}
                />
              ) : null}
              {canRecordResponse && isEligibleForResponse(version) ? (
                <RecordProposalResponsePanel
                  versionId={version.id}
                  versionNumber={version.versionNumber}
                />
              ) : null}
              <dl className={styles.detailFields}>
                <div className={styles.detailField}>
                  <dt>Created</dt>
                  <dd>
                    <time dateTime={version.createdAt.toISOString()}>
                      {version.createdAt.toLocaleString('en-PH')}
                    </time>
                  </dd>
                </div>
                <div className={styles.detailField}>
                  <dt>Created by</dt>
                  <dd>{version.createdByUserId}</dd>
                </div>
              </dl>
              <h4>Content</h4>
              <p className={styles.versionContent}>{version.content || 'Content unavailable'}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
