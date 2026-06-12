import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();
const requireWorkspaceAccessMock = vi.fn();
const listProjectsMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/routes/api/workspaces.utils', () => ({
  requireWorkspaceAccess: requireWorkspaceAccessMock,
}));

vi.mock('../workers/main/src/workspace-filesystem-do', () => ({
  WorkspaceFilesystemClient: class WorkspaceFilesystemClient {
    listProjects = listProjectsMock;
  },
}));

const { loader } = await import('@/routes/api/workspaces.$id.projects');

describe('GET /api/workspaces/:id/projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      WORKSPACE_FS: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          listProjects: listProjectsMock,
        })),
      },
    });
    requireWorkspaceAccessMock.mockResolvedValue({
      userId: 'user_123',
      orgId: 'org_123',
      workspaceId: 'ws_123',
      access: 'full',
    });
  });

  it('returns mention project DTOs excluding clones and registry-only fields', async () => {
    listProjectsMock.mockResolvedValue([
      {
        id: 'ca-ws_123-camel-site',
        name: 'camel-site',
        description: 'Marketing site rebuild',
        defaultVmId: 'vm_hidden',
        artifactRemote: 'hidden.git',
        artifactStatus: 'ready',
        createdAt: '2026-06-10T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
        clones: [
          {
            id: 'ca-ws_123-camel-site-v2',
            name: 'camel-site-v2',
            description: 'Hero experiment',
            defaultVmId: 'vm_clone_hidden',
            artifactStatus: 'creating',
            createdAt: '2026-06-11T12:00:00.000Z',
            updatedAt: '2026-06-11T13:00:00.000Z',
          },
        ],
      },
    ]);

    const response = await loader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/projects'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(requireWorkspaceAccessMock).toHaveBeenCalledWith(
      expect.any(Request),
      {},
      'ws_123',
    );
    const body = await response.json() as { projects: Array<Record<string, unknown>> };
    expect(body.projects).toEqual([
      {
        kind: 'project',
        id: 'ca-ws_123-camel-site',
        name: 'camel-site',
        description: 'Marketing site rebuild',
        created_at: Date.parse('2026-06-10T12:00:00.000Z'),
        updated_at: Date.parse('2026-06-11T12:00:00.000Z'),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('project_kind');
    expect(JSON.stringify(body)).not.toContain('cloned_from_name');
    expect(JSON.stringify(body)).not.toContain('camel-site-v2');
    expect(JSON.stringify(body)).not.toContain('defaultVmId');
    expect(JSON.stringify(body)).not.toContain('artifactStatus');
    expect(JSON.stringify(body)).not.toContain('artifactRemote');
  });

  it('passes through workspace access failures', async () => {
    requireWorkspaceAccessMock.mockRejectedValue(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const response = await loader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/projects'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(401);
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it('returns 500 when project listing fails', async () => {
    listProjectsMock.mockRejectedValue(new Error('filesystem unavailable'));

    const response = await loader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/projects'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to load workspace projects',
    });
  });
});
