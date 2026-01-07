import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DELETE as archiveWorkspace, GET as getWorkspace } from '@/app/api/workspaces/[id]/route';
import { DELETE as deleteIntegration } from '@/app/api/workspaces/[id]/integrations/[integrationId]/route';

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
const mockIsOrgAdmin = vi.fn();
const mockArchiveWorkspace = vi.fn();
const mockGetWorkspaceIntegration = vi.fn();
const mockDeleteWorkspaceIntegration = vi.fn();

vi.mock('@/lib/auth-do', () => ({
  getSession: (...args: [string]) => mockGetSession(...args),
  getWorkspace: (...args: [string]) => mockGetWorkspace(...args),
  isOrgAdmin: (...args: [string, string]) => mockIsOrgAdmin(...args),
  archiveWorkspace: (...args: [string, string]) => mockArchiveWorkspace(...args),
  getWorkspaceIntegration: (...args: [string, string]) => mockGetWorkspaceIntegration(...args),
  deleteWorkspaceIntegration: (...args: [string, string, string]) => mockDeleteWorkspaceIntegration(...args),
}));

describe('soft delete', () => {
  beforeEach(() => {
    mockGetSessionId.mockReset();
    mockGetSession.mockReset();
    mockGetWorkspace.mockReset();
    mockIsOrgAdmin.mockReset();
    mockArchiveWorkspace.mockReset();
    mockGetWorkspaceIntegration.mockReset();
    mockDeleteWorkspaceIntegration.mockReset();
  });

  it('archives workspace without hard delete', async () => {
    mockGetSessionId.mockResolvedValue('session-1');
    mockGetSession.mockResolvedValue({
      user_id: 'user-1',
      org_id: 'org-1',
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockIsOrgAdmin.mockResolvedValue(true);
    mockArchiveWorkspace.mockResolvedValue({
      id: 'ws-1',
      org_id: 'org-1',
      name: 'Archived Workspace',
      archived: true,
      archived_at: Date.now(),
    });

    const response = await archiveWorkspace(new Request('http://localhost/api/workspaces/ws-1', {
      method: 'DELETE',
    }) as Request as any, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    const payload = await response.json() as { archived: boolean; name: string };
    expect(payload.archived).toBe(true);
    expect(payload.name).toBe('Archived Workspace');
  });

  it('archived workspace returns null from getWorkspace', async () => {
    mockGetSessionId.mockResolvedValue('session-2');
    mockGetSession.mockResolvedValue({
      user_id: 'user-1',
      org_id: 'org-1',
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockGetWorkspace.mockResolvedValue(null);

    const response = await getWorkspace(new Request('http://localhost/api/workspaces/ws-1', {
      method: 'GET',
    }) as Request as any, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(404);
  });

  it('soft deletes integrations via delete route', async () => {
    mockGetSessionId.mockResolvedValue('session-3');
    mockGetSession.mockResolvedValue({
      user_id: 'user-1',
      org_id: 'org-1',
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockIsOrgAdmin.mockResolvedValue(true);
    mockGetWorkspaceIntegration.mockResolvedValue({
      id: 'int-1',
      integration_type: 'airtable',
      name: 'Airtable',
    });
    mockDeleteWorkspaceIntegration.mockResolvedValue(undefined);

    const response = await deleteIntegration(new Request('http://localhost/api/workspaces/ws-1/integrations/int-1', {
      method: 'DELETE',
    }) as Request as any, { params: Promise.resolve({ id: 'ws-1', integrationId: 'int-1' }) });

    expect(response.status).toBe(200);
    expect(mockDeleteWorkspaceIntegration).toHaveBeenCalledWith('ws-1', 'int-1', 'user-1');
  });
});
