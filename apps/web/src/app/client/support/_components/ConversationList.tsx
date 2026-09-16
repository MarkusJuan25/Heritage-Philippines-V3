import type { ClientConversationSummary } from '@/features/conversations/schemas';

import { ConversationCard } from './ConversationCard';
import type { ClientConversationReplyAction } from './ConversationReplyForm';
import styles from '../support.module.css';

// D-051 §13, Stage 4 — the body of `/client/support`. `conversations`
// and `replyActions` are index-aligned (both derived from the same
// `listConversationsForClient` result's `render`/`serverModel` pair in
// `page.tsx`), mirroring `client/my-journey/_components/ProposalReviewList.tsx`'s
// identical render-DTO/action-array pairing and
// `admin/conversations/_components/ConversationList.tsx`'s (D-051 Stage 3)
// identical technique. Each card is keyed by a non-identifier composite
// (`category` + `createdAt` + index) — never a `Conversation.id`, which
// does not even exist on `ClientConversationSummary` to key by.
export function ConversationList({
  conversations,
  replyActions,
}: {
  conversations: ClientConversationSummary[];
  replyActions: ClientConversationReplyAction[];
}) {
  if (conversations.length === 0) {
    return (
      <p className={styles.emptyState}>
        No conversations yet. Send a message below to get started.
      </p>
    );
  }

  return (
    <div className={styles.conversationList}>
      {conversations.map((conversation, index) => (
        <ConversationCard
          key={`${conversation.category}-${conversation.createdAt.toISOString()}-${index}`}
          conversation={conversation}
          action={replyActions[index]!}
        />
      ))}
    </div>
  );
}
