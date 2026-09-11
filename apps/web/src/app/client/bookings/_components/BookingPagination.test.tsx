// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import { BookingPagination } from './BookingPagination';

// D-049 §4/§7 — ordinary accessible in-app pagination. No database
// identifier in any href; the page-1 link is the bare `/client/bookings`.
describe('BookingPagination', () => {
  it('renders nothing when there is neither a previous nor a next page', () => {
    const { container } = render(
      <BookingPagination page={1} hasPrevious={false} hasNext={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('page 1 with more results shows only a Next link to ?page=2', () => {
    render(<BookingPagination page={1} hasPrevious={false} hasNext />);

    expect(screen.queryByRole('link', { name: 'Previous' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/client/bookings?page=2',
    );
  });

  it('page 2 links Previous to the bare /client/bookings (never ?page=1) and Next to ?page=3', () => {
    render(<BookingPagination page={2} hasPrevious hasNext />);

    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/client/bookings',
    );
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/client/bookings?page=3',
    );
  });

  it('page 3 with no further results shows Previous to ?page=2 and no Next', () => {
    render(<BookingPagination page={3} hasPrevious hasNext={false} />);

    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/client/bookings?page=2',
    );
    expect(screen.queryByRole('link', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('wraps the links in a labelled <nav> and they are real focusable in-app anchors', () => {
    render(<BookingPagination page={2} hasPrevious hasNext />);

    const nav = screen.getByRole('navigation', { name: 'Booking pages' });
    for (const name of ['Previous', 'Next']) {
      const link = screen.getByRole('link', { name });
      expect(nav).toContainElement(link);
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href');
    }
  });
});
