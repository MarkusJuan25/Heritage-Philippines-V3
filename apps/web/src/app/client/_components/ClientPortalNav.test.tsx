// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn(() => '/client') }));
vi.mock('next/navigation', () => ({
  usePathname: usePathnameMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import { ClientPortalNav } from './ClientPortalNav';

// D-040 §7/§9 + D-047 §2 + D-049 §7 + D-051 §10 + D-052 §4. The ten
// canonical labels, verbatim and in order. "Home / Overview" (`/client`),
// "My Journey" (`/client/my-journey`), "Bookings" (`/client/bookings`),
// "Regional Tours" (`/client/regional-tours`), and "Support & Messages"
// (`/client/support`) are active-aware: the current path's label is a
// non-link `<span aria-current="page">`, every other real item is an
// ordinary in-app <Link>. The real items are not contiguous in canonical
// order — three inert labels (Payments & Receipts, Documents, Visa
// Center) sit between "Bookings" and "Regional Tours" (D-051 §10 was the
// first promotion to skip past inert labels), and two more (Profile,
// Settings) follow "Support & Messages" — so the remaining five inert
// items are identified by label set membership, not by a contiguous array
// slice. The inert items remain plain-text (no href / anchor / button /
// onClick / tabindex / role), each showing a visible "Coming soon". The
// focusable controls inside <nav> are the mobile drawer toggle and
// whichever real nav items are not the current page.
const TEN_LABELS = [
  'Home / Overview',
  'My Journey',
  'Bookings',
  'Payments & Receipts',
  'Documents',
  'Visa Center',
  'Regional Tours',
  'Support & Messages',
  'Profile',
  'Settings',
];

const REAL_LABELS = [
  'Home / Overview',
  'My Journey',
  'Bookings',
  'Regional Tours',
  'Support & Messages',
];
const INERT_FIVE = TEN_LABELS.filter((label) => !REAL_LABELS.includes(label));

function getNav() {
  return screen.getByRole('navigation', { name: 'Client portal' });
}

describe('ClientPortalNav', () => {
  beforeEach(() => {
    usePathnameMock.mockReturnValue('/client');
  });

  it('renders one <nav aria-label="Client portal"> wrapping a single <ul> of exactly ten <li> items, in order', () => {
    render(<ClientPortalNav />);

    const nav = getNav();
    const lists = nav.querySelectorAll('ul');
    expect(lists).toHaveLength(1);

    const items = lists[0]!.querySelectorAll('li');
    expect(items).toHaveLength(10);
    expect(
      Array.from(items).map((li) => li.textContent?.replace('Coming soon', '').trim()),
    ).toEqual(TEN_LABELS);
  });

  it('marks the current page ("Home / Overview" on /client) as a non-link <span aria-current="page">', () => {
    render(<ClientPortalNav />);

    const current = screen.getByText('Home / Overview');
    expect(current.tagName).toBe('SPAN');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Home / Overview' })).not.toBeInTheDocument();
  });

  it('renders "My Journey" as a real in-app link to /client/my-journey when it is not the current page', () => {
    render(<ClientPortalNav />);

    const link = screen.getByRole('link', { name: 'My Journey' });
    expect(link).toHaveAttribute('href', '/client/my-journey');
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('renders "Bookings" as a real in-app link to /client/bookings when it is not the current page', () => {
    render(<ClientPortalNav />);

    const link = screen.getByRole('link', { name: 'Bookings' });
    expect(link).toHaveAttribute('href', '/client/bookings');
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('renders "Regional Tours" as a real in-app link to /client/regional-tours when it is not the current page', () => {
    render(<ClientPortalNav />);

    const link = screen.getByRole('link', { name: 'Regional Tours' });
    expect(link).toHaveAttribute('href', '/client/regional-tours');
    expect(link).not.toHaveAttribute('aria-current');
    // The navigation item is never the outbound link: no new-tab or
    // external-link attribute, and no "Coming soon" marker.
    expect(link).not.toHaveAttribute('target');
    expect(link).not.toHaveAttribute('rel');
    expect(link.closest('li')).not.toHaveTextContent('Coming soon');
    // True canonical position — item index 6 of 10.
    expect(link.closest('li')).toBe(Array.from(getNav().querySelectorAll('li'))[6]);
  });

  it('renders "Support & Messages" as a real in-app link to /client/support when it is not the current page', () => {
    render(<ClientPortalNav />);

    const link = screen.getByRole('link', { name: 'Support & Messages' });
    expect(link).toHaveAttribute('href', '/client/support');
    expect(link).not.toHaveAttribute('aria-current');
  });

  it('swaps which label is the current <span> when the path is /client/my-journey', () => {
    usePathnameMock.mockReturnValue('/client/my-journey');
    render(<ClientPortalNav />);

    const current = screen.getByText('My Journey');
    expect(current.tagName).toBe('SPAN');
    expect(current).toHaveAttribute('aria-current', 'page');

    const home = screen.getByRole('link', { name: 'Home / Overview' });
    expect(home).toHaveAttribute('href', '/client');
  });

  it('marks "Support & Messages" as a non-link <span aria-current="page"> when the path is /client/support, in its true canonical position among the other items', () => {
    usePathnameMock.mockReturnValue('/client/support');
    render(<ClientPortalNav />);

    const current = screen.getByText('Support & Messages');
    expect(current.tagName).toBe('SPAN');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Support & Messages' })).not.toBeInTheDocument();

    // Every other real item remains an ordinary link.
    expect(screen.getByRole('link', { name: 'Home / Overview' })).toHaveAttribute(
      'href',
      '/client',
    );
    expect(screen.getByRole('link', { name: 'My Journey' })).toHaveAttribute(
      'href',
      '/client/my-journey',
    );
    expect(screen.getByRole('link', { name: 'Bookings' })).toHaveAttribute(
      'href',
      '/client/bookings',
    );
    expect(screen.getByRole('link', { name: 'Regional Tours' })).toHaveAttribute(
      'href',
      '/client/regional-tours',
    );

    // Still in true canonical position — item index 7 of 10, unaffected by
    // which label happens to be current.
    const items = Array.from(getNav().querySelectorAll('li'));
    expect(items[7]).toBe(current.closest('li'));
  });

  it('marks "Regional Tours" as a non-link <span aria-current="page"> when the path is /client/regional-tours, in its true canonical position among the other items', () => {
    usePathnameMock.mockReturnValue('/client/regional-tours');
    render(<ClientPortalNav />);

    const current = screen.getByText('Regional Tours');
    expect(current.tagName).toBe('SPAN');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Regional Tours' })).not.toBeInTheDocument();

    // Every other real item remains an ordinary link.
    expect(screen.getByRole('link', { name: 'Home / Overview' })).toHaveAttribute(
      'href',
      '/client',
    );
    expect(screen.getByRole('link', { name: 'My Journey' })).toHaveAttribute(
      'href',
      '/client/my-journey',
    );
    expect(screen.getByRole('link', { name: 'Bookings' })).toHaveAttribute(
      'href',
      '/client/bookings',
    );
    expect(screen.getByRole('link', { name: 'Support & Messages' })).toHaveAttribute(
      'href',
      '/client/support',
    );
    expect(screen.getAllByRole('link')).toHaveLength(4);

    // The current item is not focusable: the toggle plus the four other
    // real links are the only focusable controls.
    expect(current.closest('li')?.querySelector('a[href], button, [tabindex]')).toBeNull();
    expect(
      getNav().querySelectorAll('a[href], button, [tabindex], input, select, textarea'),
    ).toHaveLength(5);

    // Still in true canonical position — item index 6 of 10, unaffected by
    // which label happens to be current.
    const items = Array.from(getNav().querySelectorAll('li'));
    expect(items[6]).toBe(current.closest('li'));
  });

  it('never renders more than one aria-current="page" element, whatever the path', () => {
    for (const path of [
      '/client',
      '/client/my-journey',
      '/client/support',
      '/client/regional-tours',
      '/client/unknown',
    ]) {
      usePathnameMock.mockReturnValue(path);
      const { unmount } = render(<ClientPortalNav />);
      expect(getNav().querySelectorAll('[aria-current="page"]')).toHaveLength(
        path === '/client/unknown' ? 0 : 1,
      );
      unmount();
    }
  });

  it('renders the remaining five later-phase items as inert plain text: no href/anchor/button/tabindex/role, each with a visible "Coming soon"', () => {
    render(<ClientPortalNav />);

    const items = Array.from(getNav().querySelectorAll('li'));
    const inert = items.filter(
      (li) => !REAL_LABELS.includes(li.textContent?.replace('Coming soon', '').trim() ?? ''),
    );
    expect(inert).toHaveLength(5);
    expect(inert.map((li) => li.textContent?.replace('Coming soon', '').trim())).toEqual(
      INERT_FIVE,
    );

    for (const li of inert) {
      expect(li.querySelector('a')).toBeNull();
      expect(li.querySelector('button')).toBeNull();
      expect(li.hasAttribute('role')).toBe(false);
      expect(li.hasAttribute('tabindex')).toBe(false);
      expect(li.hasAttribute('onclick')).toBe(false);
      for (const span of Array.from(li.querySelectorAll('span'))) {
        expect(span.hasAttribute('role')).toBe(false);
        expect(span.hasAttribute('tabindex')).toBe(false);
      }
      expect(li).toHaveTextContent('Coming soon');
    }
  });

  it('exposes exactly four nav links — every real item that is not the current page', () => {
    render(<ClientPortalNav />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(links.map((link) => link.textContent)).toEqual([
      'My Journey',
      'Bookings',
      'Regional Tours',
      'Support & Messages',
    ]);
  });

  it('exposes exactly five focusable controls inside <nav> — the mobile toggle and the four non-current nav links', () => {
    render(<ClientPortalNav />);

    const focusables = getNav().querySelectorAll(
      'a[href], button, [tabindex], input, select, textarea',
    );
    expect(focusables).toHaveLength(5);
    expect(
      Array.from(focusables)
        .map((el) => el.tagName)
        .sort(),
    ).toEqual(['A', 'A', 'A', 'A', 'BUTTON']);
    expect(screen.getByRole('button', { name: 'Client portal menu' })).toBeInTheDocument();
  });

  it('a keyboard-tab walk of the nav reaches the mobile toggle then each non-current link in canonical order, then leaves', async () => {
    render(<ClientPortalNav />);
    const user = userEvent.setup();

    const toggle = screen.getByRole('button', { name: 'Client portal menu' });
    const myJourneyLink = screen.getByRole('link', { name: 'My Journey' });
    const bookingsLink = screen.getByRole('link', { name: 'Bookings' });
    const regionalToursLink = screen.getByRole('link', { name: 'Regional Tours' });
    const supportLink = screen.getByRole('link', { name: 'Support & Messages' });

    await user.tab();
    expect(toggle).toHaveFocus();

    await user.tab();
    expect(myJourneyLink).toHaveFocus();

    await user.tab();
    expect(bookingsLink).toHaveFocus();

    await user.tab();
    expect(regionalToursLink).toHaveFocus();

    await user.tab();
    expect(supportLink).toHaveFocus();

    await user.tab();
    expect(supportLink).not.toHaveFocus();
    expect(toggle).not.toHaveFocus();
  });

  it('the mobile toggle discloses/hides the nav list (aria-expanded reflects state)', async () => {
    render(<ClientPortalNav />);
    const user = userEvent.setup();

    const toggle = screen.getByRole('button', { name: 'Client portal menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
