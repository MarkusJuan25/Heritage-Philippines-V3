// Next.js's file-convention loading UI (App Router) for this route
// segment — shown automatically while the Server Component streams data
// (.claude/rules/frontend.md's required "loading" state). Mirrors
// admin/clients/loading.tsx exactly.
export default function ConversationsLoading() {
  return (
    <div>
      <h1>Conversations</h1>
      <p role="status">Loading…</p>
    </div>
  );
}
