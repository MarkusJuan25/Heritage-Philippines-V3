'use client';

import styles from './leads.module.css';

// Next.js's file-convention error boundary (App Router) for this route
// segment and its nested [id] page — catches any unexpected exception
// (never a known LeadError outcome, which each page handles explicitly
// inline instead) and renders D-023 §4's required "error" state with a
// retry path, without leaking internal error details
// (.claude/rules/backend.md's "No secret or sensitive-error exposure"
// applied to this UI layer too).
export default function LeadsError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div>
      <h1>Leads</h1>
      <div className={styles.errorState} role="alert">
        <p>Something went wrong while loading this page.</p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
