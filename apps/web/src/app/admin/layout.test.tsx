// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
// `SignOutButton` (rendered inside this layout) is a Client Component that
// calls `useRouter()` at render time — it must resolve to a stub, or
// rendering this layout in a plain jsdom + Testing Library environment
// (no real Next.js router context) would throw.
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import AdminLayout from './layout';

const BASE_USER = {
  id: 'user-1',
  email: 'user@example.test',
  name: 'Test User',
  role: 'ADMIN_MANAGER',
};

describe('AdminLayout', () => {
  it('redirects to /login when there is no session (Layer 2)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(AdminLayout({ children: <div /> })).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('renders an in-place permission-denied state for a CLIENT session', async () => {
    getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role: 'CLIENT' });

    const jsx = await AdminLayout({ children: <div /> });
    render(jsx);

    expect(screen.getByText('Access denied')).toBeInTheDocument();
  });

  it.each([
    'ADMIN_MANAGER',
    'TRAVEL_CONSULTANT',
    'FINANCE_ACCOUNTING',
    'VISA_DOCUMENTATION',
    'SYSTEM_ADMINISTRATOR',
  ])('preserves the existing Leads navigation link for staff role %s', async (role) => {
    getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

    const jsx = await AdminLayout({ children: <div /> });
    render(jsx);

    expect(screen.getByRole('link', { name: 'Leads' })).toHaveAttribute('href', '/admin/leads');
  });

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'])(
    'renders a Clients navigation link to /admin/clients for role %s (D-025 §2)',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

      const jsx = await AdminLayout({ children: <div /> });
      render(jsx);

      expect(screen.getByRole('link', { name: 'Clients' })).toHaveAttribute(
        'href',
        '/admin/clients',
      );
    },
  );

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'never renders a Clients navigation link for excluded staff role %s (D-025 §2)',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

      const jsx = await AdminLayout({ children: <div /> });
      render(jsx);

      expect(screen.queryByRole('link', { name: 'Clients' })).not.toBeInTheDocument();
    },
  );

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'])(
    'renders a Proposals navigation link to /admin/proposals for role %s (D-027 §8)',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

      const jsx = await AdminLayout({ children: <div /> });
      render(jsx);

      expect(screen.getByRole('link', { name: 'Proposals' })).toHaveAttribute(
        'href',
        '/admin/proposals',
      );
    },
  );

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'never renders a Proposals navigation link for excluded staff role %s (D-027 §8)',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

      const jsx = await AdminLayout({ children: <div /> });
      render(jsx);

      expect(screen.queryByRole('link', { name: 'Proposals' })).not.toBeInTheDocument();
    },
  );

  it.each(['ADMIN_MANAGER', 'TRAVEL_CONSULTANT'])(
    'renders a Bookings navigation link to /admin/bookings for role %s (D-028 §3)',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

      const jsx = await AdminLayout({ children: <div /> });
      render(jsx);

      expect(screen.getByRole('link', { name: 'Bookings' })).toHaveAttribute(
        'href',
        '/admin/bookings',
      );
    },
  );

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR'])(
    'never renders a Bookings navigation link for excluded staff role %s (D-028 §3)',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...BASE_USER, role });

      const jsx = await AdminLayout({ children: <div /> });
      render(jsx);

      expect(screen.queryByRole('link', { name: 'Bookings' })).not.toBeInTheDocument();
    },
  );
});
