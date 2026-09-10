import type {
  ClientProposalResponseAction,
  ClientProposalReviewRender,
} from '@/features/proposals/service';

import { ProposalReviewCard } from './ProposalReviewCard';
import { ProposalReviewPagination } from './ProposalReviewPagination';
import styles from '../../client.module.css';

// D-047 §5/§12 — the body of `/client/my-journey`. `render.isEmpty` is set
// by the service only for page 1 with no current client-visible proposal
// (a confirmed page > 1 with no rows is redirected upstream, never rendered
// here), so it maps 1:1 to the global empty state, whose copy matches the
// existing Home / Overview `ProposalSummarySection` empty state. Otherwise
// each card is keyed by `versionNumber` + list index — never a database id
// (§4) — and pagination links follow.
export function ProposalReviewList({
  render,
  responseActions = [],
}: {
  render: ClientProposalReviewRender;
  // Index-aligned with `render.cards` (both come from the same service
  // result). Each entry is the card's inline Server Action; a card only
  // renders its response form in the awaiting state.
  responseActions?: ClientProposalResponseAction[];
}) {
  if (render.isEmpty) {
    return (
      <p className={styles.emptyState}>
        No proposals to review yet. Your travel consultant will prepare one for you.
      </p>
    );
  }

  return (
    <div className={styles.reviewList}>
      {render.cards.map((card, index) => (
        <ProposalReviewCard
          key={`${card.versionNumber}-${index}`}
          card={card}
          index={index}
          action={responseActions[index]}
        />
      ))}
      <ProposalReviewPagination
        page={render.page}
        hasPrevious={render.hasPrevious}
        hasNext={render.hasNext}
      />
    </div>
  );
}
