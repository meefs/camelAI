import { describe, it, expect, vi, beforeEach } from 'vitest';
import { switchOrg, switchWorkspace } from '@/lib/server-actions/auth';

const mockGetSessionContext = vi.fn();

vi.mock('@/lib/auth-context', () => ({
  getSessionContext: (...args: []) => mockGetSessionContext(...args),
}));

const mockGetSessionId = vi.fn();

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    getSessionId: (...args: []) => mockGetSessionId(...args),
  };
});

const mockGetSession = vi.fn();
const mockGetWorkspace = vi.fn();
const mockGetWorkspaceAccess = vi.fn();
const mockSwitchSessionWorkspace = vi.fn();
const mockIsOrgMember = vi.fn();
const mockGetUserOrgs = vi.fn();
const mockListUserWorkspaces = vi.fn();
const mockSwitchSessionOrg = vi.fn();
const mockGetOrg = vi.fn();

vi.mock('@/lib/auth-do', () => ({
  getSession: (...args: [string]) => mockGetSession(...args),
  getWorkspace: (...args: [string]) => mockGetWorkspace(...args),
  getWorkspaceAccess: (...args: [string, string]) => mockGetWorkspaceAccess(...args),
  switchSessionWorkspace: (...args: [string, string | null]) => mockSwitchSessionWorkspace(...args),
  isOrgMember: (...args: [string, string]) => mockIsOrgMember(...args),
  getUserOrgs: (...args: [string]) => mockGetUserOrgs(...args),
  listUserWorkspaces: (...args: [string, string]) => mockListUserWorkspaces(...args),
  switchSessionOrg: (...args: [string, string, string | null]) => mockSwitchSessionOrg(...args),
  getOrg: (...args: [string]) => mockGetOrg(...args),
}));

