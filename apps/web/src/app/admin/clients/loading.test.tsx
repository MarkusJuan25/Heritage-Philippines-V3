// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ClientsLoading from './loading';

describe('ClientsLoading', () => {
  it('renders a status-role loading indicator for the Client list and detail routes', () => {
    render(<ClientsLoading />);

    expect(screen.getByRole('heading', { name: 'Clients' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});
