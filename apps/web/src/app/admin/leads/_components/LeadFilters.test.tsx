// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { LeadFilters } from './LeadFilters';

describe('LeadFilters', () => {
  it('renders a native GET form targeting /admin/leads (no client JS required)', () => {
    render(<LeadFilters />);
    const form = screen.getByRole('form', { name: 'Filter leads' });
    expect(form).toHaveAttribute('method', 'GET');
    expect(form).toHaveAttribute('action', '/admin/leads');
  });

  it('has an accessible, labelled search field', () => {
    render(<LeadFilters search="juan" />);
    const search = screen.getByLabelText('Search');
    expect(search).toHaveValue('juan');
    expect(search).toHaveAttribute('name', 'search');
  });

  it('has an accessible, labelled source field', () => {
    render(<LeadFilters source="Contact page" />);
    const source = screen.getByLabelText('Source');
    expect(source).toHaveValue('Contact page');
    expect(source).toHaveAttribute('name', 'source');
  });

  it('lists every LeadStatus value in the status dropdown, plus an All-statuses option', () => {
    render(<LeadFilters status="QUALIFIED" />);
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    expect(select).toHaveValue('QUALIFIED');
    expect(select.querySelectorAll('option')).toHaveLength(11); // 10 statuses + "All statuses"
    expect(screen.getByRole('option', { name: 'Qualified' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All statuses' })).toBeInTheDocument();
  });

  it('defaults every field to blank when no values are supplied', () => {
    render(<LeadFilters />);
    expect(screen.getByLabelText('Search')).toHaveValue('');
    expect(screen.getByLabelText('Source')).toHaveValue('');
    expect(screen.getByLabelText('Status')).toHaveValue('');
  });

  it('provides a submit button and a Clear link back to the unfiltered list', () => {
    render(<LeadFilters status="SPAM" search="x" />);
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clear' })).toHaveAttribute('href', '/admin/leads');
  });

  it('resets Status, Source, and Search to blank when rerendered with no filter props (regression: uncontrolled defaultValue controls must not persist stale values across a Next.js client navigation)', () => {
    const { rerender } = render(<LeadFilters status="NEW" source="Contact page" search="juan" />);
    expect(screen.getByLabelText('Status')).toHaveValue('NEW');
    expect(screen.getByLabelText('Source')).toHaveValue('Contact page');
    expect(screen.getByLabelText('Search')).toHaveValue('juan');

    rerender(<LeadFilters />);

    expect(screen.getByLabelText('Status')).toHaveValue('');
    expect(screen.getByLabelText('Source')).toHaveValue('');
    expect(screen.getByLabelText('Search')).toHaveValue('');
  });
});
