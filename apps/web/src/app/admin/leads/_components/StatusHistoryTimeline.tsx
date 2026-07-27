import type { LeadStatusHistoryRow } from '@/features/leads/repository';

import { LEAD_STATUS_LABELS } from './leadStatusLabels';
import styles from '../leads.module.css';

/**
 * Renders a Lead's paginated status-history read (D-023 §8) as a simple
 * chronological list. Deliberately never shows a transition `reason` —
 * `LeadStatusHistoryRow` doesn't carry one (see
 * features/leads/service.ts's `getLeadStatusHistory` doc comment); showing
 * one here would require inventing data the API does not return.
 */
export function StatusHistoryTimeline({ items }: { items: LeadStatusHistoryRow[] }) {
  if (items.length === 0) {
    return <p>No status history yet.</p>;
  }

  return (
    <ul className={styles.historyList}>
      {items.map((entry) => (
        <li key={entry.id} className={styles.historyItem}>
          <div>
            {entry.previousStatus ? (
              <>
                {LEAD_STATUS_LABELS[entry.previousStatus]} → {LEAD_STATUS_LABELS[entry.newStatus]}
              </>
            ) : (
              <>Created as {LEAD_STATUS_LABELS[entry.newStatus]}</>
            )}
          </div>
          <div className={styles.historyMeta}>
            <time dateTime={entry.createdAt.toISOString()}>
              {entry.createdAt.toLocaleString('en-PH')}
            </time>
            {' · '}
            {entry.changedByName ?? 'Unknown staff member'}
          </div>
        </li>
      ))}
    </ul>
  );
}
