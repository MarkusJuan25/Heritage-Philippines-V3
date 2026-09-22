import styles from '../client.module.css';

// D-040 §7: one of the five remaining later-phase navigation labels (of
// the ten canonical labels, five — Home / Overview, My Journey, Bookings,
// Regional Tours, and Support & Messages — are now real routes; D-051
// §10, D-052 §4). A visible plain-text <li> — a <span> label plus a
// visible <span> reading "Coming soon". It has NO `href`, NO `<a>`, NO
// `<button>`, NO `onClick`, NO `tabindex` (not even "-1"), and NO `role`.
// It is not keyboard-focusable and is not described as focusable
// anywhere. The five inert labels are Payments & Receipts, Documents,
// Visa Center, Profile, and Settings.
export function ClientPortalNavItem({ label }: { label: string }) {
  return (
    <li className={styles.navItem}>
      <span className={styles.navItemLabel}>{label}</span>
      <span className={styles.navItemBadge}>Coming soon</span>
    </li>
  );
}
