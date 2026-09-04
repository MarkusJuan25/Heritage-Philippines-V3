// D-040 §7 Loading state — verbatim. A <div>, never a nested <main> (the
// one <main> landmark is owned by layout.tsx).
export default function ClientOverviewLoading() {
  return (
    <div>
      <h1>Home / Overview</h1>
      <p role="status">Loading</p>
    </div>
  );
}
