import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrgRole, User, WorkspaceAccessLevel } from '@/types';

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

const fetcherSubmitMock = vi.fn();

vi.mock('react-router', () => ({
  useFetcher: () => ({
    state: 'idle',
    data: undefined,
    submit: fetcherSubmitMock,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

vi.mock('@/hooks/use-auth-actions', () => ({
  useLogout: () => ({ logout: vi.fn() }),
}));

vi.mock('@/components/settings/invite-member-dialog', () => ({
  InviteMemberDialog: () => null,
}));

vi.mock('@/components/settings/workspace-access-tags', () => ({
  WorkspaceAccessTags: () => null,
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

import { TeamTable } from '@/components/settings/team-table';

const ORG_ID = 'org_123';
const INVITATION_ID = 'inv_456';
const ORIGIN = 'https://app.example.com';
const EXPECTED_URL = `${ORIGIN}/invitations/${ORG_ID}/${INVITATION_ID}`;

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user_self',
    email: 'self@example.com',
    email_verified_at: 1700000000000,
    name: 'Self User',
    created_at: 1700000000000,
    is_superuser: false,
    avatar: { color: '#000000', content: 'S' },
    is_orphaned: false,
    orphaned_at: null,
    ...overrides,
  };
}

function renderTeamTable() {
  return render(
    <TeamTable
      orgId={ORG_ID}
      currentUserId="user_self"
      canManageMembers={true}
      members={[
        {
          user: buildUser(),
          role: 'owner' as OrgRole,
          joined_at: 1700000000000,
          workspaceAccess: {} as Record<string, WorkspaceAccessLevel>,
        },
      ]}
      invitations={[
        {
          id: INVITATION_ID,
          email: 'invitee@example.com',
          role: 'member' as OrgRole,
          created_at: 1700000000000,
          expires_at: 1800000000000,
          workspace_access: {},
        },
      ]}
      workspaces={[]}
    />
  );
}

describe('TeamTable - copy invite link', () => {
  beforeEach(() => {
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    fetcherSubmitMock.mockClear();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, origin: ORIGIN, href: `${ORIGIN}/` },
    });
  });

  it('shows the "Copy invite link" item in the invitation row dropdown', () => {
    renderTeamTable();

    // Desktop dropdown + mobile button both expose this label.
    const items = screen.getAllByText('Copy invite link');
    expect(items.length).toBeGreaterThan(0);
  });

  it('writes the invite URL to the clipboard and shows a success toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderTeamTable();

    fireEvent.click(screen.getAllByText('Copy invite link')[0]);

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(EXPECTED_URL);
      expect(toastSuccessMock).toHaveBeenCalledWith('Invite link copied');
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(fetcherSubmitMock).not.toHaveBeenCalled();
  });

  it('shows an error toast when the clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderTeamTable();

    fireEvent.click(screen.getAllByText('Copy invite link')[0]);

    await vi.waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith('denied');
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it('uses the cancel-invitation fetcher submit when "Cancel invitation" is clicked', () => {
    renderTeamTable();

    fireEvent.click(screen.getAllByText('Cancel invitation')[0]);

    expect(fetcherSubmitMock).toHaveBeenCalledWith(
      { intent: 'deleteInvitation', invitationId: INVITATION_ID },
      { method: 'POST' }
    );
  });
});
