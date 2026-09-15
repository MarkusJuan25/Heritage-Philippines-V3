import type { ClientOverviewTravelStatus } from '@/features/client-portal/schemas';

import { OverviewSection } from '../../_components/OverviewSection';
import styles from '../../client.module.css';

// D-050 §§4, 6. Reuses D-040's shared `OverviewSection` shell and the exact
// `.travelStatus`/`.proposalLine`/`.progressLine` classes the Home Overview's
// `TravelStatusSection` already uses — this is a second call site for one
// already-accessible, already-reviewed rendering pattern, not a new one.
// `progressLine` is always present and rendered; `proposalLine` is rendered
// only when non-null, above `progressLine`. Both sentences come verbatim
// from the DTO (`getClientJourneyProgress`) — this component never
// paraphrases, re-derives, or reorders them.
export function JourneyProgressSection({ progress }: { progress: ClientOverviewTravelStatus }) {
  return (
    <OverviewSection title="Your travel status">
      <div className={styles.travelStatus}>
        {progress.proposalLine ? (
          <p className={styles.proposalLine}>{progress.proposalLine.sentence}</p>
        ) : null}
        <p className={styles.progressLine}>{progress.progressLine.sentence}</p>
      </div>
    </OverviewSection>
  );
}
