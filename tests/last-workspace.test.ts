import { describe, it, expect, vi, beforeEach } from 'vitest';
import { login } from '@/lib/server-actions/auth';

const mockGetUserByEmail = vi.fn();
const mockVerifyUserPassword = vi.fn();
const mockGetUserOrgs = vi.fn();
const mockHandleOrphanedUserLogin = vi.fn();
const mockListUserWorkspaces = vi.fn();
const mockListUserWorkspacesAcrossOrgs = vi.fn();
const mockCreateSession = vi.fn();
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

describe('login selects last-used workspace', () => {
  beforeEach(() => {
    mockGetUserByEmail.mockReset();
    mockVerifyUserPassword.mockReset();
    mockGetUserOrgs.mockReset();
    mockHandleOrphanedUserLogin.mockReset();
    mockListUserWorkspaces.mockReset();
    mockListUserWorkspacesAcrossOrgs.mockReset();
    mockCreateSession.mockReset();
    mockGetOrg.mockReset();
    mockSetSessionCookie.mockReset();
  });

  it('prefers last_workspace_id when available', async () => {
    const user = {
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      created_at: Date.now(),
      is_superuser: false,
      avatar: { color: '#000000', content: 'TU' },
      is_orphaned: false,
    };

    const org = {
      id: 'org-1',
      name: 'Org',
      created_at: Date.now(),
      created_by: user.id,
      billing_status: 'free',
      archived: false,
      archived_at: null,
    };

    const workspaces = [
      {
        id: 'ws-1',
        org_id: org.id,
        name: 'Alpha',
        description: null,
        created_by: user.id,
        created_at: Date.now(),
        avatar: { color: '#111111', content: 'AL' },
        archived: false,
        archived_at: null,
        access_level: 'full',
      },
      {
        id: 'ws-2',
        org_id: org.id,
        name: 'Beta',
        description: null,
        created_by: user.id,
        created_at: Date.now(),
        avatar: { color: '#222222', content: 'BE' },
        archived: false,
        archived_at: null,
        access_level: 'full',
      },
    ];

    mockGetUserByEmail.mockResolvedValue({ userId: user.id, user });
    mockVerifyUserPassword.mockResolvedValue(true);
    mockHandleOrphanedUserLogin.mockResolvedValue(null);
    mockGetUserOrgs.mockResolvedValue([
      {
        org_id: org.id,
        org_name: org.name,
        role: 'owner',
        joined_at: Date.now(),
        last_workspace_id: 'ws-2',
      },
    ]);
    mockGetOrg.mockResolvedValue(org);
    mockListUserWorkspaces.mockResolvedValue(workspaces);
    mockListUserWorkspacesAcrossOrgs.mockResolvedValue(workspaces);
    mockCreateSession.mockResolvedValue({ sessionId: 'session-1', sessionData: { workspace_id: 'ws-2' } });

    const result = await login(user.email, 'password123');

    expect(result.currentWorkspace?.id).toBe('ws-2');
    expect(mockCreateSession).toHaveBeenCalledWith(user.id, org.id, 'ws-2');
    expect(mockSetSessionCookie).toHaveBeenCalledWith('session-1');
  });
});
