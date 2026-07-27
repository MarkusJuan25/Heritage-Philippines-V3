// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock('@/lib/auth/guards', () => ({ getCurrentUser: getCurrentUserMock }));

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import NewLeadPage from './page';

const ADMIN_MANAGER = {
  id: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin Manager',
  role: 'ADMIN_MANAGER',
};
const TRAVEL_CONSULTANT = {
  id: 'tc-1',
  email: 'tc@example.test',
  name: 'TC',
  role: 'TRAVEL_CONSULTANT',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Stage 3 correction (see admin/leads/page.test.tsx's identical note):
  // `vi.resetAllMocks()` in `afterEach` strips `redirectMock`'s throwing
  // implementation, so it must be re-armed before every test.
  redirectMock.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('NewLeadPage', () => {
  it('redirects to /login when there is no session (Layer 3)', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(NewLeadPage()).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('renders the creation form for an authorized ADMIN_MANAGER', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    render(await NewLeadPage());

    expect(screen.getByRole('heading', { name: 'New Lead' })).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toBeInTheDocument();
  });

  it('renders the creation form for an authorized TRAVEL_CONSULTANT', async () => {
    getCurrentUserMock.mockResolvedValue(TRAVEL_CONSULTANT);

    render(await NewLeadPage());

    expect(screen.getByRole('heading', { name: 'New Lead' })).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toBeInTheDocument();
  });

  it.each(['FINANCE_ACCOUNTING', 'VISA_DOCUMENTATION', 'SYSTEM_ADMINISTRATOR', 'CLIENT'])(
    'renders the same truthful permission-denied state used by the Lead surface for role %s',
    async (role) => {
      getCurrentUserMock.mockResolvedValue({ ...ADMIN_MANAGER, role });

      render(await NewLeadPage());

      expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
      expect(
        screen.getByText(
          'Only Admin/Manager and Travel Consultant staff can access Lead management.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
    },
  );

  it('does not perform creation itself — rendering the page issues no network request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        lead: { id: 'unused', fullName: 'unused' },
        duplicateMatches: [],
        restrictedMatchDetected: false,
      }),
    } as Response);
    getCurrentUserMock.mockResolvedValue(ADMIN_MANAGER);

    render(await NewLeadPage());

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
