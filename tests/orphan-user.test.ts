import { describe, it, expect, vi, beforeEach } from 'vitest';
import { login } from '@/lib/server-actions/auth';

const mockGetUserByEmail = vi.fn();
const mockVerifyUserPassword = vi.fn();
const mockGetUserOrgs = vi.fn();
const mockHandleOrphanedUserLogin = vi.fn();
const mockListUserWorkspaces = vi.fn();
const mockListUserWorkspacesAcrossOrgs = vi.fn();
const mockCreateSession = vi.fn();
const mockCreateOrg = vi.fn();
const mockGetOrg = vi.fn();

vi.mock('@/lib/auth-do', () => ({
  getUserByEmail: (...args: [string]) => mockGetUserByEmail(...args),
  verifyUserPassword: (...args: [string, string]) => mockVerifyUserPassword(...args),
  getUserOrgs: (...args: [string]) => mockGetUserOrgs(...args),
  handleOrphanedUserLogin: (...args: [string]) => mockHandleOrphanedUserLogin(...args),
  listUserWorkspaces: (...args: [string, string]) => mockListUserWorkspaces(...args),
  listUserWorkspacesAcrossOrgs: (...args: [string, unknown]) =>
    mockListUserWorkspacesAcrossOrgs(...args),
  createSession: (...args: [string, string, string | null]) => mockCreateSession(...args),
  createOrg: (...args: [string, string]) => mockCreateOrg(...args),
  getOrg: (...args: [string]) => mockGetOrg(...args),
}));

const mockSetSessionCookie = vi.fn();

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    setSessionCookie: (...args: [string]) => mockSetSessionCookie(...args),
  };
});

describe('orphaned user login', () => {
  beforeEach(() => {
    mockGetUserByEmail.mockReset();
    mockVerifyUserPassword.mockReset();
    mockGetUserOrgs.mockReset();
    mockHandleOrphanedUserLogin.mockReset();
    mockListUserWorkspaces.mockReset();
    mockListUserWorkspacesAcrossOrgs.mockReset();
    mockCreateSession.mockReset();
    mockCreateOrg.mockReset();
    mockGetOrg.mockReset();
    mockSetSessionCookie.mockReset();
  });

  it('creates a session with orphan-recovery workspace', async () => {
    const user = {
      id: 'user-1',
      email: 'orphan@example.com',
      name: 'Orphan User',
      created_at: Date.now(),
      is_superuser: false,
      avatar: { color: '#000000', content: 'OU' },
      is_orphaned: true,
    };

    const org = {
      id: 'org-1',
      name: 'Orphan Org',
      created_at: Date.now(),
      created_by: user.id,
      billing_status: 'free',
      archived: false,
      archived_at: null,
    };

    const workspace = {
      id: 'ws-1',
      org_id: org.id,
      name: 'Default Workspace',
      description: null,
      created_by: user.id,
      created_at: Date.now(),
      avatar: { color: '#111111', content: 'DW' },
      archived: false,
      archived_at: null,
      access_level: 'full',
    };

    mockGetUserByEmail.mockResolvedValue({ userId: user.id, user });
    mockVerifyUserPassword.mockResolvedValue(true);
    mockGetUserOrgs.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { org_id: org.id, org_name: org.name, role: 'owner', joined_at: Date.now() },
    ]);
    mockHandleOrphanedUserLogin.mockResolvedValue({ org, workspace });
    mockListUserWorkspaces.mockResolvedValue([workspace]);
    mockListUserWorkspacesAcrossOrgs.mockResolvedValue([workspace]);
    mockCreateSession.mockResolvedValue({ sessionId: 'session-1', sessionData: { workspace_id: workspace.id } });

    const result = await login(user.email, 'password123');

    expect(result.currentOrg.id).toBe(org.id);
    expect(result.currentWorkspace?.id).toBe(workspace.id);
    expect(mockCreateSession).toHaveBeenCalledWith(user.id, org.id, workspace.id);
    expect(mockSetSessionCookie).toHaveBeenCalledWith('session-1');
  });

  it('does not create a new org if an orphan accepts an invitation', async () => {
    const user = {
      id: 'user-2',
      email: 'invitee@example.com',
      name: 'Invitee',
      created_at: Date.now(),
      is_superuser: false,
      avatar: { color: '#000000', content: 'IN' },
      is_orphaned: false,
    };

    const org = {
      id: 'org-2',
      name: 'Invited Org',
      created_at: Date.now(),
      created_by: 'owner-1',
      billing_status: 'free',
      archived: false,
      archived_at: null,
    };

    const workspace = {
      id: 'ws-2',
      org_id: org.id,
      name: 'Invited Workspace',
      description: null,
      created_by: org.created_by,
      created_at: Date.now(),
      avatar: { color: '#111111', content: 'IW' },
      archived: false,
      archived_at: null,
      access_level: 'full',
    };

    mockGetUserByEmail.mockResolvedValue({ userId: user.id, user });
    mockVerifyUserPassword.mockResolvedValue(true);
    mockHandleOrphanedUserLogin.mockResolvedValue(null);
    mockGetUserOrgs.mockResolvedValue([
      { org_id: org.id, org_name: org.name, role: 'member', joined_at: Date.now() },
    ]);
    mockGetOrg.mockResolvedValue(org);
    mockListUserWorkspaces.mockResolvedValue([workspace]);
    mockListUserWorkspacesAcrossOrgs.mockResolvedValue([workspace]);
    mockCreateSession.mockResolvedValue({ sessionId: 'session-2', sessionData: { workspace_id: workspace.id } });

    const result = await login(user.email, 'password123');

    expect(result.currentOrg.id).toBe(org.id);
    expect(mockCreateOrg).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(user.id, org.id, workspace.id);
    expect(mockSetSessionCookie).toHaveBeenCalledWith('session-2');
  });

  it('handles orphaned users with existing sessions', async () => {
    const user = {
      id: 'user-3',
      email: 'orphaned@example.com',
      name: 'Orphaned',
      created_at: Date.now(),
      is_superuser: false,
      avatar: { color: '#000000', content: 'OR' },
      is_orphaned: true,
    };

    const org = {
      id: 'org-3',
      name: 'Recovered Org',
      created_at: Date.now(),
      created_by: user.id,
      billing_status: 'free',
      archived: false,
      archived_at: null,
    };

    const workspace = {
      id: 'ws-3',
      org_id: org.id,
      name: 'Recovered Workspace',
      description: null,
      created_by: user.id,
      created_at: Date.now(),
      avatar: { color: '#111111', content: 'RW' },
      archived: false,
      archived_at: null,
      access_level: 'full',
    };

    mockGetUserByEmail.mockResolvedValue({ userId: user.id, user });
    mockVerifyUserPassword.mockResolvedValue(true);
    mockHandleOrphanedUserLogin.mockResolvedValue({ org, workspace });
    mockGetUserOrgs.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { org_id: org.id, org_name: org.name, role: 'owner', joined_at: Date.now() },
    ]);
    mockListUserWorkspaces.mockResolvedValue([workspace]);
    mockListUserWorkspacesAcrossOrgs.mockResolvedValue([workspace]);
    mockCreateSession.mockResolvedValue({ sessionId: 'session-3', sessionData: { workspace_id: workspace.id } });

    await login(user.email, 'password123');

    expect(mockCreateSession).toHaveBeenCalledWith(user.id, org.id, workspace.id);
    expect(mockSetSessionCookie).toHaveBeenCalledWith('session-3');
  });
});
