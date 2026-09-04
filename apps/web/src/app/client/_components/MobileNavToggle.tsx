'use client';

import styles from '../client.module.css';

// D-040 §7: the mobile navigation drawer is opened by a genuine <button>
// with an accessible name (`aria-label`) and `aria-expanded`. It — with
// the sign-out button — is one of the only two genuine controls in the
// portal chrome that enter the tab order. `aria-controls` points at the
// nav list it discloses. The visible text "Menu" is contained within the
// accessible name (WCAG 2.5.3).
export const CLIENT_PORTAL_NAV_LIST_ID = 'client-portal-nav-list';

export function MobileNavToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={styles.navToggle}
      aria-label="Client portal menu"
      aria-expanded={open}
      aria-controls={CLIENT_PORTAL_NAV_LIST_ID}
      onClick={onToggle}
    >
      Menu
    </button>
  );
}
