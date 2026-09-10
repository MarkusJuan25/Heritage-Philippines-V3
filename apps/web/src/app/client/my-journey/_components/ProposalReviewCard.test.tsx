// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ClientProposalReviewCard as ClientProposalReviewCardDto } from '@/features/proposals/service';

import { ProposalReviewCard } from './ProposalReviewCard';

const PUBLISHED = '2026-09-01T08:00:00.000Z';
const RESPONDED = '2026-09-04T10:15:00.000Z';

function makeCard(
  overrides: Partial<ClientProposalReviewCardDto> = {},
): ClientProposalReviewCardDto {
  return {
    versionNumber: 2,
    publishedAt: PUBLISHED,
    content: { available: true, text: 'Day 1: Arrival in Cebu.\nDay 2: Island hopping.' },
    response: null,
    statusLabel: 'Awaiting your response',
    ...overrides,
  };
}

describe('ProposalReviewCard', () => {
  it('renders an <article> with an accessible heading naming the version, and the content in a labelled region', () => {
    render(<ProposalReviewCard card={makeCard()} index={0} />);

    const article = screen.getByRole('article', { name: 'Proposal — Version 2' });
    expect(within(article).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Proposal — Version 2',
    );
    expect(within(article).getByText('Shared with you on 1 September 2026')).toBeInTheDocument();

    const region = within(article).getByRole('region', { name: 'Proposal version 2 details' });
    expect(region).toHaveTextContent('Day 1: Arrival in Cebu.');
    expect(region).toHaveTextContent('Day 2: Island hopping.');
  });

  it('awaiting state without an action: shows the status label only, no form', () => {
    const { container } = render(<ProposalReviewCard card={makeCard()} index={0} />);

    expect(screen.getByText('Awaiting your response')).toBeInTheDocument();
    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('awaiting state with an action: renders the response form alongside the status label', () => {
    render(<ProposalReviewCard card={makeCard()} index={0} action={vi.fn()} />);

    expect(screen.getByText('Awaiting your response')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /respond to Version 2/ })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(
      screen.getByRole('checkbox', {
        name: 'I understand this response is final for this proposal version.',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit response' })).toBeInTheDocument();
  });

  it('never renders a form for a responded or content-unavailable card, even when an action is provided', () => {
    const responded = render(
      <ProposalReviewCard
        card={makeCard({ response: { responseType: 'ACCEPT', respondedAt: RESPONDED } })}
        index={0}
        action={vi.fn()}
      />,
    );
    expect(responded.container.querySelector('form')).toBeNull();
    responded.unmount();

    const unavailable = render(
      <ProposalReviewCard
        card={makeCard({ content: { available: false } })}
        index={0}
        action={vi.fn()}
      />,
    );
    expect(unavailable.container.querySelector('form')).toBeNull();
  });

  it('responded state: shows an unchangeable read-only summary for each response type and no form', () => {
    const cases: Array<[NonNullable<ClientProposalReviewCardDto['response']>, string]> = [
      [
        { responseType: 'ACCEPT', respondedAt: RESPONDED },
        "You accepted this on 4 September 2026. This response can't be changed for this version.",
      ],
      [
        { responseType: 'DECLINE', respondedAt: RESPONDED },
        "You declined this on 4 September 2026. This response can't be changed for this version.",
      ],
      [
        { responseType: 'REQUEST_CHANGES', respondedAt: RESPONDED },
        "You requested changes to this on 4 September 2026. This response can't be changed for this version.",
      ],
    ];

    for (const [response, expected] of cases) {
      const { container, unmount } = render(
        <ProposalReviewCard card={makeCard({ response, statusLabel: 'Accepted' })} index={0} />,
      );
      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(screen.queryByText('Awaiting your response')).not.toBeInTheDocument();
      expect(container.querySelector('form')).toBeNull();
      unmount();
    }
  });

  it('legacy null content: an explicit "Content unavailable" state pointing to the consultant, with no form and no Support link', () => {
    const { container } = render(
      <ProposalReviewCard
        card={makeCard({ content: { available: false }, statusLabel: 'Awaiting your response' })}
        index={0}
      />,
    );

    expect(
      screen.getByText(
        'Content unavailable. Please contact your Heritage Philippines travel consultant.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /details/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting your response')).not.toBeInTheDocument();
    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders markup-looking content as literal plain text — never interpreted or executed (§11)', () => {
    const canary = '<script>window.__pwned = 1</script> **not bold** <img src=x onerror=alert(1)>';
    const { container } = render(
      <ProposalReviewCard
        card={makeCard({ content: { available: true, text: canary } })}
        index={0}
      />,
    );

    expect(screen.getByText(canary)).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
