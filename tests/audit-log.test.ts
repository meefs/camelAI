import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkspaceAuditLog } from '@/lib/server-actions/workspace';

const mockRequireSession = vi.fn();

vi.mock('@/lib/server-guards', () => ({
  requireSession: () => mockRequireSession(),
}));

const mockIsOrgAdmin = vi.fn();
const mockGetOrgAuditLog = vi.fn();
const mockGetWorkspaceAuditLog = vi.fn();
const mockGetWorkspace = vi.fn();
const mockGetWorkspaceAccess = vi.fn();

vi.mock('@/lib/auth-do', () => ({
  isOrgAdmin: (...args: [string, string]) => mockIsOrgAdmin(...args),
  getOrgAuditLog: (...args: [string, number?, number?]) => mockGetOrgAuditLog(...args),
  getWorkspaceAuditLog: (...args: [string, number?, number?]) => mockGetWorkspaceAuditLog(...args),
  getWorkspace: (...args: [string]) => mockGetWorkspace(...args),
  getWorkspaceAccess: (...args: [string, string]) => mockGetWorkspaceAccess(...args),
}));

describe('audit logging server actions', () => {
  beforeEach(() => {
    mockRequireSession.mockReset();
    mockIsOrgAdmin.mockReset();
    mockGetOrgAuditLog.mockReset();
    mockGetWorkspaceAuditLog.mockReset();
    mockGetWorkspace.mockReset();
    mockGetWorkspaceAccess.mockReset();
  });

  it('retrieves workspace audit log with pagination', async () => {
    mockRequireSession.mockResolvedValue({
      user_id: 'user-1',
      org_id: 'org-1',
      workspace_id: 'ws-1',
    });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('full');
    mockIsOrgAdmin.mockResolvedValue(true);
    mockGetWorkspaceAuditLog.mockResolvedValue([
      {
        id: 'log-2',
        action: 'workspace_updated',
        actor_id: 'user-1',
        target_id: null,
        details: { changes: ['name'] },
        created_at: Date.now(),
      },
    ]);

    const result = await getWorkspaceAuditLog('ws-1', 25, 0);

    expect(mockGetWorkspaceAuditLog).toHaveBeenCalledWith('ws-1', 25, 0);
    expect(result[0].actor_id).toBe('user-1');
    expect(result[0].details).toMatchObject({ changes: ['name'] });
  });

  it('rejects non-admin users', async () => {
    mockRequireSession.mockResolvedValue({
      user_id: 'user-2',
      org_id: 'org-1',
      workspace_id: 'ws-1',
    });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('full');
    mockIsOrgAdmin.mockResolvedValue(false);

    await expect(getWorkspaceAuditLog('ws-1')).rejects.toThrow('Only admins can view audit logs');
  });
});
