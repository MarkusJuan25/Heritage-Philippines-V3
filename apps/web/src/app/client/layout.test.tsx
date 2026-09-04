// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { getOwnClientForUserMock } = vi.hoisted(() => ({ getOwnClientForUserMock: vi.fn() }));
vi.mock('@/features/clients/service', () => ({ getOwnClientForUser: getOwnClientForUserMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
// `SignOutButton` (rendered by the normal branch) and `ClientPortalNav` are
// Client Components; `SignOutButton` calls `useRouter()` at render time and
// must resolve to a stub, mirroring admin/layout.test.tsx's discipline.
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import ClientLayout from './layout';

const CLIENT_USER = {
  id: 'user-client-1',
  email: 'client@example.test',
  name: 'Client One',
  role: 'CLIENT',
};

const OWNED = {
  clientId: 'SECRET-CLIENT-ROW-ID',
  fullName: 'Juan Dela Cruz',
  email: 'juan@example.com',
  phone: null,
};

const CHILD = <div data-testid="portal-children">child content</div>;

async function renderLayout() {
  const jsx = await ClientLayout({ children: CHILD });
  return render(jsx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ClientLayout (D-040 §2 Layer 2)', () => {
  it('redirects to /login when there is no session, without calling Contract A', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(ClientLayout({ children: CHILD })).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
    expect(getOwnClientForUserMock).not.toHaveBeenCalled();
  });

  it.each([
    'ADMIN_MANAGER',
    'TRAVEL_CONSULTANT',
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'SYSTEM_ADMINISTRATOR',
  ])(
    'renders the single-<main> "Client area" panel for non-CLIENT role %s and does not render children or call Contract A',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...CLIENT_USER, role });

      const { container } = await renderLayout();

      expect(container.querySelectorAll('main')).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1, name: 'Client area' })).toBeInTheDocument();
      expect(
        screen.getByText('This area is for Heritage Philippines client accounts.'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('portal-children')).not.toBeInTheDocument();
      expect(getOwnClientForUserMock).not.toHaveBeenCalled();
      expect(redirectMock).not.toHaveBeenCalled();
    },
  );

  it('renders the single-<main> "Account setup in progress" panel when Contract A resolves null, without revealing the ClientProfile', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(null);

    const { container } = await renderLayout();

    expect(getOwnClientForUserMock).toHaveBeenCalledWith(CLIENT_USER);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Account setup in progress' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your client account isn't fully set up yet. Please contact your Heritage Philippines travel consultant for help completing your account setup.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('portal-children')).not.toBeInTheDocument();

    // Calm and generic — never reveals that no ClientProfile row exists.
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('clientprofile');
    expect(text).not.toContain('profile row');
    expect(text).not.toContain('not found');
  });

  it('renders the portal chrome + the single <main> wrapping children when Contract A resolves an owned client', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);

    const { container } = await renderLayout();

    expect(getOwnClientForUserMock).toHaveBeenCalledWith(CLIENT_USER);
    expect(getOwnClientForUserMock.mock.calls[0]).toHaveLength(1);

    const mains = container.querySelectorAll('main');
    expect(mains).toHaveLength(1);

    const child = screen.getByTestId('portal-children');
    expect(child).toBeInTheDocument();
    expect(mains[0]!.contains(child)).toBe(true);

    // The persistent chrome: the ten-label nav and a genuine sign-out control.
    expect(screen.getByRole('navigation', { name: 'Client portal' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('never renders the resolved clientId (or any server-only identifier) in the success branch', async () => {
    getCurrentUserMock.mockResolvedValue(CLIENT_USER);
    getOwnClientForUserMock.mockResolvedValue(OWNED);

    const { container } = await renderLayout();

    expect(container.innerHTML).not.toContain('SECRET-CLIENT-ROW-ID');
    expect(container.innerHTML).not.toContain(CLIENT_USER.id);
    // The layout only consumes the null-ness of Contract A's result; it
    // renders none of the identity fields (page.tsx owns that).
    expect(container.innerHTML).not.toContain('Juan Dela Cruz');
    expect(container.innerHTML).not.toContain('juan@example.com');
  });
});
