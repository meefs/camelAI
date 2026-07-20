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
} {
  const orgStub = {
    getWorkspaceIntegrations: async () => records,
    getWorkspaceIntegration: async (_workspaceId: string, integrationId: string) =>
      records.find((record) => record.id === integrationId) ?? null,
    updateWorkspaceIntegrationAuthStatus: async () => {},
    updateWorkspaceIntegrationVerification: async () => true,
  };

  return {
    INTEGRATION_SECRET_KEY: 'test-secret',
    SANDBOX_PROXY_SECRET: 'sandbox-secret',
    ORG: {
      idFromName: (name: string) => name,
      get: () => orgStub,
    } as unknown as ConnectionsRuntimeEnv['ORG'],
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

function forgedSandboxRpcRequestWithoutSecret(body: unknown): Request {
  return new Request('https://worker.test/rpc/connections', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
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
      integration({
        id: 'resend_txn',
        integration_type: 'resend',
        name: 'txn',
        category: 'communication',
        auth_method: 'api_key',
        config: '{}',
      }),
    ];
    const req = rpcRequest({ action: 'methods' });

    const response = await handleConnectionsRpc({
      req,
      env: envWith(records) as never,
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    });

    const body = await response.json() as {
      result?: Array<{ alias: string; methods: Array<{ name: string; tool?: string }> }>;
    };
    expect(response.status).toBe(200);
    expect(body.result).toMatchObject([
      {
        alias: 'postgresMain',
        methods: expect.arrayContaining([expect.objectContaining({ name: 'query' })]),
      },
      {
        alias: 'resendTxn',
        methods: expect.arrayContaining([
          expect.objectContaining({ name: 'fetch', tool: 'authenticated_fetch' }),
        ]),
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

  it('verifies a connection through the stateless RPC endpoint', async () => {
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'inventory',
        category: 'saas',
        auth_method: 'api_key',
        config: JSON.stringify({ base_url: 'https://api.example.com', auth_type: 'none' }),
      }),
    ];
    const req = rpcRequest({ action: 'verify', query: { id: 'custom_api' } });

    const response = await handleConnectionsRpc({
      req,
      env: envWith(records) as never,
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        status: 'configured',
        live: false,
        strategy: 'http_configuration',
      },
    });
  });

  it('rejects RPC requests without a valid sandbox proxy secret', async () => {
    const req = forgedSandboxRpcRequestWithoutSecret({ action: 'list' });

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
