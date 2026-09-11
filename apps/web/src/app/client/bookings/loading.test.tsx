// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ClientBookingsLoading from './loading';

describe('ClientBookingsLoading', () => {
  it('renders the "Bookings" heading and a role="status" loading indicator, with no <main>', () => {
    const { container } = render(<ClientBookingsLoading />);

    expect(screen.getByRole('heading', { level: 1, name: 'Bookings' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(container.querySelector('main')).toBeNull();
  });
});
