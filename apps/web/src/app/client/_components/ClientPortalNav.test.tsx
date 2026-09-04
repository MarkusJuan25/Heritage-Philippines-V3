// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ClientPortalNav } from './ClientPortalNav';

// D-040 §7/§9. The ten canonical labels, verbatim and in order. Only
// "Home / Overview" is marked current (a non-link <span aria-current>); the
// other nine are inert plain-text items (no href / anchor / button /
// onClick / tabindex / role) each showing a visible "Coming soon". The
// only genuine control inside <nav> is the mobile drawer toggle.
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

function getNav() {
  return screen.getByRole('navigation', { name: 'Client portal' });
}

describe('ClientPortalNav', () => {
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

  it('marks "Home / Overview" as the current page via a non-link <span aria-current="page">', () => {
    render(<ClientPortalNav />);

    const current = screen.getByText('Home / Overview');
    expect(current.tagName).toBe('SPAN');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.closest('a')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Home / Overview' })).not.toBeInTheDocument();
  });

  it('renders the nine later-phase items as inert plain text: no href/anchor/button/tabindex/role, each with a visible "Coming soon"', () => {
    render(<ClientPortalNav />);

    const items = Array.from(getNav().querySelectorAll('li'));
    const laterPhase = items.slice(1); // everything after "Home / Overview"
    expect(laterPhase).toHaveLength(9);

    for (const li of laterPhase) {
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

    // No item is a link anywhere in the nav (there is no genuine nav link in Stage 6).
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('exposes exactly one focusable control inside <nav> — the mobile toggle — and nothing else', () => {
    render(<ClientPortalNav />);

    const focusables = getNav().querySelectorAll(
      'a[href], button, [tabindex], input, select, textarea',
    );
    expect(focusables).toHaveLength(1);
    expect(focusables[0]!.tagName).toBe('BUTTON');
    expect(focusables[0]!).toHaveAccessibleName('Client portal menu');
  });

  it('a keyboard-tab walk of the nav reaches only the mobile toggle', async () => {
    render(<ClientPortalNav />);
    const user = userEvent.setup();

    const toggle = screen.getByRole('button', { name: 'Client portal menu' });

    await user.tab();
    expect(toggle).toHaveFocus();

    await user.tab();
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
