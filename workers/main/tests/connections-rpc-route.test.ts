import { describe, expect, it } from 'vitest';
import { handleConnectionsRpc } from '../src/routes/connections-rpc.js';
import type { ConnectionsRuntimeEnv } from '../src/connections-runtime.js';
import type { WorkspaceIntegrationRecord } from '../src/workspace.js';

function integration(overrides: Partial<WorkspaceIntegrationRecord>): WorkspaceIntegrationRecord {
  return {
    id: 'int_1',
    integration_type: 'postgres',
    name: 'main',
    category: 'databases',
    auth_method: 'password',
    config: JSON.stringify({ host: 'db.example.com', database: 'app' }),
    credentials_encrypted: '',
    created_by: 'user_1',
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    token_expires_at: null,
    auth_status: 'connected',
    auth_error_code: null,
    auth_error_message: null,
    auth_checked_at: null,
    reauth_required_at: null,
    ...overrides,
  };
}

function envWith(records: WorkspaceIntegrationRecord[]): ConnectionsRuntimeEnv & {
  SANDBOX_PROXY_SECRET: string;
  PROJECT_RUNTIME_PROXY_SECRET: string;
  WORKSPACE_FS: {
    idFromName(name: string): string;
    get(): { getProject(projectId: string): Promise<{ id: string } | null> };
  };
} {
  return {
    INTEGRATION_SECRET_KEY: 'test-secret',
    SANDBOX_PROXY_SECRET: 'sandbox-secret',
    PROJECT_RUNTIME_PROXY_SECRET: 'runtime-secret',
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: () => ({
        getInfo: async () => ({ id: '00000000-0000-0000-0000-000000000001', org_id: 'org_project' }),
        getIntegrations: async () => records,
        updateIntegrationAuthStatus: async () => {},
      }),
    } as unknown as ConnectionsRuntimeEnv['WORKSPACE'],
    WORKSPACE_FS: {
      idFromName: (name: string) => name,
      get: () => ({
        getProject: async (projectId: string) => ({ id: projectId }),
      }),
    },
  };
}

function trackingEnvWith(
  records: WorkspaceIntegrationRecord[],
  workspaceNames: string[],
): ConnectionsRuntimeEnv & {
  SANDBOX_PROXY_SECRET: string;
  PROJECT_RUNTIME_PROXY_SECRET: string;
  WORKSPACE_FS: {
    idFromName(name: string): string;
    get(): { getProject(projectId: string): Promise<{ id: string } | null> };
  };
} {
  const env = envWith(records);
  return {
    ...env,
    WORKSPACE: {
      idFromName: (name: string) => {
        workspaceNames.push(name);
        return name;
      },
      get: () => ({
        getInfo: async () => ({ id: '00000000-0000-0000-0000-000000000001', org_id: 'org_project' }),
        getIntegrations: async () => records,
        updateIntegrationAuthStatus: async () => {},
      }),
    } as unknown as ConnectionsRuntimeEnv['WORKSPACE'],
  };
}

function rpcRequest(body: unknown): Request {
  return new Request('https://worker.test/rpc/connections', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sandbox-secret': 'sandbox-secret',
      'x-chiridion-org-id': 'org_1',
      'x-chiridion-workspace-id': 'ws_1',
      'x-chiridion-user-id': 'user_1',
    },
    body: JSON.stringify(body),
  });
}

function projectRuntimeRpcRequest(body: unknown): Request {
  return new Request('https://worker.test/rpc/connections', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-project-runtime-secret': 'runtime-secret',
      'x-project-runtime-project': 'ca-00000000000000000000000000000001-demo',
    },
    body: JSON.stringify(body),
  });
}

function mixedProjectRuntimeRpcRequest(body: unknown): Request {
  return new Request('https://worker.test/rpc/connections', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-project-runtime-secret': 'runtime-secret',
      'x-project-runtime-project': 'ca-00000000000000000000000000000001-demo',
      'x-chiridion-org-id': 'org_forged',
      'x-chiridion-workspace-id': 'ws_forged',
    },
    body: JSON.stringify(body),
  });
}

