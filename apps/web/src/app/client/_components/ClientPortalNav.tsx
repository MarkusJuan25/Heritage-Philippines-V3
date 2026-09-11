'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { ClientPortalNavItem } from './ClientPortalNavItem';
import { CLIENT_PORTAL_NAV_LIST_ID, MobileNavToggle } from './MobileNavToggle';
import styles from '../client.module.css';

// D-040 §7 / blueprint §2.3 — the ten canonical client-portal navigation
// labels, verbatim and in this exact order:
//   Home / Overview · My Journey · Bookings · Payments & Receipts ·
//   Documents · Visa Center · Regional Tours · Support & Messages ·
//   Profile · Settings
//
// D-047 §2 promoted the previously-inert "My Journey" label to a real
// in-app link, and D-049 §7 does the same for "Bookings" (`/client/bookings`).
// There are now three real client-portal routes sharing this nav, so
// "Home / Overview" (`/client`), "My Journey", and "Bookings" are each
// rendered active-aware: the label whose href matches the current path is
// a non-link `<span aria-current="page">` (D-040 §7's "not a link to
// itself"), and every other real item is an ordinary in-app `<Link>` — so
// there is exactly one `aria-current="page"` at any time. No new
// "Proposals" label is added and the ten-label set/order is unchanged.
// The remaining seven later-phase labels stay inert `ClientPortalNavItem`s
// (visible text plus a "Coming soon" marker; no href / anchor / button /
// onClick / tabindex / role).
const REAL_NAV_ITEMS = [
  { label: 'Home / Overview', href: '/client' },
  { label: 'My Journey', href: '/client/my-journey' },
  { label: 'Bookings', href: '/client/bookings' },
] as const;

const LATER_PHASE_LABELS = [
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
// that, only while `open`. Within this <nav> the focusable controls are the
// mobile toggle and whichever of the two real nav items is not the current
// page; none of the eight inert items is focusable.
export function ClientPortalNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <nav aria-label="Client portal" className={styles.nav}>
      <MobileNavToggle open={open} onToggle={() => setOpen((value) => !value)} />
      <ul
        id={CLIENT_PORTAL_NAV_LIST_ID}
        className={open ? `${styles.navList} ${styles.navListOpen}` : styles.navList}
      >
        {REAL_NAV_ITEMS.map(({ label, href }) => (
          <li key={label} className={styles.navCurrent}>
            {pathname === href ? (
              <span className={styles.navCurrentLabel} aria-current="page">
                {label}
              </span>
            ) : (
              <Link className={styles.navLink} href={href}>
                {label}
              </Link>
            )}
          </li>
        ))}
        {LATER_PHASE_LABELS.map((label) => (
          <ClientPortalNavItem key={label} label={label} />
        ))}
      </ul>
    </nav>
  );
}
