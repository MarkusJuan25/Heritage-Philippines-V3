import { ConversationCard, type ConversationCardView } from './ConversationCard';
import type { ConversationReplyAction } from './ConversationReplyForm';
import styles from '../conversations.module.css';

// D-051 §13, Stage 3 — the body of `/admin/conversations`. `conversations`
// and `replyActions` are index-aligned (both derived from the same
// `listConversationsForStaff` result in `page.tsx`), mirroring
// `client/my-journey/_components/ProposalReviewList.tsx`'s identical
// render-DTO/action-array pairing. Each card is keyed by a
// non-identifier composite (`clientFullName` + `createdAt` + index) —
// never a `Conversation.id` — matching `ProposalReviewList`'s own
// `${card.versionNumber}-${index}` keying discipline exactly.
export function ConversationList({
  conversations,
  replyActions,
}: {
  conversations: ConversationCardView[];
  replyActions: ConversationReplyAction[];
}) {
  if (conversations.length === 0) {
    return <p className={styles.emptyState}>No conversations yet.</p>;
  }

  return (
    <div className={styles.conversationList}>
      {conversations.map((conversation, index) => (
        <ConversationCard
          key={`${conversation.clientFullName}-${conversation.createdAt.toISOString()}-${index}`}
          conversation={conversation}
          action={replyActions[index]!}
        />
      ))}
    </div>
  );
}
