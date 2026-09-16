import type { ConversationCategory, MessageVisibility } from '@/generated/prisma/client';

import { ConversationReplyForm, type ConversationReplyAction } from './ConversationReplyForm';
import styles from '../conversations.module.css';

// D-051 §9/§14/§15, Stage 3 — a single Conversation's full thread, rendered
// inline (list + detail together, per the reviewed Stage 3 route shape:
// there is no separate `/admin/conversations/[id]` route). This component
// receives no `Conversation.id`, `Client.id`, or `ClientProfile.id` at
// all — `ConversationCardView` below deliberately omits every identifier
// D-051 §15 requires stay out of rendered content, a link target, a
// query parameter, a hidden field, a `data-*` attribute, or any other
// DOM-visible value. `message.id` is retained ONLY as a React list `key`
// (never rendered as text or emitted as a DOM attribute — React strips
// `key` before it ever reaches this component's own props) — D-051 §9
// explicitly permits staff-facing shapes to retain internal identifiers.

export type ConversationCardMessage = {
  id: string;
  body: string;
  visibility: MessageVisibility;
  createdAt: Date;
  authorLabel: string;
};

export type ConversationCardView = {
  category: ConversationCategory;
  clientFullName: string;
  createdAt: Date;
  messages: ConversationCardMessage[];
};

const CATEGORY_LABELS: Record<ConversationCategory, string> = {
  GENERAL_INQUIRY: 'General Inquiry',
  PROPOSAL_ROS: 'Proposal / ROS',
  BOOKING: 'Booking',
  PAYMENT: 'Payment',
  DOCUMENTS: 'Documents',
  VISA: 'Visa',
  TRAVEL_PREPARATION: 'Travel Preparation',
  TECHNICAL_SUPPORT: 'Technical Support',
};

// A visible, textual label for both visibility values (D-051 §8/§16) —
// never color alone — so the staff UI visibly distinguishes an
// `INTERNAL_NOTE` message from a `CLIENT_VISIBLE` one in the same thread.
const VISIBILITY_LABELS: Record<MessageVisibility, string> = {
  CLIENT_VISIBLE: 'Client-visible',
  INTERNAL_NOTE: 'Internal note',
};

const VISIBILITY_BADGE_CLASS: Record<MessageVisibility, string | undefined> = {
  CLIENT_VISIBLE: styles.clientVisibleBadge,
  INTERNAL_NOTE: styles.internalNoteBadge,
};

// `timeZone: 'Asia/Manila'` is explicit and mandatory here: without it,
// `toLocaleString` resolves the displayed date/time from the rendering
// server process's own OS timezone, which can differ across environments
// (a developer machine, CI, staging, production) even though the
// underlying `Date` instant never changes — the same class of divergence
// `client/my-journey/_components/ProposalReviewCard.tsx`'s own
// `formatReviewDate` avoids via UTC getters. Pinning the IANA zone
// directly, rather than switching to that manual-getter approach, keeps
// this feature's staff-facing medium-date/short-time presentation intact
// while making the result deterministic regardless of host timezone.
function formatTimestamp(date: Date): string {
  return date.toLocaleString('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  });
}

export function ConversationCard({
  conversation,
  action,
}: {
  conversation: ConversationCardView;
  action: ConversationReplyAction;
}) {
  return (
    <article
      className={styles.conversationCard}
      aria-label={`Conversation with ${conversation.clientFullName}`}
    >
      <h2 className={styles.conversationCardHeading}>{conversation.clientFullName}</h2>
      <p className={styles.conversationCardMeta}>
        {CATEGORY_LABELS[conversation.category]} · Started{' '}
        <time dateTime={conversation.createdAt.toISOString()}>
          {formatTimestamp(conversation.createdAt)}
        </time>
      </p>

      <ul className={styles.messageList}>
        {conversation.messages.map((message) => (
          <li key={message.id} className={styles.messageItem}>
            <div className={styles.messageMeta}>
              <span className={styles.messageAuthor}>{message.authorLabel}</span>
              <time dateTime={message.createdAt.toISOString()} className={styles.messageTimestamp}>
                {formatTimestamp(message.createdAt)}
              </time>
              <span
                className={`${styles.visibilityBadge ?? ''} ${VISIBILITY_BADGE_CLASS[message.visibility] ?? ''}`}
              >
                {VISIBILITY_LABELS[message.visibility]}
              </span>
            </div>
            {/* Plain text only (D-051 §9/§11's rendering discipline for a
                Message body): React escapes this string, so a `<script>`-
                or Markdown-looking value is always displayed literally and
                never interpreted — no `dangerouslySetInnerHTML`, ever. */}
            <p className={styles.messageBody}>{message.body}</p>
          </li>
        ))}
      </ul>

      <ConversationReplyForm action={action} />
    </article>
  );
}
