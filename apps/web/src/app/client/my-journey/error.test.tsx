// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import ClientMyJourneyError from './error';

// D-047 §2/§12/§17.5 — the segment error boundary: a <div role="alert">
// with proposal-review-specific recovery copy and an accessible retry
// control; it never renders or logs the `error` object or any sensitive
// detail, and never adds a second <main> landmark.
describe('ClientMyJourneyError', () => {
  it('renders an alert region with proposal-review recovery copy and a working "Try again" control, and no <main>', async () => {
    const reset = vi.fn();
    const { container } = render(
      <ClientMyJourneyError error={new Error('leak-me-uuid-1234')} reset={reset} />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong while loading your proposals to review.');
    expect(container.querySelector('main')).toBeNull();

    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('never surfaces the error object (no message, name, stack, or digest in the DOM)', () => {
    const error = Object.assign(new Error('leak-me-uuid-1234'), { digest: 'digest-abc-999' });
    const { container } = render(<ClientMyJourneyError error={error} reset={vi.fn()} />);

    expect(container.textContent).not.toContain('leak-me-uuid-1234');
    expect(container.textContent).not.toContain('digest-abc-999');
  });
});
