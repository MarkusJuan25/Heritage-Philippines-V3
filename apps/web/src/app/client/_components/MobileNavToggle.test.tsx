// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { CLIENT_PORTAL_NAV_LIST_ID, MobileNavToggle } from './MobileNavToggle';

// D-040 §7: a genuine <button> with an accessible name (`aria-label`) and
// `aria-expanded`. One of the only two genuine controls in the portal
// chrome that enter the tab order.
describe('MobileNavToggle', () => {
  it('is a native button with an accessible name, aria-expanded, and aria-controls', () => {
    render(<MobileNavToggle open={false} onToggle={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Client portal menu' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', CLIENT_PORTAL_NAV_LIST_ID);
    // Visible text is contained within the accessible name (WCAG 2.5.3).
    expect(button).toHaveTextContent('Menu');
  });

  it('reflects the open state in aria-expanded', () => {
    render(<MobileNavToggle open onToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Client portal menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('calls onToggle when activated', async () => {
    const onToggle = vi.fn();
    render(<MobileNavToggle open={false} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole('button', { name: 'Client portal menu' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
