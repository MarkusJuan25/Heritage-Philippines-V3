// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
// `SignOutButton` (rendered by this page) is a Client Component that calls
// `useRouter()` at render time — it must resolve to a stub, or rendering
// this page in a plain jsdom + Testing Library environment (no real
// Next.js router context) would throw. Mirrors admin/layout.test.tsx's
// identical discipline.
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import DashboardPage from './page';

const BASE_USER = {
  id: 'user-1',
  email: 'user@example.test',
  name: 'Test User',
  role: 'ADMIN_MANAGER',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DashboardPage', () => {
  it('redirects to /login when there is no session', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(DashboardPage()).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'])(
    'redirects role %s to /admin (D-029 §2, Correction 1)',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

      await expect(DashboardPage()).rejects.toThrow('REDIRECT:/admin');
      expect(redirectMock).toHaveBeenCalledWith('/admin');
    },
  );

  it.each(['SYSTEM_ADMINISTRATOR', 'FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'CLIENT'])(
    'retains the existing Phase-1 verification content for role %s, never redirecting to /admin',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

      const jsx = await DashboardPage();
      render(jsx);

      expect(screen.getByText('Signed in')).toBeInTheDocument();
      expect(screen.getByText(BASE_USER.name)).toBeInTheDocument();
      expect(screen.getByText(BASE_USER.email)).toBeInTheDocument();
      expect(screen.getByText(role)).toBeInTheDocument();
      expect(redirectMock).not.toHaveBeenCalledWith('/admin');
    },
  );
});
