// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { LeadStatusBadge } from './LeadStatusBadge';

describe('LeadStatusBadge', () => {
  it('renders the human-readable label for a Lead status, never a raw enum value', () => {
    render(<LeadStatusBadge status="CONSULTATION_SCHEDULED" />);
    expect(screen.getByText('Consultation Scheduled')).toBeInTheDocument();
    expect(screen.queryByText('CONSULTATION_SCHEDULED')).not.toBeInTheDocument();
  });

  it.each([
    ['NEW', 'New'],
    ['UNDER_REVIEW', 'Under Review'],
    ['CONTACTED', 'Contacted'],
    ['QUALIFIED', 'Qualified'],
    ['CONVERTED_TO_CLIENT', 'Converted to Client'],
    ['NOT_PROCEEDING', 'Not Proceeding'],
    ['DUPLICATE', 'Duplicate'],
    ['SPAM', 'Spam'],
    ['ARCHIVED', 'Archived'],
  ] as const)('renders %s as "%s"', (status, label) => {
    render(<LeadStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
