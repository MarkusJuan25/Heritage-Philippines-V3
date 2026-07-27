import type { LeadStatus } from '@/generated/prisma/client';

import styles from '../leads.module.css';
import { LEAD_STATUS_LABELS } from './leadStatusLabels';

// A coarse visual grouping used only for styling — never for
// authorization or transition logic, which lives entirely in
// features/leads/transitions.ts. Typed `string | undefined` because CSS
// Module property access resolves through an index signature, which this
// project's `noUncheckedIndexedAccess` compiler option always widens with
// `| undefined` regardless of the module's own declared value type.
const STATUS_CATEGORY_CLASS: Record<LeadStatus, string | undefined> = {
  NEW: styles.statusActive,
  UNDER_REVIEW: styles.statusActive,
  CONTACTED: styles.statusActive,
  CONSULTATION_SCHEDULED: styles.statusActive,
  QUALIFIED: styles.statusActive,
  CONVERTED_TO_CLIENT: styles.statusConverted,
  NOT_PROCEEDING: styles.statusClosed,
  DUPLICATE: styles.statusClosed,
  SPAM: styles.statusClosed,
  ARCHIVED: styles.statusClosed,
};

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return (
    <span className={`${styles.statusBadge ?? ''} ${STATUS_CATEGORY_CLASS[status] ?? ''}`}>
      {LEAD_STATUS_LABELS[status]}
    </span>
  );
}
