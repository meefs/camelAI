import { describe, expect, it } from 'vitest';
import {
  getConnection,
  listConnectionTools,
  listConnections,
  type ConnectionsRuntimeEnv,
} from '../src/connections-runtime.js';
import type { WorkspaceIntegrationRecord } from '../src/workspace.js';

function integration(overrides: Partial<WorkspaceIntegrationRecord>): WorkspaceIntegrationRecord {
  return {
    id: 'int_1',
    integration_type: 'stripe',
    name: 'prod',
    category: 'payments',
    auth_method: 'api_key',
    config: '{}',
    credentials_encrypted: '',
    created_by: 'user_1',
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    token_expires_at: null,
    ...overrides,
  };
}

function envWith(records: WorkspaceIntegrationRecord[]): ConnectionsRuntimeEnv {
  return {
    INTEGRATION_SECRET_KEY: 'test-secret',
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: () => ({
        getIntegrations: async () => records,
      }),
    } as unknown as ConnectionsRuntimeEnv['WORKSPACE'],
  };
}

const context = {
  orgId: 'org_1',
  workspaceId: 'ws_1',
  userId: 'user_1',
};

describe('connections runtime', () => {
  it('lists connected integrations with MCP capabilities', async () => {
    const records = [
      integration({ id: 'stripe_prod', integration_type: 'stripe', name: 'prod' }),
      integration({ id: 'pg_main', integration_type: 'postgres', name: 'main', category: 'database' }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'stripe_prod',
        type: 'stripe',
        name: 'prod',
        capabilities: ['mcp_tools'],
        nativeMcp: { serverName: 'stripe', transport: 'streamable_http', directConnect: false },
      },
      {
        id: 'pg_main',
        type: 'postgres',
        name: 'main',
        capabilities: ['query_database'],
        nativeMcp: null,
      },
    ]);
  });

  it('requires ids when a connection query is ambiguous', async () => {
    const records = [
      integration({ id: 'stripe_prod', integration_type: 'stripe', name: 'prod' }),
      integration({ id: 'stripe_test', integration_type: 'stripe', name: 'test' }),
    ];

    await expect(getConnection(envWith(records), context, 'stripe')).rejects.toMatchObject({
      message: 'Multiple connected integrations matched "stripe". Retry with an integration id.',
      status: 409,
      matches: [
        { id: 'stripe_prod', type: 'stripe', name: 'prod' },
        { id: 'stripe_test', type: 'stripe', name: 'test' },
      ],
    });
  });

  it('rejects MCP tool listing for non-MCP connection types', async () => {
    const records = [
      integration({ id: 'pg_main', integration_type: 'postgres', name: 'main', category: 'database' }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'pg_main')).rejects.toMatchObject({
      message: 'Connection type "postgres" does not have MCP-backed tools.',
      status: 404,
    });
  });
});
