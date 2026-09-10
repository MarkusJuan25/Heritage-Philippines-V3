// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ClientMyJourneyLoading from './loading';

// D-047 §12 — the loading state is a plain <div> with the page's <h1> and a
// role="status" indicator. It must never add a second <main> landmark (the
// one <main> is client/layout.tsx's).
describe('ClientMyJourneyLoading', () => {
  it('renders the "My Journey" heading and a role="status" loading indicator, with no <main>', () => {
    const { container } = render(<ClientMyJourneyLoading />);

    expect(screen.getByRole('heading', { level: 1, name: 'My Journey' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(container.querySelector('main')).toBeNull();
  });
});
