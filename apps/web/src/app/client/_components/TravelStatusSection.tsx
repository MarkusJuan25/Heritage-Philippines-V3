import type { ClientOverviewTravelStatus } from '@/features/client-portal/schemas';

import { OverviewSection } from './OverviewSection';
import styles from '../client.module.css';

// D-040 §6/§7. A portfolio-level summary — "Your travel status" — never a
// claim about a single current journey. `progressLine` is always present
// and rendered; `proposalLine` is rendered only when non-null, above the
// `progressLine`. Both sentences come verbatim from the DTO
// (`deriveTravelStatus`, Stage 6b) — this component never paraphrases,
// re-derives, or reorders them.
export function TravelStatusSection({
  travelStatus,
}: {
  travelStatus: ClientOverviewTravelStatus;
}) {
  return (
    <OverviewSection title="Your travel status">
      <div className={styles.travelStatus}>
        {travelStatus.proposalLine ? (
          <p className={styles.proposalLine}>{travelStatus.proposalLine.sentence}</p>
        ) : null}
        <p className={styles.progressLine}>{travelStatus.progressLine.sentence}</p>
      </div>
    </OverviewSection>
  );
}
