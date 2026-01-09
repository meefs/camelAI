import { describe, it, expect, vi, beforeEach } from 'vitest';
import { archiveWorkspace, getWorkspace } from '@/lib/server-actions/workspace';
import { deleteWorkspaceIntegration } from '@/lib/server-actions/integrations';

const mockRequireSession = vi.fn();

vi.mock('@/lib/server-guards', () => ({
  requireSession: () => mockRequireSession(),
}));

const mockGetSessionContext = vi.fn();

vi.mock('@/lib/auth-context', () => ({
  getSessionContext: () => mockGetSessionContext(),
}));

const mockGetWorkspace = vi.fn();
const mockIsOrgAdmin = vi.fn();
const mockArchiveWorkspace = vi.fn();
const mockGetWorkspaceAccess = vi.fn();
const mockListOrgWorkspaces = vi.fn();
const mockSwitchSessionWorkspace = vi.fn();
const mockDeleteWorkspaceIntegration = vi.fn();
const mockGetWorkspaceIntegration = vi.fn();

vi.mock('@/lib/auth-do', () => ({
  getWorkspace: (...args: [string]) => mockGetWorkspace(...args),
  isOrgAdmin: (...args: [string, string]) => mockIsOrgAdmin(...args),
  archiveWorkspace: (...args: [string, string]) => mockArchiveWorkspace(...args),
  getWorkspaceAccess: (...args: [string, string]) => mockGetWorkspaceAccess(...args),
  listOrgWorkspaces: (...args: [string]) => mockListOrgWorkspaces(...args),
  switchSessionWorkspace: (...args: [string, string]) => mockSwitchSessionWorkspace(...args),
  deleteWorkspaceIntegration: (...args: [string, string, string]) => mockDeleteWorkspaceIntegration(...args),
  getWorkspaceIntegration: (...args: [string, string]) => mockGetWorkspaceIntegration(...args),
}));

describe('soft delete', () => {
  beforeEach(() => {
    mockRequireSession.mockReset();
    mockGetSessionContext.mockReset();
    mockGetWorkspace.mockReset();
    mockIsOrgAdmin.mockReset();
    mockArchiveWorkspace.mockReset();
    mockGetWorkspaceAccess.mockReset();
    mockListOrgWorkspaces.mockReset();
    mockSwitchSessionWorkspace.mockReset();
    mockDeleteWorkspaceIntegration.mockReset();
    mockGetWorkspaceIntegration.mockReset();
  });

  it('archives workspace without hard delete', async () => {
    mockRequireSession.mockResolvedValue({
      user_id: 'user-1',
      org_id: 'org-1',
      workspace_id: 'ws-1',
    });
    mockGetSessionContext.mockResolvedValue({
      sessionId: 'session-1',
      session: { user_id: 'user-1', org_id: 'org-1', workspace_id: 'ws-1' },
    });
    mockGetWorkspace.mockResolvedValue({
      id: 'ws-1',
      org_id: 'org-1',
      name: 'Workspace 1',
      description: null,
      created_by: 'user-1',
      created_at: Date.now(),
      avatar: { color: '#000000', content: 'W1' },
      archived: false,
      archived_at: null,
    });
    mockIsOrgAdmin.mockResolvedValue(true);
    mockListOrgWorkspaces.mockResolvedValue([
      { id: 'ws-1', org_id: 'org-1' },
      { id: 'ws-2', org_id: 'org-1' },
    ]);
    mockArchiveWorkspace.mockResolvedValue({
      id: 'ws-1',
      org_id: 'org-1',
      name: 'Archived Workspace',
      description: null,
      created_by: 'user-1',
      created_at: Date.now(),
      avatar: { color: '#000000', content: 'AW' },
      archived: true,
      archived_at: Date.now(),
    });

    const result = await archiveWorkspace('ws-1');

    expect(result.archived).toBe(true);
    expect(result.name).toBe('Archived Workspace');
  });

  it('archived workspace returns null from getWorkspace', async () => {
    mockRequireSession.mockResolvedValue({
      user_id: 'user-1',
      org_id: 'org-1',
      workspace_id: 'ws-other',
    });
    mockGetWorkspace.mockResolvedValue(null);

    const result = await getWorkspace('ws-1');

    expect(result).toBeNull();
  });

  it('soft deletes integrations via delete route', async () => {
    mockRequireSession.mockResolvedValue({
      user_id: 'user-1',
      org_id: 'org-1',
      workspace_id: 'ws-1',
    });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('full');
    mockIsOrgAdmin.mockResolvedValue(true);
    mockGetWorkspaceIntegration.mockResolvedValue({
      id: 'int-1',
      integration_type: 'airtable',
      name: 'Airtable',
    });
    mockDeleteWorkspaceIntegration.mockResolvedValue(undefined);

    const result = await deleteWorkspaceIntegration('ws-1', 'int-1');

    expect(result.success).toBe(true);
    expect(mockDeleteWorkspaceIntegration).toHaveBeenCalledWith('ws-1', 'int-1', 'user-1');
  });
});
