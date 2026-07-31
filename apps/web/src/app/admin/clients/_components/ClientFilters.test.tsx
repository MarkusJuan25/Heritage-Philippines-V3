// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ClientFilters } from './ClientFilters';

describe('ClientFilters', () => {
  it('renders a native GET form targeting /admin/clients (no client JS required)', () => {
    render(<ClientFilters />);
    const form = screen.getByRole('form', { name: 'Filter clients' });
    expect(form).toHaveAttribute('method', 'GET');
    expect(form).toHaveAttribute('action', '/admin/clients');
  });

  it('has an accessible, labelled search field', () => {
    render(<ClientFilters search="juan" />);
    const search = screen.getByLabelText('Search');
    expect(search).toHaveValue('juan');
    expect(search).toHaveAttribute('name', 'search');
  });

  it('defaults the search field to blank when no value is supplied', () => {
    render(<ClientFilters />);
    expect(screen.getByLabelText('Search')).toHaveValue('');
  });

  it('provides a submit button and a Clear link back to the unfiltered list', () => {
    render(<ClientFilters search="x" />);
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear' })).toHaveAttribute('href', '/admin/clients');
  });

  it('resets Search to blank when rerendered with no filter props (regression: uncontrolled defaultValue must not persist stale values across a Next.js client navigation)', () => {
    const { rerender } = render(<ClientFilters search="juan" />);
    expect(screen.getByLabelText('Search')).toHaveValue('juan');

    rerender(<ClientFilters />);

    expect(screen.getByLabelText('Search')).toHaveValue('');
  });

  it('exposes only a search field — no status, source, or assignment controls (D-025 §1/§3)', () => {
    render(<ClientFilters search="juan" />);
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Source')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Assignment')).not.toBeInTheDocument();
  });
});
