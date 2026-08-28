// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const serviceMocks = vi.hoisted(() => ({ getActivationPageState: vi.fn() }));
vi.mock('@/features/activation/service', () => serviceMocks);

import ActivatePage from './page';

const VALID_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1L2';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActivatePage', () => {
  it('renders the generic invalid state and never calls the service for a malformed token', async () => {
    const ui = await ActivatePage({ params: Promise.resolve({ token: 'not-a-valid-token' }) });
    const { container } = render(ui);

    expect(container.textContent).toContain('This invitation link is no longer valid.');
    expect(serviceMocks.getActivationPageState).not.toHaveBeenCalled();
  });

  it('renders the generic invalid state for a well-formed but not-found/ineligible token', async () => {
    serviceMocks.getActivationPageState.mockResolvedValue('not-found');
    const ui = await ActivatePage({ params: Promise.resolve({ token: VALID_TOKEN }) });
    const { container } = render(ui);

    expect(container.textContent).toContain('This invitation link is no longer valid.');
  });

  it('renders the Continue button for eligible-not-opened', async () => {
    serviceMocks.getActivationPageState.mockResolvedValue('eligible-not-opened');
    const ui = await ActivatePage({ params: Promise.resolve({ token: VALID_TOKEN }) });
    const { getByRole } = render(ui);

    expect(getByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });

  it('renders the password form directly for eligible-opened', async () => {
    serviceMocks.getActivationPageState.mockResolvedValue('eligible-opened');
    const ui = await ActivatePage({ params: Promise.resolve({ token: VALID_TOKEN }) });
    const { getByLabelText } = render(ui);

    expect(getByLabelText('Password')).toBeInTheDocument();
  });

  it('never renders the raw token substring anywhere in the produced HTML', async () => {
    serviceMocks.getActivationPageState.mockResolvedValue('eligible-not-opened');
    const ui = await ActivatePage({ params: Promise.resolve({ token: VALID_TOKEN }) });
    const { container } = render(ui);

    expect(container.innerHTML).not.toContain(VALID_TOKEN);
  });
});
