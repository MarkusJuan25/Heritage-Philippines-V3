// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ClientListItem } from '@/features/clients/repository';

import { ClientTable } from './ClientTable';

function client(overrides: Partial<ClientListItem> = {}): ClientListItem {
  return {
    id: 'client-1',
    fullName: 'Juan Dela Cruz',
    email: 'juan@example.com',
    phone: null,
    createdAt: new Date('2026-07-23T00:00:00Z'),
    assignment: null,
    ...overrides,
  };
}

describe('ClientTable', () => {
  it('links each client name to its detail page', () => {
    render(<ClientTable items={[client({ id: 'client-42', fullName: 'Maria Santos' })]} />);
    const links = screen.getAllByRole('link', { name: 'Maria Santos' });
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/admin/clients/client-42');
    }
  });

  it('shows "Unassigned" when assignment is null', () => {
    render(<ClientTable items={[client({ assignment: null })]} />);
    expect(screen.getAllByText('Unassigned').length).toBeGreaterThan(0);
  });

  it('shows the assigned consultant name when assignment is populated', () => {
    render(
      <ClientTable items={[client({ assignment: { staffId: 'tc-1', staffName: 'Ana Reyes' } })]} />,
    );
    expect(screen.getAllByText('Ana Reyes').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Unassigned')).toHaveLength(0);
  });

  // Both responsive layouts (the mobile card list and the desktop table)
  // render simultaneously in jsdom, since CSS media queries never apply
  // there — CSS alone toggles which one is actually visible in a browser.
  // Every assertion below that counts occurrences therefore expects exactly
  // two (one per layout), which is how these tests prove *both* layouts
  // carry the required information, not merely one of them.
  describe('Contact rendering (email and phone are both independently authorized D-025 §3 fields, never collapsed with ??)', () => {
    it('renders both email and phone when both exist, in both responsive layouts', () => {
      render(
        <ClientTable items={[client({ email: 'juan@example.com', phone: '639171234567' })]} />,
      );

      expect(screen.getAllByText('juan@example.com')).toHaveLength(2);
      expect(screen.getAllByText('639171234567')).toHaveLength(2);
      expect(screen.queryByText('—')).not.toBeInTheDocument();
    });

    it('renders only email when only email exists', () => {
      render(<ClientTable items={[client({ email: 'juan@example.com', phone: null })]} />);

      expect(screen.getAllByText('juan@example.com')).toHaveLength(2);
      expect(screen.queryByText('639171234567')).not.toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
    });

    it('renders only phone when only phone exists', () => {
      render(<ClientTable items={[client({ email: null, phone: '639171234567' })]} />);

      expect(screen.getAllByText('639171234567')).toHaveLength(2);
      expect(screen.queryByText('juan@example.com')).not.toBeInTheDocument();
      expect(screen.queryByText('—')).not.toBeInTheDocument();
    });

    it('renders an em dash only when neither email nor phone exists', () => {
      render(<ClientTable items={[client({ email: null, phone: null })]} />);

      expect(screen.getAllByText('—')).toHaveLength(2);
    });

    it('never renders normalizedEmail or normalizedPhone', () => {
      render(<ClientTable items={[client()]} />);

      expect(screen.queryByText(/normalizedEmail/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/normalizedPhone/i)).not.toBeInTheDocument();
    });
  });

  describe('Responsive information parity (the mobile card must carry the same data as the desktop row)', () => {
    it('includes the same created date, formatted identically, in both responsive layouts', () => {
      const createdAt = new Date('2026-07-23T00:00:00Z');
      render(<ClientTable items={[client({ createdAt })]} />);

      const expectedLabel = createdAt.toLocaleDateString('en-PH');
      expect(screen.getAllByText(expectedLabel)).toHaveLength(2);
    });
  });

  describe('Mobile-card labels (dl/dt/dd structure)', () => {
    it('labels each mobile-card value with a visible dt: Contact, Assigned Consultant, Created', () => {
      const { container } = render(<ClientTable items={[client()]} />);

      // The mobile card's labels are <dt> elements, unique to that layout —
      // the desktop table's equivalent labels are <th scope="col"> column
      // headers, never <dt> — so this proves the mobile card itself carries
      // its own visible labels, not merely that the desktop table does.
      const dtTexts = Array.from(container.querySelectorAll('dt')).map((el) => el.textContent);
      expect(dtTexts).toEqual(['Contact', 'Assigned Consultant', 'Created']);
    });
  });

  it('exposes a table with column headers for the desktop layout', () => {
    render(<ClientTable items={[client()]} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Contact' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Assigned Consultant' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument();
  });

  it('never renders a Client status column or badge', () => {
    render(<ClientTable items={[client()]} />);
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
  });
});
