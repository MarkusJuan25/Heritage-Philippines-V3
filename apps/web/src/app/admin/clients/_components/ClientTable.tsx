import Link from 'next/link';

import type { ClientListItem } from '@/features/clients/repository';

import styles from '../clients.module.css';

/**
 * Renders both independently authorized contact channels (D-025 §3: email
 * and phone are each their own list field, never one collapsed into the
 * other with `??`) — both when both exist, whichever one exists alone, or an
 * em dash only when neither does. Shared between the mobile card and the
 * desktop table so the two layouts can never drift apart on this rule.
 */
function ClientContactValue({ email, phone }: { email: string | null; phone: string | null }) {
  if (!email && !phone) {
    return <>—</>;
  }
  return (
    <>
      {email ? <div>{email}</div> : null}
      {phone ? <div>{phone}</div> : null}
    </>
  );
}

/**
 * Renders the Client list twice — a stacked-card layout for narrow screens
 * and a real `<table>` from tablet width up — with CSS alone toggling which
 * is visible (`clients.module.css`), never duplicating data-fetching or
 * JS-driven layout switching (.claude/rules/frontend.md's mobile-first
 * requirement), mirroring admin/leads/_components/LeadTable.tsx's
 * established pattern. Renders only D-025 §3's exact list-item field set
 * (`id`, `fullName`, `email`, `phone`, `createdAt`, `assignment`) — there is
 * no `status` field on a Client list item to render, and `normalizedEmail`/
 * `normalizedPhone` are never part of `ClientListItem` in the first place,
 * so they can never leak here. `assignment` is shown as the assigned
 * consultant's name, or "Unassigned" when null.
 *
 * The mobile card carries the same information as the desktop row —
 * including `createdAt`, using the identical value and formatting — labelled
 * with a `dl`/`dt`/`dd` structure so each value's meaning is visible and
 * accessible without relying on column position alone (the desktop table's
 * own `scope="col"` headers already provide that for its layout).
 */
export function ClientTable({ items }: { items: ClientListItem[] }) {
  return (
    <>
      <ul className={styles.clientCards}>
        {items.map((client) => (
          <li key={client.id} className={styles.clientCard}>
            <div className={styles.clientCardRow}>
              <Link href={`/admin/clients/${client.id}`}>{client.fullName}</Link>
            </div>
            <dl className={styles.clientCardDetails}>
              <div className={styles.clientCardDetailRow}>
                <dt>Contact</dt>
                <dd>
                  <ClientContactValue email={client.email} phone={client.phone} />
                </dd>
              </div>
              <div className={styles.clientCardDetailRow}>
                <dt>Assigned Consultant</dt>
                <dd>{client.assignment ? client.assignment.staffName : 'Unassigned'}</dd>
              </div>
              <div className={styles.clientCardDetailRow}>
                <dt>Created</dt>
                <dd>
                  <time dateTime={client.createdAt.toISOString()}>
                    {client.createdAt.toLocaleDateString('en-PH')}
                  </time>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <table className={styles.clientTable}>
        <caption className={styles.srOnly}>Clients</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Contact</th>
            <th scope="col">Assigned Consultant</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((client) => (
            <tr key={client.id}>
              <th scope="row">
                <Link href={`/admin/clients/${client.id}`}>{client.fullName}</Link>
              </th>
              <td>
                <ClientContactValue email={client.email} phone={client.phone} />
              </td>
              <td>{client.assignment ? client.assignment.staffName : 'Unassigned'}</td>
              <td>
                <time dateTime={client.createdAt.toISOString()}>
                  {client.createdAt.toLocaleDateString('en-PH')}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