describe('session workspace', () => {
  beforeEach(() => {
    mockGetSessionContext.mockReset();
    mockGetSessionId.mockReset();
    mockGetSession.mockReset();
    mockGetWorkspace.mockReset();
    mockGetWorkspaceAccess.mockReset();
    mockSwitchSessionWorkspace.mockReset();
    mockIsOrgMember.mockReset();
    mockGetUserOrgs.mockReset();
    mockListUserWorkspaces.mockReset();
    mockSwitchSessionOrg.mockReset();
    mockGetOrg.mockReset();
  });

  it('switches workspace within same org', async () => {
    mockGetSessionContext.mockResolvedValue({
      sessionId: 'session-1',
      session: {
        user_id: 'user-1',
        org_id: 'org-1',
        workspace_id: 'ws-1',
      },
    });
    mockGetWorkspace.mockResolvedValue({
      id: 'ws-2',
      org_id: 'org-1',
      name: 'Workspace 2',
      description: null,
      created_by: 'user-1',
      created_at: Date.now(),
      avatar: { color: '#000000', content: 'W2' },
      archived: false,
      archived_at: null,
    });
    mockGetWorkspaceAccess.mockResolvedValue('full');

    const result = await switchWorkspace('ws-2');

    expect(result?.id).toBe('ws-2');
    expect(mockSwitchSessionWorkspace).toHaveBeenCalledWith('session-1', 'ws-2');
  });

  it('handles null workspace_id gracefully', async () => {
    mockGetSessionContext.mockResolvedValue({
      sessionId: 'session-1',
      session: {
        user_id: 'user-1',
        org_id: 'org-1',
        workspace_id: 'ws-1',
      },
    });

    const result = await switchWorkspace('');

    expect(result).toBeNull();
    expect(mockSwitchSessionWorkspace).toHaveBeenCalledWith('session-1', null);
  });

  it('clears workspace when switching orgs', async () => {
    mockGetSessionContext.mockResolvedValue({
      sessionId: 'session-1',
      session: {
        user_id: 'user-1',
        org_id: 'org-1',
        workspace_id: 'ws-1',
        created_at: Date.now(),
        last_accessed: Date.now(),
      },
    });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetUserOrgs.mockResolvedValue([
      { org_id: 'org-2', org_name: 'Org 2', role: 'member', joined_at: Date.now() },
    ]);
    mockListUserWorkspaces.mockResolvedValue([]);
    mockSwitchSessionOrg.mockResolvedValue(undefined);
    mockGetOrg.mockResolvedValue({
      id: 'org-2',
      name: 'Org 2',
      created_at: Date.now(),
      created_by: 'user-1',
      billing_status: 'free',
      archived: false,
      archived_at: null,
    });

    await switchOrg('org-2');

    expect(mockSwitchSessionOrg).toHaveBeenCalledWith('session-1', 'org-2', null);
  });

  it('auto-selects default workspace when none set', async () => {
    mockGetSessionContext.mockResolvedValue({
      sessionId: 'session-2',
      session: {
        user_id: 'user-1',
        org_id: 'org-1',
        workspace_id: null,
        created_at: Date.now(),
        last_accessed: Date.now(),
      },
    });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetUserOrgs.mockResolvedValue([
      { org_id: 'org-1', org_name: 'Org 1', role: 'member', joined_at: Date.now() },
    ]);
    mockListUserWorkspaces.mockResolvedValue([
      { id: 'ws-1', org_id: 'org-1', name: 'Default', access_level: 'full' },
    ]);
    mockSwitchSessionOrg.mockResolvedValue(undefined);
    mockGetOrg.mockResolvedValue({
      id: 'org-1',
      name: 'Org 1',
      created_at: Date.now(),
      created_by: 'user-1',
      billing_status: 'free',
      archived: false,
      archived_at: null,
    });

    await switchOrg('org-1');

    expect(mockSwitchSessionOrg).toHaveBeenCalledWith('session-2', 'org-1', 'ws-1');
  });

  it('restores last workspace on org switch', async () => {
    mockGetSessionContext.mockResolvedValue({
      sessionId: 'session-3',
      session: {
        user_id: 'user-1',
        org_id: 'org-1',
        workspace_id: 'ws-legacy',
        created_at: Date.now(),
        last_accessed: Date.now(),
      },
    });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetUserOrgs.mockResolvedValue([
      { org_id: 'org-2', org_name: 'Org 2', role: 'member', joined_at: Date.now(), last_workspace_id: 'ws-2' },
    ]);
    mockListUserWorkspaces.mockResolvedValue([
      { id: 'ws-1', org_id: 'org-2', name: 'One', access_level: 'full' },
      { id: 'ws-2', org_id: 'org-2', name: 'Two', access_level: 'full' },
    ]);
    mockSwitchSessionOrg.mockResolvedValue(undefined);
    mockGetOrg.mockResolvedValue({
      id: 'org-2',
      name: 'Org 2',
      created_at: Date.now(),
      created_by: 'user-1',
      billing_status: 'free',
      archived: false,
      archived_at: null,
    });

    await switchOrg('org-2');

    expect(mockSwitchSessionOrg).toHaveBeenCalledWith('session-3', 'org-2', 'ws-2');
  });

  it('handles archived workspace in session', async () => {
    mockGetSessionContext.mockResolvedValue({
      sessionId: 'session-4',
      session: {
        user_id: 'user-1',
        org_id: 'org-2',
        workspace_id: 'ws-archived',
        created_at: Date.now(),
        last_accessed: Date.now(),
      },
    });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetUserOrgs.mockResolvedValue([
      { org_id: 'org-2', org_name: 'Org 2', role: 'member', joined_at: Date.now() },
    ]);
    mockListUserWorkspaces.mockResolvedValue([
      { id: 'ws-active', org_id: 'org-2', name: 'Active', access_level: 'full' },
    ]);
    mockSwitchSessionOrg.mockResolvedValue(undefined);
    mockGetOrg.mockResolvedValue({
      id: 'org-2',
      name: 'Org 2',
      created_at: Date.now(),
      created_by: 'user-1',
      billing_status: 'free',
      archived: false,
      archived_at: null,
    });

    await switchOrg('org-2');

    expect(mockSwitchSessionOrg).toHaveBeenCalledWith('session-4', 'org-2', 'ws-active');
  });
});