function forgedSandboxRpcRequestWithRuntimeSecret(body: unknown): Request {
  return new Request('https://worker.test/rpc/connections', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-project-runtime-secret': 'runtime-secret',
      'x-chiridion-org-id': 'org_forged',
      'x-chiridion-workspace-id': 'ws_forged',
    },
    body: JSON.stringify(body),
  });
}

function projectRuntimeRpcRequestWithSandboxSecret(body: unknown): Request {
  return new Request('https://worker.test/rpc/connections', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-project-runtime-project': 'ca-00000000000000000000000000000001-demo',
      'x-sandbox-secret': 'sandbox-secret',
      'x-chiridion-org-id': 'org_forged',
      'x-chiridion-workspace-id': 'ws_forged',
    },
    body: JSON.stringify(body),
  });
}

describe('connections RPC route', () => {
  it('lists connection methods through the stateless RPC endpoint', async () => {
    const records = [
      integration({ id: 'pg_main', integration_type: 'postgres', name: 'main' }),
    ];
    const req = rpcRequest({ action: 'methods' });

    const response = await handleConnectionsRpc({
      req,
      env: envWith(records) as never,
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    });

    const body = await response.json() as { result?: Array<{ alias: string; methods: Array<{ name: string }> }> };
    expect(response.status).toBe(200);
    expect(body.result).toMatchObject([
      {
        alias: 'postgresMain',
        methods: expect.arrayContaining([expect.objectContaining({ name: 'query' })]),
      },
    ]);
  });

  it('returns connection metadata without credentials', async () => {
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        credentials_encrypted: 'encrypted-value',
      }),
    ];
    const req = rpcRequest({ action: 'list' });

    const response = await handleConnectionsRpc({
      req,
      env: envWith(records) as never,
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    });

    const body = await response.json() as { result?: unknown };
    const connections = body.result;
    expect(connections).toMatchObject([
      {
        id: 'pg_main',
        hasCredentials: true,
      },
    ]);
    expect(JSON.stringify(connections)).not.toContain('encrypted-value');
  });

  it('allows project-runtime proxy auth without exposing connection credentials to the VM', async () => {
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        credentials_encrypted: 'encrypted-value',
      }),
    ];
    const req = projectRuntimeRpcRequest({ action: 'list' });

    const response = await handleConnectionsRpc({
      req,
      env: envWith(records) as never,
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    });

    const body = await response.json() as { result?: unknown };
    const connections = body.result;
    expect(response.status).toBe(200);
    expect(connections).toMatchObject([{ id: 'pg_main', hasCredentials: true }]);
    expect(JSON.stringify(connections)).not.toContain('encrypted-value');
  });

  it('authenticates project-runtime RPC before caller-supplied sandbox identity headers', async () => {
    const records = [
      integration({ id: 'pg_main', integration_type: 'postgres', name: 'main' }),
    ];
    const workspaceNames: string[] = [];
    const req = mixedProjectRuntimeRpcRequest({ action: 'list' });

    const response = await handleConnectionsRpc({
      req,
      env: trackingEnvWith(records, workspaceNames) as never,
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(200);
    expect(workspaceNames).toEqual([
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001',
    ]);
    expect(workspaceNames).not.toContain('ws_forged');
  });

  it('does not accept the project-runtime secret as sandbox identity auth', async () => {
    const req = forgedSandboxRpcRequestWithRuntimeSecret({ action: 'list' });

    const response = await handleConnectionsRpc({
      req,
      env: envWith([]) as never,
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(401);
  });

  it('does not accept the sandbox secret as project-runtime identity auth', async () => {
    const req = projectRuntimeRpcRequestWithSandboxSecret({ action: 'list' });

    const response = await handleConnectionsRpc({
      req,
      env: envWith([]) as never,
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(401);
  });
});
