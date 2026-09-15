// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { JourneyProgressSection } from './JourneyProgressSection';

// D-050 §§4, 6. The component renders the two DTO `sentence` strings
// verbatim (produced by `getClientJourneyProgress`) — `progressLine`
// always, `proposalLine` only when non-null. It never renders the raw
// `state` enum and never paraphrases. Mirrors TravelStatusSection.test.tsx.
describe('JourneyProgressSection', () => {
  it('renders the "Your travel status" heading and always renders the progressLine sentence', () => {
    render(
      <JourneyProgressSection
        progress={{
          proposalLine: null,
          progressLine: {
            state: 'AWAITING_FIRST_PROPOSAL',
            sentence: "We're preparing your first proposal.",
          },
        }}
      />,
    );

    expect(
      screen.getByRole('heading', { level: 2, name: 'Your travel status' }),
    ).toBeInTheDocument();
    expect(screen.getByText("We're preparing your first proposal.")).toBeInTheDocument();
  });

  it('renders the proposalLine sentence above the progressLine sentence when proposalLine is non-null', () => {
    const { container } = render(
      <JourneyProgressSection
        progress={{
          proposalLine: {
            state: 'PROPOSALS_AWAITING_YOU',
            sentence: 'You have 2 proposals waiting for your response.',
          },
          progressLine: {
            state: 'BOOKING_CONFIRMED',
            sentence: 'At least one booking is confirmed.',
          },
        }}
      />,
    );

    const paragraphs = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
    expect(paragraphs).toEqual([
      'You have 2 proposals waiting for your response.',
      'At least one booking is confirmed.',
    ]);
  });

  it('omits the proposalLine entirely when it is null (only one sentence renders)', () => {
    const { container } = render(
      <JourneyProgressSection
        progress={{
          proposalLine: null,
          progressLine: {
            state: 'TRIP_COMPLETED',
            sentence: 'You have a completed trip in your travel history.',
          },
        }}
      />,
    );

    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(
      screen.getByText('You have a completed trip in your travel history.'),
    ).toBeInTheDocument();
  });

  it('never renders the raw state enum token as visible text', () => {
    const { container } = render(
      <JourneyProgressSection
        progress={{
          proposalLine: {
            state: 'RESPONSE_RECORDED',
            sentence: "We've recorded your response to your proposal.",
          },
          progressLine: {
            state: 'NO_ACTIVE_BOOKING',
            sentence:
              "You don't have an active booking right now. Your travel consultant can help with next steps.",
          },
        }}
      />,
    );

    expect(container.textContent).not.toContain('RESPONSE_RECORDED');
    expect(container.textContent).not.toContain('NO_ACTIVE_BOOKING');
  });
});
