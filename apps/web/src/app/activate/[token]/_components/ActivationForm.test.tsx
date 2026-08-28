// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ActivationForm } from './ActivationForm';

const VALID_TOKEN = 'A1b2C3d4E5f6G7h8I9j0K1L2';
const VALID_PASSWORD = 'correct-horse-battery';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let replaceMock: ReturnType<typeof vi.fn>;

const originalLocation = window.location;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  replaceMock = vi.fn();
  // jsdom's real `Location.prototype.replace` is not configurable, so
  // `vi.spyOn(window.location, 'replace')` cannot redefine it directly —
  // replace the whole `window.location` with a plain object carrying only
  // what this component reads (`pathname`) and calls (`replace`).
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { pathname: `/activate/${VALID_TOKEN}`, replace: replaceMock },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('ActivationForm — not-opened state', () => {
  it('renders a Continue button, never the password form, and posts the URL-derived token on click', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { opened: true }));
    const user = userEvent.setup();
    render(<ActivationForm initialState="not-opened" />);

    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/activation/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: VALID_TOKEN }),
      }),
    );
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
  });

  it('renders the generic invalid message when Continue is rejected', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: { code: 'ACTIVATION_NOT_POSSIBLE' } }),
    );
    const user = userEvent.setup();
    render(<ActivationForm initialState="not-opened" />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('This invitation link is no longer valid.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument();
  });

  it('blocks a second Continue click while the first request is in flight', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<ActivationForm initialState="not-opened" />);

    const button = screen.getByRole('button', { name: 'Continue' });
    await user.click(button);
    await user.click(button);
    await user.click(button);

    resolveFetch(jsonResponse(200, { opened: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe('ActivationForm — opened state', () => {
  it('renders the password form directly, with accessible labels and autocomplete', () => {
    render(<ActivationForm initialState="opened" />);

    const password = screen.getByLabelText('Password');
    const confirm = screen.getByLabelText('Confirm password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autoComplete', 'new-password');
    expect(confirm).toHaveAttribute('type', 'password');
  });

  it('submits the URL-derived token and entered password, redirecting with replace semantics on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { activated: true }));
    const user = userEvent.setup();
    render(<ActivationForm initialState="opened" />);

    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/activation/activate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: VALID_TOKEN,
          password: VALID_PASSWORD,
          confirmPassword: VALID_PASSWORD,
        }),
      }),
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login?activated=1'));
  });

  it('renders field-level password errors from a 400 response and preserves the submitted value', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          details: [{ path: 'password', message: 'Password must be at least 12 characters.' }],
        },
      }),
    );
    const user = userEvent.setup();
    render(<ActivationForm initialState="opened" />);

    await user.type(screen.getByLabelText('Password'), 'short1');
    await user.type(screen.getByLabelText('Confirm password'), 'short1');
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    expect(await screen.findByText('Password must be at least 12 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('short1');
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('renders the identical generic invalid message on a 409 rejection', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: { code: 'ACTIVATION_NOT_POSSIBLE' } }),
    );
    const user = userEvent.setup();
    render(<ActivationForm initialState="opened" />);

    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    expect(await screen.findByText('This invitation link is no longer valid.')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('disables the submit control while submitting', async () => {
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<ActivationForm initialState="opened" />);

    await user.type(screen.getByLabelText('Password'), VALID_PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Activate account' }));

    expect(screen.getByRole('button', { name: 'Activating…' })).toBeDisabled();
    resolveFetch(jsonResponse(200, { activated: true }));
    await waitFor(() => expect(replaceMock).toHaveBeenCalled());
  });
});

describe('ActivationForm — token security', () => {
  it('never renders the raw token anywhere in the DOM, in either state', async () => {
    const { container, unmount } = render(<ActivationForm initialState="not-opened" />);
    expect(container.innerHTML).not.toContain(VALID_TOKEN);
    unmount();

    const opened = render(<ActivationForm initialState="opened" />);
    expect(opened.container.innerHTML).not.toContain(VALID_TOKEN);
  });

  it('never includes the token in any DOM attribute', () => {
    const { container } = render(<ActivationForm initialState="opened" />);
    const allAttributeValues = Array.from(container.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes).map((attr) => attr.value),
    );
    expect(allAttributeValues.some((value) => value.includes(VALID_TOKEN))).toBe(false);
  });
});
