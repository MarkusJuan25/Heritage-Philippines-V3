// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import ClientBookingNotFound from './not-found';

// D-049 §7 — one calm, generic state for every controlled absence
// (malformed / nonexistent / DRAFT / foreign-client), revealing neither the
// rejected reference nor the reason, with an accessible link back to the
// list, and no second <main>.
describe('ClientBookingNotFound', () => {
  it('renders a generic "Booking not found" heading and message, with no <main>', () => {
    const { container } = render(<ClientBookingNotFound />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Booking not found' }),
    ).toBeInTheDocument();
    expect(container.querySelector('main')).toBeNull();
  });

  it('never reveals a specific reference or a reason for the absence', () => {
    const { container } = render(<ClientBookingNotFound />);

    expect(container.textContent).not.toMatch(/HPB-/);
    expect(container.textContent?.toLowerCase()).not.toContain('draft');
  });

  it('provides an accessible link back to /client/bookings', () => {
    render(<ClientBookingNotFound />);

    const link = screen.getByRole('link', { name: 'Back to Bookings' });
    expect(link).toHaveAttribute('href', '/client/bookings');
  });
});
