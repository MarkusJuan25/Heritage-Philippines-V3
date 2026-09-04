// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import ClientOverviewError from './error';

// D-040 §7 Error / retry state — verbatim. A <div role="alert">, never a
// nested <main>; a native "Try again" button wired to `reset`. The `error`
// object is never rendered (it must not expose any internal detail).
describe('client/error', () => {
  it('renders the alert region with the exact generic message and no <main>', () => {
    const { container } = render(
      <ClientOverviewError error={new Error('boom-internal-detail')} reset={vi.fn()} />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong while loading your overview.');
    expect(container.querySelector('main')).toBeNull();

    // The underlying error text is never surfaced.
    expect(alert).not.toHaveTextContent('boom-internal-detail');
    expect(container.innerHTML).not.toContain('boom-internal-detail');
  });

  it('renders a native "Try again" button that calls reset', async () => {
    const reset = vi.fn();
    render(<ClientOverviewError error={new Error('x')} reset={reset} />);

    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button).toHaveAttribute('type', 'button');

    await userEvent.click(button);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
