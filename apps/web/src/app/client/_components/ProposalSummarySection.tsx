import type { ClientOverviewProposals } from '@/features/client-portal/schemas';

import { OverviewSection } from './OverviewSection';
import styles from '../client.module.css';

// D-040 §4. The section header uses `currentVisibleTotal`; the empty state
// is keyed on `currentVisibleTotal === 0` (which implies an empty preview,
// since the preview shares the same current-client-visible predicate) and
// reads exactly:
//   "No proposals to review yet. Your travel consultant will prepare one for you."
// Otherwise the preview list is rendered exactly as handed over — already
// bounded to at most `OVERVIEW_PREVIEW_MAX` (5) by Contract C; this
// component adds no cap of its own and re-derives nothing. Each item
// carries only `versionNumber` and the already-mapped client-facing
// `statusLabel` — no proposal content, no id.
export function ProposalSummarySection({ proposals }: { proposals: ClientOverviewProposals }) {
  return (
    <OverviewSection title="Proposals" count={proposals.currentVisibleTotal}>
      {proposals.currentVisibleTotal === 0 ? (
        <p className={styles.emptyState}>
          No proposals to review yet. Your travel consultant will prepare one for you.
        </p>
      ) : (
        <ul className={styles.previewList}>
          {proposals.preview.map((item, index) => (
            <li key={`${item.versionNumber}-${index}`} className={styles.previewItem}>
              <span className={styles.previewItemPrimary}>Version {item.versionNumber}</span>
              <span className={styles.previewItemMeta}>{item.statusLabel}</span>
            </li>
          ))}
        </ul>
      )}
    </OverviewSection>
  );
}
