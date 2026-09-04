'use client';

import { useState } from 'react';

import { ClientPortalNavItem } from './ClientPortalNavItem';
import { CLIENT_PORTAL_NAV_LIST_ID, MobileNavToggle } from './MobileNavToggle';
import styles from '../client.module.css';

// D-040 §7 / blueprint §2.3 — the ten canonical client-portal navigation
// labels, verbatim and in this exact order. "Home / Overview" (the current
// page, and the only real page in Stage 6) is a non-link
// `<span aria-current="page">`; the other nine are inert
// `ClientPortalNavItem`s (visible text + a "Coming soon" marker, no href /
// anchor / button / onClick / tabindex / role).
const LATER_PHASE_LABELS = [
  'My Journey',
  'Bookings',
  'Payments & Receipts',
  'Documents',
  'Visa Center',
  'Regional Tours',
  'Support & Messages',
  'Profile',
  'Settings',
] as const;

// D-040 §7: the portal navigation collapses into a real mobile drawer
// (toggled by `MobileNavToggle`) — not a shrunk sidebar. The <ul> is
// always in the DOM (so the label set is server-rendered and the
// keyboard-tab walk is stable); CSS shows it inline at >= 48rem and, below
// that, only while `open`. Only the toggle is focusable within this <nav>;
// none of the ten items is.
export function ClientPortalNav() {
  const [open, setOpen] = useState(false);

  return (
    <nav aria-label="Client portal" className={styles.nav}>
      <MobileNavToggle open={open} onToggle={() => setOpen((value) => !value)} />
      <ul
        id={CLIENT_PORTAL_NAV_LIST_ID}
        className={open ? `${styles.navList} ${styles.navListOpen}` : styles.navList}
      >
        <li className={styles.navCurrent}>
          <span className={styles.navCurrentLabel} aria-current="page">
            Home / Overview
          </span>
        </li>
        {LATER_PHASE_LABELS.map((label) => (
          <ClientPortalNavItem key={label} label={label} />
        ))}
      </ul>
    </nav>
  );
}
