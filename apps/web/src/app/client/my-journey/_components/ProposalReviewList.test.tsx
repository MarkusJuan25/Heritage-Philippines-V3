// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
}));

import type { ClientProposalReviewRender } from '@/features/proposals/service';

import { ProposalReviewList } from './ProposalReviewList';

const PUBLISHED = '2026-09-01T08:00:00.000Z';

function card(versionNumber: number): ClientProposalReviewRender['cards'][number] {
  return {
    versionNumber,
    publishedAt: PUBLISHED,
    content: { available: true, text: `Itinerary v${versionNumber}` },
    response: null,
    statusLabel: 'Awaiting your response',
  };
}

function makeRender(
  overrides: Partial<ClientProposalReviewRender> = {},
): ClientProposalReviewRender {
  return {
    page: 1,
    hasPrevious: false,
    hasNext: false,
    isEmpty: false,
    cards: [card(2), card(1)],
    ...overrides,
  };
}

describe('ProposalReviewList', () => {
  it('renders the global empty state (matching the Home / Overview copy) and nothing else when isEmpty', () => {
    render(<ProposalReviewList render={makeRender({ isEmpty: true, cards: [] })} />);

    expect(
      screen.getByText(
        'No proposals to review yet. Your travel consultant will prepare one for you.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Proposal review pages' }),
    ).not.toBeInTheDocument();
  });

  it('renders one card per DTO card, in the order supplied', () => {
    render(<ProposalReviewList render={makeRender()} />);

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Proposal — Version 2', 'Proposal — Version 1']);
    expect(
      screen.queryByText(
        'No proposals to review yet. Your travel consultant will prepare one for you.',
      ),
    ).not.toBeInTheDocument();
  });

  it('forwards page / hasPrevious / hasNext to the pagination control', () => {
    render(
      <ProposalReviewList render={makeRender({ page: 2, hasPrevious: true, hasNext: true })} />,
    );

    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/client/my-journey',
    );
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/client/my-journey?page=3',
    );
  });

  it('omits pagination entirely for a single page of results', () => {
    render(<ProposalReviewList render={makeRender({ hasPrevious: false, hasNext: false })} />);

    expect(
      screen.queryByRole('navigation', { name: 'Proposal review pages' }),
    ).not.toBeInTheDocument();
  });

  it('passes each responseActions entry to the matching card so every awaiting card renders a form', () => {
    render(<ProposalReviewList render={makeRender()} responseActions={[vi.fn(), vi.fn()]} />);

    expect(screen.getAllByRole('group', { name: /respond to Version/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Submit response' })).toHaveLength(2);
  });

  it('renders no response form when responseActions is omitted', () => {
    const { container } = render(<ProposalReviewList render={makeRender()} />);

    expect(container.querySelector('form')).toBeNull();
  });
});
