import styles from '../client.module.css';

// D-040 §7: one of the nine later-phase navigation labels. A visible
// plain-text <li> — a <span> label plus a visible <span> reading
// "Coming soon". It has NO `href`, NO `<a>`, NO `<button>`, NO `onClick`,
// NO `tabindex` (not even "-1"), and NO `role`. It is not keyboard-
// focusable and is not described as focusable anywhere. Regional Tours is
// one of these inert items in Stage 6 — there is no link to the V2 public
// tour catalogue.
export function ClientPortalNavItem({ label }: { label: string }) {
  return (
    <li className={styles.navItem}>
      <span className={styles.navItemLabel}>{label}</span>
      <span className={styles.navItemBadge}>Coming soon</span>
    </li>
  );
}
