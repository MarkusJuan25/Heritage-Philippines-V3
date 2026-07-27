import Link from 'next/link';

import type { LeadRecordWithAssignment } from '@/features/leads/repository';

import { LeadStatusBadge } from './LeadStatusBadge';
import styles from '../leads.module.css';

/**
 * Renders the Lead list twice — a stacked-card layout for narrow screens
 * and a real `<table>` from tablet width up — with CSS alone toggling
 * which is visible (`leads.module.css`), never duplicating data-fetching
 * or JS-driven layout switching (.claude/rules/frontend.md's mobile-first
 * requirement). `assignment` (D-023 §5) is shown as the assigned
 * consultant's name, or "Unassigned" when null.
 */
export function LeadTable({ items }: { items: LeadRecordWithAssignment[] }) {
  return (
    <>
      <ul className={styles.leadCards}>
        {items.map((lead) => (
          <li key={lead.id} className={styles.leadCard}>
            <div className={styles.leadCardRow}>
              <Link href={`/admin/leads/${lead.id}`}>{lead.fullName}</Link>
              <LeadStatusBadge status={lead.status} />
            </div>
            <div className={styles.leadCardRow}>
              <span>{lead.source}</span>
              <span>{lead.assignment ? lead.assignment.staffName : 'Unassigned'}</span>
            </div>
          </li>
        ))}
      </ul>

      <table className={styles.leadTable}>
        <caption className={styles.srOnly}>Leads</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Source</th>
            <th scope="col">Contact</th>
            <th scope="col">Assigned Consultant</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((lead) => (
            <tr key={lead.id}>
              <th scope="row">
                <Link href={`/admin/leads/${lead.id}`}>{lead.fullName}</Link>
              </th>
              <td>
                <LeadStatusBadge status={lead.status} />
              </td>
              <td>{lead.source}</td>
              <td>{lead.email ?? lead.phone ?? '—'}</td>
              <td>{lead.assignment ? lead.assignment.staffName : 'Unassigned'}</td>
              <td>
                <time dateTime={lead.createdAt.toISOString()}>
                  {lead.createdAt.toLocaleDateString('en-PH')}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
