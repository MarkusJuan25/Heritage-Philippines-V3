import Link from 'next/link';

import type { ProposalListItem } from '@/features/proposals/repository';

import styles from '../proposals.module.css';

/**
 * Renders the Proposal list twice — a stacked-card layout for narrow screens
 * and a real `<table>` from tablet width up — with CSS alone toggling which
 * is visible (`proposals.module.css`), never duplicating data-fetching or
 * JS-driven layout switching (.claude/rules/frontend.md's mobile-first
 * requirement), mirroring admin/clients/_components/ClientTable.tsx's
 * established pattern.
 *
 * Renders only D-027 §8's exact identification fields — the linked Client's
 * identity and `Proposal.createdAt` — plus a clearly labelled navigation
 * link to the Proposal's own detail page. There is no title, reference,
 * status, pricing, or content field to render for a Proposal list item in
 * the first place (`ProposalListItem` carries none of these), so none can
 * ever leak here. Items are rendered in exactly the order supplied — this
 * component never sorts or filters `items` itself (D-027 §8's "do not
 * re-sort the service result in the page or component").
 *
 * The mobile card carries the same information as the desktop row —
 * including `createdAt`, using the identical value and formatting — labelled
 * with a `dl`/`dt`/`dd` structure so each value's meaning is visible and
 * accessible without relying on column position alone (the desktop table's
 * own `scope="col"` headers already provide that for its layout).
 */
export function ProposalTable({ items }: { items: ProposalListItem[] }) {
  return (
    <>
      <ul className={styles.proposalCards}>
        {items.map((proposal) => (
          <li key={proposal.id} className={styles.proposalCard}>
            <div className={styles.proposalCardRow}>
              <Link href={`/admin/clients/${proposal.client.id}`}>{proposal.client.fullName}</Link>
            </div>
            <dl className={styles.proposalCardDetails}>
              <div className={styles.proposalCardDetailRow}>
                <dt>Created</dt>
                <dd>
                  <time dateTime={proposal.createdAt.toISOString()}>
                    {proposal.createdAt.toLocaleDateString('en-PH')}
                  </time>
                </dd>
              </div>
              <div className={styles.proposalCardDetailRow}>
                <dt>Proposal</dt>
                <dd>
                  <Link href={`/admin/proposals/${proposal.id}`}>View proposal</Link>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <table className={styles.proposalTable}>
        <caption className={styles.srOnly}>Proposals</caption>
        <thead>
          <tr>
            <th scope="col">Client</th>
            <th scope="col">Created</th>
            <th scope="col">Proposal</th>
          </tr>
        </thead>
        <tbody>
          {items.map((proposal) => (
            <tr key={proposal.id}>
              <th scope="row">
                <Link href={`/admin/clients/${proposal.client.id}`}>
                  {proposal.client.fullName}
                </Link>
              </th>
              <td>
                <time dateTime={proposal.createdAt.toISOString()}>
                  {proposal.createdAt.toLocaleDateString('en-PH')}
                </time>
              </td>
              <td>
                <Link href={`/admin/proposals/${proposal.id}`}>View proposal</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
