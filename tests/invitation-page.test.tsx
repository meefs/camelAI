import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InvitationPage from '@/app/invitations/[orgId]/[invitationId]/page';

const pushMock = vi.fn();
let params = { orgId: 'org-123', invitationId: 'invite-456' };
const useAuthMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => params,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

const invitationPayload = {
  email: 'invitee@example.com',
  role: 'member',
  org: {
    id: 'org-123',
    name: 'Acme',
  },
};

describe('InvitationPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    params = { orgId: 'org-123', invitationId: 'invite-456' };
    pushMock.mockReset();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ user: null, loading: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders loading state initially', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<InvitationPage />);
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  });

  it('renders valid invitation for unauthenticated user', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(invitationPayload),
    });

    render(<InvitationPage />);

    expect(await screen.findByText('Acme')).toBeInTheDocument();
    const signInLink = screen.getByRole('link', { name: /sign in to accept/i });
    expect(signInLink).toHaveAttribute(
      'href',
      '/login?redirect=%2Finvitations%2Forg-123%2Finvite-456'
    );
    expect(screen.queryByRole('button', { name: /accept invitation/i })).toBeNull();
    expect(screen.queryByText('invitee@example.com')).toBeNull();
  });

  it('renders valid invitation for authenticated user', async () => {
    useAuthMock.mockReturnValue({
      user: { email: 'invitee@example.com' },
      loading: false,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(invitationPayload),
    });

    render(<InvitationPage />);

    expect(await screen.findByRole('button', { name: /accept invitation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
  });

  it('renders error state for invalid invitation', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Invitation not found' }),
    });

    render(<InvitationPage />);

    expect(await screen.findByText('Invitation not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
  });

  it('renders error state for expired invitation', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 410,
      json: () => Promise.resolve({ error: 'Invitation not found' }),
    });

    render(<InvitationPage />);

    expect(await screen.findByText('Invitation not found')).toBeInTheDocument();
  });

  it('shows decline confirmation dialog', async () => {
    useAuthMock.mockReturnValue({
      user: { email: 'invitee@example.com' },
      loading: false,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(invitationPayload),
    });

    const user = userEvent.setup();
    render(<InvitationPage />);

    await user.click(await screen.findByRole('button', { name: /decline/i }));
    expect(await screen.findByText('Decline invitation?')).toBeInTheDocument();
  });

  it('handles accept flow', async () => {
    vi.useFakeTimers();
    useAuthMock.mockReturnValue({
      user: { email: 'invitee@example.com' },
      loading: false,
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(invitationPayload),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

    const hrefSpy = vi.spyOn(window.location, 'href', 'set');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<InvitationPage />);

    await user.click(await screen.findByRole('button', { name: /accept invitation/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/invitations/org-123/invite-456',
        expect.objectContaining({ method: 'POST' })
      );
    });

    expect(await screen.findByText(/invitation accepted/i)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(hrefSpy).toHaveBeenCalledWith('/');
    hrefSpy.mockRestore();
  });

  it('handles decline flow', async () => {
    useAuthMock.mockReturnValue({
      user: { email: 'invitee@example.com' },
      loading: false,
    });
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(invitationPayload),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

    render(<InvitationPage />);

    fireEvent.click(await screen.findByRole('button', { name: /decline/i }));
    fireEvent.click(await screen.findByRole('button', { name: /decline invitation/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/orgs/org-123/invite',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    expect(pushMock).toHaveBeenCalledWith('/');
  });
});
