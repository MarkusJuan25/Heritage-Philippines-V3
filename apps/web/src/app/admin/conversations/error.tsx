'use client';

import styles from './conversations.module.css';

// Next.js's file-convention error boundary (App Router) for this route
// segment — catches any unexpected exception (never a known
// `ConversationError` outcome, which the page and reply action each
// handle explicitly inline instead) and renders
// .claude/rules/frontend.md's required "error" state with a retry path,
// without leaking internal error details
// (.claude/rules/backend.md's "No secret or sensitive-error exposure"
// applied to this UI layer too). Mirrors admin/leads/error.tsx exactly.
export default function ConversationsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div>
      <h1>Conversations</h1>
      <div className={styles.errorState} role="alert">
        <p>Something went wrong while loading this page.</p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
