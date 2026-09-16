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
// D-047 §2 promoted "My Journey", D-049 §7 promoted "Bookings", and D-051
// §10 promotes "Support & Messages" (`/client/support`) — the first
// promotion whose label is NOT immediately adjacent to the already-real
// items in canonical order (four inert labels — Payments & Receipts,
// Documents, Visa Center, Regional Tours — sit between "Bookings" and
// "Support & Messages" in the canonical list). The previous
// two-array-concatenation rendering (`REAL_NAV_ITEMS.map()` then
// `LATER_PHASE_LABELS.map()`) relied on every promoted label already being
// the first remaining element of the inert array, which coincidentally
// preserved order for the first two promotions but can no longer preserve
// "the ten-label set and order... unchanged" (D-051 §10) once a
// non-adjacent label is promoted. This is therefore a single ordered list
// of ten entries, each tagged `real` or `inert`, rendered by one `.map()`
// — interleaving real and inert items in their true canonical position,
// rather than rendering every real item before every inert one. Each real
// item's href-matching-current-path behavior (a non-link
// `<span aria-current="page">` vs. an ordinary in-app `<Link>`) and every
// inert item's rendering (`ClientPortalNavItem`, unchanged) are otherwise
// byte-for-byte the same as before this restructure.
type NavEntry = { kind: 'real'; label: string; href: string } | { kind: 'inert'; label: string };

const NAV_ITEMS: readonly NavEntry[] = [
  { kind: 'real', label: 'Home / Overview', href: '/client' },
  { kind: 'real', label: 'My Journey', href: '/client/my-journey' },
  { kind: 'real', label: 'Bookings', href: '/client/bookings' },
  { kind: 'inert', label: 'Payments & Receipts' },
  { kind: 'inert', label: 'Documents' },
  { kind: 'inert', label: 'Visa Center' },
  { kind: 'inert', label: 'Regional Tours' },
  { kind: 'real', label: 'Support & Messages', href: '/client/support' },
  { kind: 'inert', label: 'Profile' },
  { kind: 'inert', label: 'Settings' },
];

// D-040 §7: the portal navigation collapses into a real mobile drawer
// (toggled by `MobileNavToggle`) — not a shrunk sidebar. The <ul> is
// always in the DOM (so the label set is server-rendered and the
// keyboard-tab walk is stable); CSS shows it inline at >= 48rem and, below
// that, only while `open`. Within this <nav> the focusable controls are the
// mobile toggle and whichever of the four real nav items is not the
// current page; none of the six inert items is focusable.
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
        {NAV_ITEMS.map((item) =>
          item.kind === 'inert' ? (
            <ClientPortalNavItem key={item.label} label={item.label} />
          ) : (
            <li key={item.label} className={styles.navCurrent}>
              {pathname === item.href ? (
                <span className={styles.navCurrentLabel} aria-current="page">
                  {item.label}
                </span>
              ) : (
                <Link className={styles.navLink} href={item.href}>
                  {item.label}
                </Link>
              )}
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
