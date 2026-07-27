// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { LeadStatusHistoryRow } from '@/features/leads/repository';

import { StatusHistoryTimeline } from './StatusHistoryTimeline';

function historyRow(overrides: Partial<LeadStatusHistoryRow> = {}): LeadStatusHistoryRow {
  return {
    id: 'history-1',
    previousStatus: 'NEW',
    newStatus: 'UNDER_REVIEW',
    changedByUserId: 'actor-1',
    changedByName: 'Admin Manager',
    createdAt: new Date('2026-07-23T00:00:00Z'),
    ...overrides,
  };
}

describe('StatusHistoryTimeline', () => {
  it('renders an empty-state message when there is no history', () => {
    render(<StatusHistoryTimeline items={[]} />);
    expect(screen.getByText('No status history yet.')).toBeInTheDocument();
  });

  it('renders a previousStatus -> newStatus transition', () => {
    render(
      <StatusHistoryTimeline
        items={[historyRow({ previousStatus: 'NEW', newStatus: 'QUALIFIED' })]}
      />,
    );
    expect(screen.getByText(/New/)).toBeInTheDocument();
    expect(screen.getByText(/Qualified/)).toBeInTheDocument();
  });

  it('renders the initial creation row (previousStatus: null) distinctly', () => {
    render(
      <StatusHistoryTimeline items={[historyRow({ previousStatus: null, newStatus: 'NEW' })]} />,
    );
    expect(screen.getByText('Created as New')).toBeInTheDocument();
  });

  it('shows the actor name when present', () => {
    render(<StatusHistoryTimeline items={[historyRow({ changedByName: 'Maria Santos' })]} />);
    expect(screen.getByText(/Maria Santos/)).toBeInTheDocument();
  });

  it('falls back to a generic label when changedByName is null', () => {
    render(<StatusHistoryTimeline items={[historyRow({ changedByName: null })]} />);
    expect(screen.getByText(/Unknown staff member/)).toBeInTheDocument();
  });

  it('never renders a reason field (D-023 §8 — LeadStatusHistory has no reason column)', () => {
    const { container } = render(<StatusHistoryTimeline items={[historyRow()]} />);
    expect(container.textContent).not.toMatch(/reason/i);
  });

  it('renders multiple entries in the given order', () => {
    render(
      <StatusHistoryTimeline
        items={[
          historyRow({ id: 'h2', previousStatus: 'NEW', newStatus: 'QUALIFIED' }),
          historyRow({ id: 'h1', previousStatus: null, newStatus: 'NEW' }),
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Qualified');
    expect(items[1]).toHaveTextContent('Created as New');
  });
});
