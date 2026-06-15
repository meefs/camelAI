import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();
const requireWorkspaceAccessMock = vi.fn();
const listProjectsMock = vi.fn();
const listWorkspaceIntegrationRecordsMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/routes/api/workspaces.utils', () => ({
  requireWorkspaceAccess: requireWorkspaceAccessMock,
}));

vi.mock('@/lib/auth-do', () => ({
  listWorkspaceIntegrationRecords: listWorkspaceIntegrationRecordsMock,
}));

vi.mock('../workers/main/src/workspace-filesystem-do', () => ({
  WorkspaceFilesystemClient: class WorkspaceFilesystemClient {
    listProjects = listProjectsMock;
  },
}));

const { loader: projectsLoader } = await import('@/routes/api/workspaces.$id.projects');
const { loader: mentionsLoader } = await import('@/routes/api/workspaces.$id.mentions');

describe('GET /api/workspaces/:id/projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      USER: {},
      ORG: {},
      WORKSPACE: {},
      SESSIONS: {},
      EMAIL_TO_USER: {},
      APP_KV: {},
      TOKEN_SIGNING_SECRET: 'secret',
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
    listWorkspaceIntegrationRecordsMock.mockResolvedValue([]);
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

    const response = await projectsLoader({
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

    const response = await projectsLoader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/projects'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(401);
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it('returns 500 when project listing fails', async () => {
    listProjectsMock.mockRejectedValue(new Error('filesystem unavailable'));

    const response = await projectsLoader({
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

describe('GET /api/workspaces/:id/mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      USER: {},
      ORG: {},
      WORKSPACE: {},
      SESSIONS: {},
      EMAIL_TO_USER: {},
      APP_KV: {},
      TOKEN_SIGNING_SECRET: 'secret',
    });
    requireWorkspaceAccessMock.mockResolvedValue({
      userId: 'user_123',
      orgId: 'org_123',
      workspaceId: 'ws_123',
      access: 'full',
    });
    listWorkspaceIntegrationRecordsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
  });

  it('returns connection and project mention DTOs from one endpoint', async () => {
    listWorkspaceIntegrationRecordsMock.mockResolvedValue([
      {
        id: 'conn_bigquery',
        integration_type: 'bigquery',
        name: 'Prod',
        category: 'databases',
        auth_method: 'api_key',
        config: JSON.stringify({ project_id: 'prod-123' }),
        created_by: 'user_123',
        created_at: 10,
        updated_at: 20,
        credentials_encrypted: 'encrypted',
      },
    ]);
    listProjectsMock.mockResolvedValue([
      {
        id: 'ca-ws_123-camel-site',
        name: 'camel-site',
        description: 'Marketing site rebuild',
        createdAt: '2026-06-10T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
      },
    ]);

    const response = await mentionsLoader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/mentions'),
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
    await expect(response.json()).resolves.toEqual({
      connections: [
        {
          id: 'conn_bigquery',
          integration_type: 'bigquery',
          name: 'Prod',
          category: 'databases',
          auth_method: 'api_key',
          config: { project_id: 'prod-123' },
          created_by: 'user_123',
          created_at: 10,
          updated_at: 20,
          has_credentials: true,
        },
      ],
      projects: [
        {
          kind: 'project',
          id: 'ca-ws_123-camel-site',
          name: 'camel-site',
          description: 'Marketing site rebuild',
          created_at: Date.parse('2026-06-10T12:00:00.000Z'),
          updated_at: Date.parse('2026-06-11T12:00:00.000Z'),
        },
      ],
    });
  });

  it('passes through workspace access failures', async () => {
    requireWorkspaceAccessMock.mockRejectedValue(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const response = await mentionsLoader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/mentions'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(401);
    expect(listWorkspaceIntegrationRecordsMock).not.toHaveBeenCalled();
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it('omits failed source fields so refresh callers preserve stale data', async () => {
    listWorkspaceIntegrationRecordsMock.mockRejectedValue(new Error('auth unavailable'));
    listProjectsMock.mockResolvedValue([
      {
        id: 'ca-ws_123-camel-site',
        name: 'camel-site',
        description: 'Marketing site rebuild',
        createdAt: '2026-06-10T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
      },
    ]);

    const response = await mentionsLoader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/mentions'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('connections');
    expect(body.error).toBe('Failed to load one or more workspace mention sources');
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
  });

  it('omits failed project fields so refresh callers preserve stale projects', async () => {
    listWorkspaceIntegrationRecordsMock.mockResolvedValue([
      {
        id: 'conn_bigquery',
        integration_type: 'bigquery',
        name: 'Prod',
        category: 'databases',
        auth_method: 'api_key',
        config: null,
        created_by: 'user_123',
        created_at: 10,
        updated_at: 20,
        credentials_encrypted: 'encrypted',
      },
    ]);
    listProjectsMock.mockRejectedValue(new Error('filesystem unavailable'));

    const response = await mentionsLoader({
      request: new Request('https://camelai.com/api/workspaces/ws_123/mentions'),
      context: {},
      params: { id: 'ws_123' },
    } as never);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('projects');
    expect(body.error).toBe('Failed to load one or more workspace mention sources');
    expect(body.connections).toEqual([
      {
        id: 'conn_bigquery',
        integration_type: 'bigquery',
        name: 'Prod',
        category: 'databases',
        auth_method: 'api_key',
        config: {},
        created_by: 'user_123',
        created_at: 10,
        updated_at: 20,
        has_credentials: true,
      },
    ]);
  });
});
