// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ProposalListItem } from '@/features/proposals/repository';

import { ProposalTable } from './ProposalTable';

function proposal(overrides: Partial<ProposalListItem> = {}): ProposalListItem {
  return {
    id: 'proposal-1',
    client: { id: 'client-1', fullName: 'Juan Dela Cruz' },
    createdAt: new Date('2026-07-23T00:00:00Z'),
    updatedAt: new Date('2026-07-23T00:00:00Z'),
    ...overrides,
  };
}

describe('ProposalTable', () => {
  it('links the Client identity to its detail page, in both responsive layouts', () => {
    render(
      <ProposalTable
        items={[proposal({ client: { id: 'client-42', fullName: 'Maria Santos' } })]}
      />,
    );
    const links = screen.getAllByRole('link', { name: 'Maria Santos' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/admin/clients/client-42');
    }
  });

  it('links the Proposal-detail action to its detail page, in both responsive layouts', () => {
    render(<ProposalTable items={[proposal({ id: 'proposal-99' })]} />);
    const links = screen.getAllByRole('link', { name: 'View proposal' });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/admin/proposals/proposal-99');
    }
  });

  // Both responsive layouts (the mobile card list and the desktop table)
  // render simultaneously in jsdom, since CSS media queries never apply
  // there — CSS alone toggles which one is actually visible in a browser.
  // Every assertion below that counts occurrences therefore expects exactly
  // two (one per layout), which is how these tests prove *both* layouts
  // carry the required information, not merely one of them.
  describe('Responsive information parity (the mobile card must carry the same data as the desktop row)', () => {
    it('includes the same creation date, formatted identically, in both responsive layouts', () => {
      const createdAt = new Date('2026-07-23T00:00:00Z');
      render(<ProposalTable items={[proposal({ createdAt })]} />);

      const expectedLabel = createdAt.toLocaleDateString('en-PH');
      expect(screen.getAllByText(expectedLabel)).toHaveLength(2);
    });

    it('includes both the Client link and the Proposal-detail link in each layout', () => {
      render(
        <ProposalTable
          items={[
            proposal({
              id: 'proposal-7',
              client: { id: 'client-7', fullName: 'Ana Reyes' },
            }),
          ]}
        />,
      );

      expect(screen.getAllByRole('link', { name: 'Ana Reyes' })).toHaveLength(2);
      expect(screen.getAllByRole('link', { name: 'View proposal' })).toHaveLength(2);
    });
  });

  describe('Mobile-card labels (dl/dt/dd structure)', () => {
    it('labels each mobile-card value with a visible dt: Created, Proposal', () => {
      const { container } = render(<ProposalTable items={[proposal()]} />);

      // The mobile card's labels are <dt> elements, unique to that layout —
      // the desktop table's equivalent labels are <th scope="col"> column
      // headers, never <dt> — so this proves the mobile card itself carries
      // its own visible labels, not merely that the desktop table does.
      const dtTexts = Array.from(container.querySelectorAll('dt')).map((el) => el.textContent);
      expect(dtTexts).toEqual(['Created', 'Proposal']);
    });
  });

  it('exposes a table with column headers for the desktop layout', () => {
    render(<ProposalTable items={[proposal()]} />);
    expect(screen.getByRole('columnheader', { name: 'Client' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Created' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Proposal' })).toBeInTheDocument();
  });

  it('never renders an invented Proposal title, reference, status, pricing, or content field', () => {
    render(<ProposalTable items={[proposal()]} />);
    expect(screen.queryByRole('columnheader', { name: 'Title' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Reference' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Price' })).not.toBeInTheDocument();
    expect(screen.queryByText(/content/i)).not.toBeInTheDocument();
  });

  it('renders items in exactly the order supplied, without reordering or filtering', () => {
    const items = [
      proposal({ id: 'p1', client: { id: 'c1', fullName: 'Zeta Traveler' } }),
      proposal({ id: 'p2', client: { id: 'c2', fullName: 'Alpha Traveler' } }),
    ];
    const { container } = render(<ProposalTable items={items} />);

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Zeta Traveler');
    expect(rows[1]?.textContent).toContain('Alpha Traveler');

    const cards = Array.from(container.querySelectorAll('ul li'));
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('Zeta Traveler');
    expect(cards[1]?.textContent).toContain('Alpha Traveler');
  });
});
