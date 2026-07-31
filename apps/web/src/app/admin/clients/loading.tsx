// Next.js's file-convention loading UI (App Router) for this route segment
// and its nested [id] page — shown automatically while the corresponding
// Server Component streams data (D-025 §10's required "loading" state).
// Mirrors admin/leads/loading.tsx exactly.
export default function ClientsLoading() {
  return (
    <div>
      <h1>Clients</h1>
      <p role="status">Loading…</p>
    </div>
  );
}
