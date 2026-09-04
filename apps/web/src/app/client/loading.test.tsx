// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ClientOverviewLoading from './loading';

// D-040 §7 Loading state — verbatim, and never a nested <main> (the one
// <main> landmark is owned by layout.tsx).
describe('client/loading', () => {
  it('renders exactly the D-040 §7 loading shell', () => {
    const { container } = render(<ClientOverviewLoading />);

    expect(screen.getByRole('heading', { level: 1, name: 'Home / Overview' })).toBeInTheDocument();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading');

    expect(container.querySelector('main')).toBeNull();
  });
});
