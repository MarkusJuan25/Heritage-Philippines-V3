import type { ClientOverviewIdentity } from '@/features/client-portal/schemas';

import styles from '../client.module.css';

// D-040 §7/§8: the identity <dl> shows the client's own `fullName`,
// `email`, and `phone` — and nothing else. `email` / `phone` are nullable
// on the DTO; a missing value renders as an explicit "—" placeholder,
// never a fabricated value (the repository's established null-field
// convention, D-029 §5). No id, `userId`, `normalizedEmail`/
// `normalizedPhone`, address, nationality, date of birth, emergency
// contact, notes, or timestamp is present on this DTO or rendered here.
const NOT_PROVIDED = '—';

export function IdentityCard({ identity }: { identity: ClientOverviewIdentity }) {
  return (
    <dl className={styles.identity}>
      <dt>Name</dt>
      <dd>{identity.fullName}</dd>
      <dt>Email</dt>
      <dd>{identity.email ?? NOT_PROVIDED}</dd>
      <dt>Phone</dt>
      <dd>{identity.phone ?? NOT_PROVIDED}</dd>
    </dl>
  );
}
