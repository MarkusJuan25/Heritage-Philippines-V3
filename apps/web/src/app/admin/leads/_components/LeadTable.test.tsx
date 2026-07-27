// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { LeadRecordWithAssignment } from '@/features/leads/repository';

import { LeadTable } from './LeadTable';

function lead(overrides: Partial<LeadRecordWithAssignment> = {}): LeadRecordWithAssignment {
  return {
    id: 'lead-1',
    status: 'NEW',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: null,
    normalizedEmail: 'juan@example.com',
    normalizedPhone: null,
    source: 'Contact page',
    notes: null,
    clientId: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    assignment: null,
    ...overrides,
  };
}

describe('LeadTable', () => {
  it('links each lead name to its detail page', () => {
    render(<LeadTable items={[lead({ id: 'lead-42', fullName: 'Maria Santos' })]} />);
    const links = screen.getAllByRole('link', { name: 'Maria Santos' });
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/admin/leads/lead-42');
    }
  });

  it('shows "Unassigned" when assignment is null', () => {
    render(<LeadTable items={[lead({ assignment: null })]} />);
    expect(screen.getAllByText('Unassigned').length).toBeGreaterThan(0);
  });

  it('shows the assigned consultant name when assignment is populated (D-023 §5)', () => {
    render(
      <LeadTable items={[lead({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } })]} />,
    );
    expect(screen.getAllByText('Ana Reyes').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Unassigned')).toHaveLength(0);
  });

  it('renders the lead status as a badge label', () => {
    render(<LeadTable items={[lead({ status: 'QUALIFIED' })]} />);
    expect(screen.getAllByText('Qualified').length).toBeGreaterThan(0);
  });

  it('falls back from email to phone, and to an em dash when neither is present', () => {
    render(
      <LeadTable
        items={[
          lead({ id: 'a', email: 'a@example.com', phone: null }),
          lead({ id: 'b', email: null, phone: '639171234567' }),
          lead({ id: 'c', email: null, phone: null }),
        ]}
      />,
    );
    expect(screen.getAllByText('a@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('639171234567').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('exposes a table with column headers for the desktop layout', () => {
    render(<LeadTable items={[lead()]} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Assigned Consultant' })).toBeInTheDocument();
  });
});
