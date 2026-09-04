// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ProposalSummarySection } from './ProposalSummarySection';

// D-040 §4. Header uses `currentVisibleTotal`; the empty state is keyed on
// `currentVisibleTotal === 0` and reproduced verbatim; the preview list is
// rendered exactly as handed over (already bounded to 5 by Contract C) and
// exposes only `versionNumber` + the mapped `statusLabel`.
const EMPTY_COPY = 'No proposals to review yet. Your travel consultant will prepare one for you.';

describe('ProposalSummarySection', () => {
  it('renders the exact empty-state copy when currentVisibleTotal is 0', () => {
    const { container } = render(
      <ProposalSummarySection proposals={{ currentVisibleTotal: 0, preview: [] }} />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Proposals (0)' })).toBeInTheDocument();
    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(container.querySelector('ul')).toBeNull();
  });

  it('renders the header count from currentVisibleTotal and one row per preview item', () => {
    const { container } = render(
      <ProposalSummarySection
        proposals={{
          currentVisibleTotal: 3,
          preview: [
            { versionNumber: 2, statusLabel: 'Accepted' },
            { versionNumber: 1, statusLabel: 'Awaiting your response' },
          ],
        }}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Proposals (3)' })).toBeInTheDocument();
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Version 2');
    expect(items[0]).toHaveTextContent('Accepted');
    expect(items[1]).toHaveTextContent('Version 1');
    expect(items[1]).toHaveTextContent('Awaiting your response');
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
  });

  it('renders the preview exactly as handed over and never more than the bounded 5 items', () => {
    const preview = Array.from({ length: 5 }, (_unused, i) => ({
      versionNumber: i + 1,
      statusLabel: 'Awaiting your response',
    }));

    const { container } = render(
      <ProposalSummarySection proposals={{ currentVisibleTotal: 42, preview }} />,
    );

    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(container.querySelectorAll('li').length).toBeLessThanOrEqual(5);
  });

  it('exposes no proposal identifier, content, or link', () => {
    const { container } = render(
      <ProposalSummarySection
        proposals={{
          currentVisibleTotal: 1,
          preview: [{ versionNumber: 7, statusLabel: 'Changes requested' }],
        }}
      />,
    );

    expect(container.querySelector('a')).toBeNull();
    const html = container.innerHTML.toLowerCase();
    for (const forbidden of ['proposalid', 'proposal-id', 'versionid', 'acceptanceid', 'content']) {
      expect(html).not.toContain(forbidden);
    }
  });
});
