import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireWorkspaceAccess } from '@/lib/server-guards';

const mockGetSessionContext = vi.fn();
const mockGetWorkspace = vi.fn();
const mockGetWorkspaceAccess = vi.fn();
const mockRedirect = vi.fn();

vi.mock('@/lib/auth-context', () => ({
  getSessionContext: (...args: []) => mockGetSessionContext(...args),
}));

vi.mock('@/lib/auth-do', () => ({
  getWorkspace: (...args: [string]) => mockGetWorkspace(...args),
  getWorkspaceAccess: (...args: [string, string]) => mockGetWorkspaceAccess(...args),
}));

vi.mock('next/navigation', () => ({
  redirect: (...args: [string]) => mockRedirect(...args),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

describe('requireWorkspaceAccess', () => {
  const session = {
    user_id: 'user-1',
    org_id: 'org-1',
    workspace_id: 'ws-1',
    created_at: Date.now(),
    last_accessed: Date.now(),
  };

  beforeEach(() => {
    mockGetSessionContext.mockReset();
    mockGetWorkspace.mockReset();
    mockGetWorkspaceAccess.mockReset();
    mockRedirect.mockReset();
  });

  it('returns access when workspace is valid', async () => {
    mockGetSessionContext.mockResolvedValue({ sessionId: 'session-1', session });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('full');

    const result = await requireWorkspaceAccess('ws-1');
    expect(result.access).toBe('full');
  });

  it('returns full access by default for org members', async () => {
    mockGetSessionContext.mockResolvedValue({ sessionId: 'session-1', session });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('full');

    const result = await requireWorkspaceAccess('ws-1');
    expect(result.access).toBe('full');
  });

  it('rejects when workspace is missing', async () => {
    mockGetSessionContext.mockResolvedValue({ sessionId: 'session-1', session });
    mockGetWorkspace.mockResolvedValue(null);

    await expect(requireWorkspaceAccess('ws-1')).rejects.toThrow('Workspace not found');
  });

  it('rejects when access is none', async () => {
    mockGetSessionContext.mockResolvedValue({ sessionId: 'session-1', session });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('none');

    await expect(requireWorkspaceAccess('ws-1')).rejects.toThrow('Workspace not found');
  });

  it('explicit none overrides default full access', async () => {
    mockGetSessionContext.mockResolvedValue({ sessionId: 'session-1', session });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('none');

    await expect(requireWorkspaceAccess('ws-1')).rejects.toThrow('Workspace not found');
  });

  it('rejects write access when read-only', async () => {
    mockGetSessionContext.mockResolvedValue({ sessionId: 'session-1', session });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('read_only');

    await expect(requireWorkspaceAccess('ws-1', { requireWrite: true })).rejects.toThrow('Read-only workspace access');
  });

  it('allows owners to access workspaces when access is full', async () => {
    mockGetSessionContext.mockResolvedValue({ sessionId: 'session-1', session });
    mockGetWorkspace.mockResolvedValue({ id: 'ws-1', org_id: 'org-1' });
    mockGetWorkspaceAccess.mockResolvedValue('full');

    const result = await requireWorkspaceAccess('ws-1', { requireWrite: true });
    expect(result.access).toBe('full');
  });
});
