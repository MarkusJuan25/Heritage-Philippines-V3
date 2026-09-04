// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { IdentityCard } from './IdentityCard';

// D-040 §7/§8: the identity <dl> shows the client's own fullName / email /
// phone — and nothing else. No id, userId, normalized contact, address,
// nationality, DOB, emergency contact, notes, or timestamp exists on this
// DTO type; these tests additionally pin the label set so a forbidden
// field could never be added silently.
describe('IdentityCard', () => {
  it('renders name, email and phone in a definition list', () => {
    const { container } = render(
      <IdentityCard
        identity={{
          fullName: 'Juan Dela Cruz',
          email: 'juan@example.com',
          phone: '+63 900 000 0000',
        }}
      />,
    );

    const dl = container.querySelector('dl');
    expect(dl).not.toBeNull();

    const terms = Array.from(container.querySelectorAll('dt')).map((dt) => dt.textContent);
    expect(terms).toEqual(['Name', 'Email', 'Phone']);

    expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
    expect(screen.getByText('juan@example.com')).toBeInTheDocument();
    expect(screen.getByText('+63 900 000 0000')).toBeInTheDocument();
  });

  it('renders an explicit placeholder — never a fabricated value — for a null email or phone', () => {
    const { container } = render(
      <IdentityCard identity={{ fullName: 'Solo Name', email: null, phone: null }} />,
    );

    const values = Array.from(container.querySelectorAll('dd')).map((dd) => dd.textContent);
    expect(values).toEqual(['Solo Name', '—', '—']);
  });

  it('renders no field beyond the three allowed identity values (no id / userId / notes / address)', () => {
    const { container } = render(
      <IdentityCard identity={{ fullName: 'Ana Reyes', email: 'ana@example.com', phone: null }} />,
    );

    // Exactly three term/value pairs, nothing else.
    expect(container.querySelectorAll('dt')).toHaveLength(3);
    expect(container.querySelectorAll('dd')).toHaveLength(3);

    const html = container.innerHTML.toLowerCase();
    for (const forbidden of [
      'clientid',
      'userid',
      'client id',
      'profile',
      'notes',
      'address',
      'nationality',
      'date of birth',
      'emergency',
      'normalized',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
