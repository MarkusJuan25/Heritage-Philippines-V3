// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { FinanceAssignmentPanel } from './FinanceAssignmentPanel';

const BOOKING_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const ELIGIBLE = [
  { id: 'finance-b', name: 'Cora Finance', email: 'cora@example.test' },
  { id: 'finance-c', name: 'Dan Finance', email: 'dan@example.test' },
];
const CURRENT = {
  name: 'Ben Finance',
  email: 'ben@example.test',
  role: 'FINANCE_ACCOUNTING',
  eligible: true,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { assignment: { id: 'a-1' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function sentBody(call = 0) {
  return JSON.parse(fetchMock.mock.calls[call]![1].body as string);
}

describe('FinanceAssignmentPanel', () => {
  it('sets a first assignee with PUT and no reason, then refreshes', async () => {
    render(<FinanceAssignmentPanel bookingId={BOOKING_ID} current={null} eligible={ELIGIBLE} />);

    expect(screen.getByText('Not assigned')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'finance-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

    await screen.findByText('Finance/Accounting assignee set.');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/bookings/${BOOKING_ID}/finance-assignment`,
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(sentBody()).toEqual({ assignedStaffId: 'finance-b' });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('requires a reason before replacing the current assignee, then sends it', async () => {
    render(<FinanceAssignmentPanel bookingId={BOOKING_ID} current={CURRENT} eligible={ELIGIBLE} />);

    fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'finance-c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(
      await screen.findByText('A reason is required when replacing the current assignee.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason for replacement'), {
      target: { value: '  Ben on leave  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

    await screen.findByText('Finance/Accounting assignee replaced.');
    expect(sentBody()).toEqual({ assignedStaffId: 'finance-c', reason: 'Ben on leave' });
  });

  it('ends only from an explicit second step with a reason, using DELETE', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { assignment: { id: 'a-1' } }));
    render(<FinanceAssignmentPanel bookingId={BOOKING_ID} current={CURRENT} eligible={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'End assignment…' }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'End assignment' }));
    expect(
      await screen.findByText('A reason is required to end the assignment.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason for ending'), {
      target: { value: 'Trip settled' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'End assignment' }));

    await screen.findByText('Finance/Accounting assignment ended.');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/bookings/${BOOKING_ID}/finance-assignment`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(sentBody()).toEqual({ reason: 'Trip settled' });
  });

  it('cancelling the end step sends nothing', () => {
    render(<FinanceAssignmentPanel bookingId={BOOKING_ID} current={CURRENT} eligible={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'End assignment…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'End assignment…' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's own message for a refused change and does not refresh", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'ASSIGNEE_INELIGIBLE_ROLE',
          message: 'The assignee must be an active Finance/Accounting user.',
        },
      }),
    );
    render(<FinanceAssignmentPanel bookingId={BOOKING_ID} current={null} eligible={ELIGIBLE} />);

    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'finance-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

    expect(
      await screen.findByText('The assignee must be an active Finance/Accounting user.'),
    ).toBeInTheDocument();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('shows a generic message on a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<FinanceAssignmentPanel bookingId={BOOKING_ID} current={null} eligible={ELIGIBLE} />);

    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'finance-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument();
  });

  it('flags a stale assignee', () => {
    render(
      <FinanceAssignmentPanel
        bookingId={BOOKING_ID}
        current={{ ...CURRENT, role: 'TRAVEL_CONSULTANT', eligible: false }}
        eligible={[]}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('current role: TRAVEL_CONSULTANT');
  });

  it('never sends two requests for a double submission', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<FinanceAssignmentPanel bookingId={BOOKING_ID} current={null} eligible={ELIGIBLE} />);

    fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'finance-b' } });
    const button = screen.getByRole('button', { name: 'Assign' });
    fireEvent.click(button);
    fireEvent.click(button);
    resolve(jsonResponse(200, { assignment: { id: 'a-1' } }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
