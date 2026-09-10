// D-047 §12 Loading state for the proposal-review route. A <div>, never a
// nested <main> — the one <main> landmark is owned by client/layout.tsx.
export default function ClientMyJourneyLoading() {
  return (
    <div>
      <h1>My Journey</h1>
      <p role="status">Loading</p>
    </div>
  );
}
