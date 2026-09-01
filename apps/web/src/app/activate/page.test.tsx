// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import ActivatePage from './page';

// D-038 Section 3: GET /activate is now a fixed, static, tokenless shell
// — it takes no params, performs no lookup, and always renders the
// identical Continue state. There is no server-side "not-found"/
// "eligible" branching left to test here; that coverage now lives
// entirely in ActivationForm.test.tsx, since every token-dependent
// determination has moved client-side.

describe('ActivatePage', () => {
  it('always renders the fixed Continue state, unconditionally', () => {
    const { getByRole } = render(<ActivatePage />);
    expect(getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('renders the activation heading', () => {
    const { getByRole } = render(<ActivatePage />);
    expect(getByRole('heading', { name: 'Activate your account' })).toBeInTheDocument();
  });

  it('never renders any token-shaped substring anywhere in the produced HTML (there is none to render)', () => {
    const { container } = render(<ActivatePage />);
    expect(/[A-Za-z0-9_-]{24}/.test(container.innerHTML)).toBe(false);
  });
});
