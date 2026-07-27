import type { LeadStatus } from '@/generated/prisma/client';

// Human-readable labels for the ten LeadStatus values (blueprint Section
// 6.1) — never inventing a status the schema doesn't define
// (.claude/rules/admin-dashboard.md's "Status indicators must reflect the
// actual lifecycle statuses defined in the blueprint, not ad hoc labels
// invented in the UI layer"). Shared between LeadStatusBadge and
// LeadFilters so the label text is defined exactly once.
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: 'New',
  UNDER_REVIEW: 'Under Review',
  CONTACTED: 'Contacted',
  CONSULTATION_SCHEDULED: 'Consultation Scheduled',
  QUALIFIED: 'Qualified',
  CONVERTED_TO_CLIENT: 'Converted to Client',
  NOT_PROCEEDING: 'Not Proceeding',
  DUPLICATE: 'Duplicate',
  SPAM: 'Spam',
  ARCHIVED: 'Archived',
};

export const LEAD_STATUS_VALUES = Object.keys(LEAD_STATUS_LABELS) as LeadStatus[];
