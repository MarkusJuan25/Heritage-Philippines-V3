// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ConsultantCard } from './ConsultantCard';

// D-040 §7: two runtime branches keyed solely on whether Contract F
// returned an assigned consultant name. Both support-guidance strings are
// reproduced verbatim here and must match the component exactly. No
// fabricated support route, email, phone, form, or link anywhere.
const SUPPORT_WITH_NAME =
  'Support & Messages is planned for a later phase. Until then, Maria Santos, your Heritage Philippines travel consultant, is your point of contact.';
const SUPPORT_NO_NAME =
  'Support & Messages is planned for a later phase. Until then, your Heritage Philippines travel team is your point of contact.';
const TEAM_FALLBACK = 'Your Heritage Philippines travel team.';

describe('ConsultantCard', () => {
  it('assigned-consultant branch: shows the name only and interpolates it into the support-guidance line', () => {
    render(<ConsultantCard consultant={{ name: 'Maria Santos' }} />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Your travel consultant' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Maria Santos')).toBeInTheDocument();
    expect(screen.getByText(SUPPORT_WITH_NAME)).toBeInTheDocument();

    // The generic team sentence must not also appear in this branch.
    expect(screen.queryByText(SUPPORT_NO_NAME)).not.toBeInTheDocument();
    expect(screen.queryByText(TEAM_FALLBACK)).not.toBeInTheDocument();
  });

  it('no-assignment branch: shows the exact travel-team line and the generic support-guidance sentence', () => {
    render(<ConsultantCard consultant={null} />);

    expect(screen.getByText(TEAM_FALLBACK)).toBeInTheDocument();
    expect(screen.getByText(SUPPORT_NO_NAME)).toBeInTheDocument();
    expect(screen.queryByText(SUPPORT_WITH_NAME)).not.toBeInTheDocument();
  });

  it('fabricates no support route, email address, telephone number, form, or link', () => {
    const { container: withName } = render(
      <ConsultantCard consultant={{ name: 'Rick Dela Peña' }} />,
    );
    const { container: noName } = render(<ConsultantCard consultant={null} />);

    for (const container of [withName, noName]) {
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('form')).toBeNull();
      const html = container.innerHTML.toLowerCase();
      expect(html).not.toContain('mailto:');
      expect(html).not.toContain('tel:');
      expect(html).not.toContain('http://');
      expect(html).not.toContain('https://');
    }
  });
});
