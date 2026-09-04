import type { ClientOverviewConsultant } from '@/features/client-portal/schemas';

import { OverviewSection } from './OverviewSection';
import styles from '../client.module.css';

// D-040 §7. Two runtime branches, keyed solely on whether Contract F
// returned an assigned consultant name:
//
//  - name present: the card shows the name only; the support-guidance line
//    interpolates that same name at render time.
//  - no assignment: the card reads exactly "Your Heritage Philippines
//    travel team."; the support-guidance line uses the generic team phrase.
//
// Both support-guidance strings are reproduced verbatim from D-040 §7 and
// must never be paraphrased. No fabricated support route, email address,
// telephone number, contact form, branding asset, or V2 link appears
// anywhere here. `${consultantName}` is a real runtime interpolation of the
// name already shown in the card — not a placeholder.
const TEAM_FALLBACK = 'Your Heritage Philippines travel team.';
const SUPPORT_PREFIX = 'Support & Messages is planned for a later phase. Until then, ';

function supportGuidanceSentence(consultant: ClientOverviewConsultant): string {
  return consultant === null
    ? `${SUPPORT_PREFIX}your Heritage Philippines travel team is your point of contact.`
    : `${SUPPORT_PREFIX}${consultant.name}, your Heritage Philippines travel consultant, is your point of contact.`;
}

export function ConsultantCard({ consultant }: { consultant: ClientOverviewConsultant }) {
  return (
    <OverviewSection title="Your travel consultant">
      <div className={styles.consultant}>
        <p className={styles.consultantName}>
          {consultant === null ? TEAM_FALLBACK : consultant.name}
        </p>
        <p className={styles.supportGuidance}>{supportGuidanceSentence(consultant)}</p>
      </div>
    </OverviewSection>
  );
}
