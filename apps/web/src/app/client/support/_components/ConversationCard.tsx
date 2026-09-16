import type { ConversationCategory } from '@/generated/prisma/client';
import type { ClientConversationSummary } from '@/features/conversations/schemas';

import { ConversationReplyForm, type ClientConversationReplyAction } from './ConversationReplyForm';
import styles from '../support.module.css';

// D-051 §9/§14/§15, Stage 4 — a single Conversation's full client-visible
// thread, rendered inline (list + detail together, per the reviewed
// Stage 3 route-shape decision, applied identically here: there is no
// `/client/support/[id]` route). `conversation` is exactly
// `ClientConversationSummary` (D-051 §9's own identifier-free allow-list
// — `category`, `createdAt`, and each message's `body`/`createdAt`/
// `authorLabel` only) — it already carries no `Conversation.id`,
// `clientId`, or `Message.id` at all, so unlike the Stage 3 admin card,
// no further stripping is needed here; this component simply never
// receives an identifier to leak in the first place. This is a Server
// Component (no `'use client'`) — safe to import the Prisma-linked
// `@/features/conversations/schemas` module for its types, since Server
// Components never ship to the browser bundle.
export function ConversationCard({
  conversation,
  action,
}: {
  conversation: ClientConversationSummary;
  action: ClientConversationReplyAction;
}) {
  const categoryLabel = CATEGORY_LABELS[conversation.category];

  return (
    <article className={styles.conversationCard} aria-label={`${categoryLabel} conversation`}>
      <h2 className={styles.conversationCardHeading}>{categoryLabel}</h2>
      <p className={styles.conversationCardMeta}>
        Started{' '}
        <time dateTime={conversation.createdAt.toISOString()}>
          {formatTimestamp(conversation.createdAt)}
        </time>
      </p>

      <ul className={styles.messageList}>
        {conversation.messages.map((message, index) => (
          // No identifier exists on `ClientConversationMessage` to key
          // by (D-051 §9 excludes `Message.id` from the client-facing
          // allow-list entirely) — keyed by index, mirroring
          // `ProposalReviewList`'s own identical identifier-free keying
          // discipline (D-047 §4/§6). This list is never reordered or
          // filtered client-side, so an index key is stable here.
          <li key={index} className={styles.messageItem}>
            <div className={styles.messageMeta}>
              <span className={styles.messageAuthor}>{message.authorLabel}</span>
              <time dateTime={message.createdAt.toISOString()} className={styles.messageTimestamp}>
                {formatTimestamp(message.createdAt)}
              </time>
            </div>
            {/* Plain text only (D-051 §9/§11's rendering discipline for a
                Message body): React escapes this string, so a `<script>`-
                or Markdown-looking value is always displayed literally
                and never interpreted — no `dangerouslySetInnerHTML`,
                ever. */}
            <p className={styles.messageBody}>{message.body}</p>
          </li>
        ))}
      </ul>

      <ConversationReplyForm action={action} />
    </article>
  );
}

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

// `timeZone: 'Asia/Manila'` is explicit and mandatory: without it,
// `toLocaleString` resolves the displayed date/time from the rendering
// server process's own OS timezone, which can differ across environments
// even though the underlying `Date` instant never changes — the same
// class of divergence `client/my-journey/_components/ProposalReviewCard.tsx`'s
// own `formatReviewDate` avoids via UTC getters, and the same fix already
// applied to `admin/conversations/_components/ConversationCard.tsx`
// (D-051 Stage 3).
function formatTimestamp(date: Date): string {
  return date.toLocaleString('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  });
}
