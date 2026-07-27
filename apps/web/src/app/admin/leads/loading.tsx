// Next.js's file-convention loading UI (App Router) for this route segment
// and its nested [id] page — shown automatically while the corresponding
// Server Component streams data (D-023 §4's required "loading" state).
export default function LeadsLoading() {
  return (
    <div>
      <h1>Leads</h1>
      <p role="status">Loading…</p>
    </div>
  );
}
