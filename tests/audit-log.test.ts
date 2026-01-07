import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getOrgAuditLog } from '@/app/api/orgs/[id]/audit-log/route';
import { GET as getWorkspaceAuditLog } from '@/app/api/workspaces/[id]/audit-log/route';

const mockGetSessionId = vi.fn();

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    getSessionId: (...args: []) => mockGetSessionId(...args),
  };
});

const mockGetSession = vi.fn();
const mockIsOrgAdmin = vi.fn();
const mockGetOrgAuditLog = vi.fn();
const mockGetWorkspaceAuditLog = vi.fn();
const mockGetWorkspace = vi.fn();

vi.mock('@/lib/auth-do', () => ({
  getSession: (...args: [string]) => mockGetSession(...args),
  isOrgAdmin: (...args: [string, string]) => mockIsOrgAdmin(...args),
  getOrgAuditLog: (...args: [string, number, number]) => mockGetOrgAuditLog(...args),
  getWorkspaceAuditLog: (...args: [string, number, number]) => mockGetWorkspaceAuditLog(...args),
  getWorkspace: (...args: [string]) => mockGetWorkspace(...args),
}));

describe('audit logging', () => {
  beforeEach(() => {
    mockGetSessionId.mockReset();
    mockGetSession.mockReset();
    mockIsOrgAdmin.mockReset();
    mockGetOrgAuditLog.mockReset();
    mockGetWorkspaceAuditLog.mockReset();
    mockGetWorkspace.mockReset();
  });

  it('retrieves org audit log with pagination', async () => {
    mockGetSessionId.mockResolvedValue('session-1');
    mockGetSession.mockResolvedValue({
      user_id: 'user-1',
      org_id: 'org-1',
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockIsOrgAdmin.mockResolvedValue(true);
    mockGetOrgAuditLog.mockResolvedValue([
      {
        id: 'log-1',
        action: 'org_created',
        actor_id: 'user-1',
        target_id: 'org-1',
        details: { name: 'Org' },
        created_at: Date.now(),
      },
    ]);

    const orgUrl = 'http://localhost/api/orgs/org-1/audit-log?limit=10&offset=5';
    const request = Object.assign(new Request(orgUrl), { nextUrl: new URL(orgUrl) });
    const response = await getOrgAuditLog(request as Request as any, { params: Promise.resolve({ id: 'org-1' }) });

    expect(response.status).toBe(200);
    expect(mockGetOrgAuditLog).toHaveBeenCalledWith('org-1', 10, 5);
    const payload = await response.json() as Array<{ actor_id: string; target_id: string | null; details: Record<string, unknown> }>;
    expect(payload[0].actor_id).toBe('user-1');
    expect(payload[0].target_id).toBe('org-1');
    expect(payload[0].details).toMatchObject({ name: 'Org' });
  });

  it('retrieves workspace audit log with pagination', async () => {
    mockGetSessionId.mockResolvedValue('session-2');
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

    const workspaceUrl = 'http://localhost/api/workspaces/ws-1/audit-log?limit=25&offset=0';
    const request = Object.assign(new Request(workspaceUrl), { nextUrl: new URL(workspaceUrl) });
    const response = await getWorkspaceAuditLog(request as Request as any, { params: Promise.resolve({ id: 'ws-1' }) });

    expect(response.status).toBe(200);
    expect(mockGetWorkspaceAuditLog).toHaveBeenCalledWith('ws-1', 25, 0);
    const payload = await response.json() as Array<{ actor_id: string; details: Record<string, unknown> | null }>;
    expect(payload[0].actor_id).toBe('user-1');
    expect(payload[0].details).toMatchObject({ changes: ['name'] });
  });
});
