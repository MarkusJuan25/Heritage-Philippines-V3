// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ClientPaymentsError from './error';
import ClientPaymentsLoading from './loading';

describe('ClientPaymentsError', () => {
  it('shows a generic message with a retry and a support path, never the error detail', () => {
    const reset = vi.fn();
    render(
      <ClientPaymentsError error={new Error('connection to db-host refused')} reset={reset} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Something went wrong while loading your payments.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('db-host');
    expect(screen.getByRole('link', { name: 'Support & Messages' })).toHaveAttribute(
      'href',
      '/client/support',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('ClientPaymentsLoading', () => {
  it('shows the page heading and a loading status', () => {
    render(<ClientPaymentsLoading />);
    expect(screen.getByRole('heading', { name: 'Payments & Receipts' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });
});
