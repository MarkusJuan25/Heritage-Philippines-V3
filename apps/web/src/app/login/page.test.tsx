// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const { signInEmailMock, pushMock, refreshMock, searchParamsMock } = vi.hoisted(() => ({
  signInEmailMock: vi.fn(),
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  searchParamsMock: vi.fn(() => new URLSearchParams()),
}));

vi.mock('@/lib/auth/auth-client', () => ({
  signIn: { email: signInEmailMock },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: searchParamsMock,
}));

import LoginPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  searchParamsMock.mockReturnValue(new URLSearchParams());
});

describe('LoginPage', () => {
  it('navigates to /dashboard and refreshes after a successful sign-in', async () => {
    signInEmailMock.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'staff@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery-staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'));
    expect(refreshMock).toHaveBeenCalled();
    expect(signInEmailMock).toHaveBeenCalledWith({
      email: 'staff@example.test',
      password: 'correct-horse-battery-staple',
    });
  });

  it('renders an accessible error and never navigates on a controlled sign-in failure', async () => {
    signInEmailMock.mockResolvedValue({ error: { message: 'Invalid email or password.' } });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'staff@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(pushMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('disables the submit control while a sign-in request is in flight', async () => {
    let resolveSignIn!: (value: { error: null }) => void;
    signInEmailMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'staff@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery-staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();

    resolveSignIn({ error: null });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'));
  });

  it('shows the activation success banner when activated=1 is present', () => {
    searchParamsMock.mockReturnValue(new URLSearchParams('activated=1'));
    render(<LoginPage />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Your account has been activated. Sign in to continue.',
    );
  });

  it('shows no activation banner on a normal visit', () => {
    render(<LoginPage />);

    expect(screen.queryByText(/account has been activated/i)).not.toBeInTheDocument();
  });
});
