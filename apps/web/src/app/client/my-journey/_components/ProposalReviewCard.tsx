import type {
  ClientProposalResponseAction,
  ClientProposalReviewCard as ClientProposalReviewCardDto,
} from '@/features/proposals/service';

import { ProposalResponseForm } from './ProposalResponseForm';
import styles from '../../client.module.css';

// D-047 §5/§11/§12 — one proposal-review card. This Stage 4 slice is
// read-only: it renders the proposal `content` (the review target the
// authenticated owner is entitled to see, §4) as PLAIN TEXT only — React
// escapes the string, so a `<script>`- or Markdown-looking value a
// consultant typed is always displayed literally and is never interpreted
// (§11; no `dangerouslySetInnerHTML`, no markup interpreter). No form,
// radio, checkbox, or submit control is rendered here — the response form
// and its Server Action are Stage 5. The card receives only the
// identifier-free render DTO (§4): no `Proposal` / `ProposalVersion` /
// `ProposalAcceptance` id is present or reachable.
//
// Per-card state (§5): (a) awaiting — content plus the client-facing status
// label ("Awaiting your response"); (b) already responded — content plus a
// read-only, unchangeable summary, no form; (c) legacy null content — an
// explicit "Content unavailable" known state directing the client to their
// travel consultant as plain text, no form, no Support link (the Support
// route does not exist yet — §12).

const RESPONSE_VERB: Record<'ACCEPT' | 'DECLINE' | 'REQUEST_CHANGES', string> = {
  ACCEPT: 'accepted',
  DECLINE: 'declined',
  REQUEST_CHANGES: 'requested changes to',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// The DTO's `publishedAt` / `respondedAt` are ISO-8601 strings produced
// server-side (Stage 3). Formatted here with a fixed, locale-independent
// pattern from the UTC instant so server and client render byte-identical
// output (no hydration mismatch, no `Intl` locale coupling in tests).
function formatReviewDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function ProposalReviewCard({
  card,
  index,
  action,
}: {
  card: ClientProposalReviewCardDto;
  index: number;
  action?: ClientProposalResponseAction;
}) {
  const headingId = `proposal-review-card-${index}-v${card.versionNumber}`;

  return (
    <article className={styles.reviewCard} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.reviewCardHeading}>
        Proposal — Version {card.versionNumber}
      </h2>
      <p className={styles.reviewCardMeta}>
        Shared with you on {formatReviewDate(card.publishedAt)}
      </p>

      {card.content.available ? (
        <>
          <section
            className={styles.reviewCardDetails}
            aria-label={`Proposal version ${card.versionNumber} details`}
          >
            <p className={styles.reviewCardContent}>{card.content.text}</p>
          </section>

          {card.response ? (
            <p className={styles.reviewCardResponse}>
              You {RESPONSE_VERB[card.response.responseType]} this on{' '}
              {formatReviewDate(card.response.respondedAt)}. This response can&apos;t be changed for
              this version.
            </p>
          ) : (
            <>
              <p className={styles.reviewCardStatus}>{card.statusLabel}</p>
              {action ? (
                <ProposalResponseForm action={action} versionNumber={card.versionNumber} />
              ) : null}
            </>
          )}
        </>
      ) : (
        <p className={styles.reviewCardUnavailable}>
          Content unavailable. Please contact your Heritage Philippines travel consultant.
        </p>
      )}
    </article>
  );
}
