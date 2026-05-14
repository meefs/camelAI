import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import {
  callConnectionTool,
  getConnection,
  findConnectionMethodEntry,
  invokeConnectionMethod,
  listConnectionMethods,
  listConnectionTools,
  listConnections,
  testConnectionMethodEntry,
  type ConnectionsRuntimeEnv,
} from '../src/connections-runtime.js';
import { handleIntegrationsMcp } from '../src/routes/integrations-mcp.js';
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
    auth_status: 'connected',
    auth_error_code: null,
    auth_error_message: null,
    auth_checked_at: null,
    reauth_required_at: null,
    ...overrides,
  };
}

function envWith(
  records: WorkspaceIntegrationRecord[],
  onAuthStatus?: (id: string, status: string, code: string | null, message: string | null) => void
): ConnectionsRuntimeEnv {
  return {
    INTEGRATION_SECRET_KEY: 'test-secret',
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: () => ({
        getIntegrations: async () => records,
        updateIntegrationAuthStatus: async (
          id: string,
          status: string,
          code: string | null,
          message: string | null
        ) => {
          onAuthStatus?.(id, status, code, message);
        },
      }),
    } as unknown as ConnectionsRuntimeEnv['WORKSPACE'],
  };
}

const context = {
  orgId: 'org_1',
  workspaceId: 'ws_1',
  userId: 'user_1',
};

async function encryptedCredentials(credentials: Record<string, unknown>): Promise<string> {
  return encryptCredentials(credentials, 'test-secret');
}

describe('connections runtime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists connected integrations with MCP capabilities', async () => {
    const records = [
      integration({ id: 'bq_prod', integration_type: 'bigquery', name: 'analytics', category: 'databases' }),
      integration({ id: 'stripe_prod', integration_type: 'stripe', name: 'prod' }),
      integration({ id: 'pg_main', integration_type: 'postgres', name: 'main', category: 'database' }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'bq_prod',
        type: 'bigquery',
        name: 'analytics',
        capabilities: ['mcp_tools', 'camelai_hosted_mcp'],
        nativeMcp: { serverName: 'bigquery', transport: 'streamable_http', directConnect: false },
      },
      {
        id: 'stripe_prod',
        type: 'stripe',
        name: 'prod',
        capabilities: ['mcp_tools', 'first_party_mcp_brokered'],
        nativeMcp: {
          serverName: 'stripe',
          transport: 'streamable_http',
          directConnect: false,
          brokered: true,
          preferredMode: 'brokered',
          broker: {
            url: 'https://mcp.stripe.com',
            brokerPath: '/mcp/integrations/native/stripe_prod',
            authStrategy: 'connected_credentials_broker',
          },
        },
      },
      {
        id: 'pg_main',
        type: 'postgres',
        name: 'main',
        capabilities: ['mcp_tools', 'camelai_hosted_mcp'],
        nativeMcp: { serverName: 'postgres', transport: 'streamable_http', directConnect: false },
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

  it('surfaces reauth metadata for unhealthy connections', async () => {
    const records = [
      integration({
        id: 'notion_workspace',
        integration_type: 'notion',
        name: 'workspace',
        category: 'saas',
        auth_method: 'oauth2',
        auth_status: 'needs_reauth',
        auth_error_code: 'AUTH_REAUTH_REQUIRED',
        auth_error_message: 'Refresh token was revoked.',
        auth_checked_at: 1_700_000_000_000,
        reauth_required_at: 1_700_000_000_000,
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'notion_workspace',
        authStatus: 'needs_reauth',
        authErrorCode: 'AUTH_REAUTH_REQUIRED',
        authErrorMessage: 'Refresh token was revoked.',
        authCheckedAt: '2023-11-14T22:13:20.000Z',
        reauthRequiredAt: '2023-11-14T22:13:20.000Z',
        reauthUrl: '/api/integrations/notion/oauth?workspace_id=ws_1&integration_id=notion_workspace&redirect=%2Fconnections',
      },
    ]);
  });

  it('marks first-party MCP broker credentials stale when the provider returns 401', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'initialize') {
        return new Response('invalid_token', { status: 401 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const updates: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'intercom_support',
        integration_type: 'intercom',
        name: 'support',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'intercom-token' }),
      }),
    ];

    await expect(
      listConnectionTools(envWith(records, (id, status, code, message) => {
        updates.push({ id, status, code, message });
      }), context, 'intercom_support')
    ).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_REAUTH_REQUIRED',
      data: {
        authStatus: 'needs_reauth',
        reauthUrl: '/connections?connection=intercom_support&reauth=1',
      },
    });
    expect(updates).toMatchObject([
      {
        id: 'intercom_support',
        status: 'needs_reauth',
        code: 'AUTH_REAUTH_REQUIRED',
      },
    ]);
  });

  it('lists camelAI-hosted BigQuery MCP tools', async () => {
    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project', dataset: 'warehouse' }),
      }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'bq_prod')).resolves.toMatchObject([
      { name: 'list_dataset_ids' },
      { name: 'get_dataset_info' },
      { name: 'list_table_ids' },
      { name: 'get_table_info' },
      { name: 'execute_sql_readonly' },
    ]);
  });

  it('lists method aliases for connection tools', async () => {
    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project', dataset: 'warehouse' }),
      }),
    ];

    await expect(listConnectionMethods(envWith(records), context)).resolves.toMatchObject([
      {
        alias: 'bigqueryAnalytics',
        connection: { id: 'bq_prod', type: 'bigquery', name: 'analytics' },
        methods: [
          { name: 'query', tool: 'execute_sql_readonly', example: 'await connections.bigqueryAnalytics.query({ query: "SELECT 1 AS ok" })' },
          { name: 'listDatasetIds', tool: 'list_dataset_ids' },
          { name: 'getDatasetInfo', tool: 'get_dataset_info' },
          { name: 'listTableIds', tool: 'list_table_ids' },
          { name: 'getTableInfo', tool: 'get_table_info' },
          { name: 'executeSqlReadonly', tool: 'execute_sql_readonly' },
          { name: 'executeQuery', tool: 'execute_sql_readonly' },
        ],
      },
    ]);
  });

  it('finds one method catalog entry by type and exposes copyable examples', async () => {
    const records = [
      integration({
        id: 'clickhouse_events',
        integration_type: 'clickhouse',
        name: 'events',
        category: 'databases',
        config: JSON.stringify({ host: 'clickhouse.example', port: 8443, database: 'default' }),
        credentials_encrypted: await encryptedCredentials({ username: 'default', password: 'secret' }),
      }),
    ];

    const entry = await findConnectionMethodEntry(envWith(records), context, { type: 'clickhouse' });

    expect(entry).toMatchObject({
      alias: 'clickhouseEvents',
      connection: { id: 'clickhouse_events', type: 'clickhouse' },
    });
    expect(entry.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'query',
        tool: 'execute_sql_readonly',
        example: 'await connections.clickhouseEvents.query({ query: "SELECT 1 AS ok" })',
      }),
    ]));
  });

  it('lists a fetch method for custom API connections', async () => {
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com/v1',
          auth_type: 'bearer',
        }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(listConnectionMethods(envWith(records), context)).resolves.toMatchObject([
      {
        alias: 'otherCustomApi',
        connection: {
          id: 'custom_api',
          type: 'other',
          name: 'custom-api',
          capabilities: ['authenticated_fetch'],
        },
        methods: [
          {
            name: 'fetch',
            tool: 'authenticated_fetch',
            example: 'await connections.otherCustomApi.fetch("/v1/items", { method: "GET" })',
          },
        ],
      },
    ]);
  });

  it('invokes custom API fetch methods with stored auth', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/v1/items?limit=2&tag=a&tag=b');
      expect(init?.method).toBe('POST');
      expect(Object.fromEntries(new Headers(init?.headers).entries())).toMatchObject({
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({ active: true });
      return new Response(JSON.stringify({ items: [{ id: 1 }] }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com/v1',
          auth_type: 'bearer',
        }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: {
        input: 'items?limit=2&tag=a&tag=b',
        init: {
          method: 'POST',
          body: { active: true },
        },
      },
    })).resolves.toMatchObject({
      status: 201,
      bodyText: JSON.stringify({ items: [{ id: 1 }] }),
      truncated: false,
    });
  });

  it('allows custom API fetches to absolute http URLs for migration compatibility', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://uploads.example.net/items');
      expect(init?.method).toBe('GET');
      expect(Object.fromEntries(new Headers(init?.headers).entries())).toMatchObject({
        authorization: 'Bearer secret-token',
      });
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com',
          auth_type: 'bearer',
        }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: {
        input: 'https://uploads.example.net/items',
      },
    })).resolves.toMatchObject({
      status: 200,
      bodyText: 'ok',
    });
  });

  it('runs a database smoke test through the normalized query method', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://clickhouse.example:8443/?database=default');
      expect(String(init?.body)).toBe('SELECT 1 AS ok LIMIT 100 FORMAT JSON');
      return new Response(JSON.stringify({
        data: [{ ok: 1 }],
        rows: 1,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'clickhouse_events',
        integration_type: 'clickhouse',
        name: 'events',
        category: 'databases',
        config: JSON.stringify({ host: 'clickhouse.example', port: 8443, database: 'default' }),
        credentials_encrypted: await encryptedCredentials({ username: 'default', password: 'secret' }),
      }),
    ];

    await expect(testConnectionMethodEntry(envWith(records), context, 'clickhouse')).resolves.toMatchObject({
      ok: true,
      alias: 'clickhouseEvents',
      method: 'query',
      result: {
        content: [
          {
            text: JSON.stringify({
              data: [{ ok: 1 }],
              rows: 1,
            }, null, 2),
          },
        ],
      },
    });
  });

  it('rejects custom API fetch URLs with embedded credentials', async () => {
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com',
          auth_type: 'none',
        }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: {
        input: 'https://user:pass@example.net/items',
      },
    })).rejects.toMatchObject({
      message: 'fetch input must not include embedded credentials.',
      status: 400,
    });
  });

  it('marks Notion as first-party remote MCP brokered by camelAI', async () => {
    const records = [
      integration({
        id: 'notion_workspace',
        integration_type: 'notion',
        name: 'workspace',
        category: 'saas',
        auth_method: 'oauth2',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'notion_workspace',
        type: 'notion',
        capabilities: ['mcp_tools', 'first_party_mcp_brokered'],
        nativeMcp: {
          serverName: 'notion',
          directConnect: false,
          brokered: true,
          authStrategy: 'connected_credentials_broker',
          preferredMode: 'brokered',
          broker: {
            brokerPath: '/mcp/integrations/native/notion_workspace',
          },
        },
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'notion_workspace')).rejects.toMatchObject({
      message: 'Connected notion integration does not have a usable token credential for MCP proxying.',
      status: 401,
      code: 'AUTH_REAUTH_REQUIRED',
      data: {
        authStatus: 'needs_reauth',
        reauthUrl: '/api/integrations/notion/oauth?workspace_id=ws_1&integration_id=notion_workspace&redirect=%2Fconnections',
      },
    });
  });

  it('marks Cloudflare as first-party remote MCP brokered by camelAI', async () => {
    const records = [
      integration({
        id: 'cf_account',
        integration_type: 'cloudflare',
        name: 'account',
        category: 'cloud_providers',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'cf_account',
        type: 'cloudflare',
        capabilities: ['mcp_tools', 'first_party_mcp_brokered'],
        nativeMcp: {
          serverName: 'cloudflare',
          directConnect: false,
          brokered: true,
          authStrategy: 'connected_credentials_broker',
          preferredMode: 'brokered',
        },
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'cf_account')).rejects.toMatchObject({
      message: 'Connected cloudflare integration does not have a usable token credential for MCP proxying.',
      status: 400,
    });
  });

  it('marks Salesforce as first-party remote MCP brokered by camelAI', async () => {
    const records = [
      integration({
        id: 'salesforce_prod',
        integration_type: 'salesforce',
        name: 'prod',
        category: 'saas',
        auth_method: 'oauth2',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'salesforce_prod',
        type: 'salesforce',
        capabilities: ['mcp_tools', 'first_party_mcp_brokered'],
        nativeMcp: {
          serverName: 'salesforce',
          directConnect: false,
          brokered: true,
          authStrategy: 'connected_credentials_broker',
          preferredMode: 'brokered',
        },
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'salesforce_prod')).rejects.toMatchObject({
      message: 'Connected salesforce integration does not have a usable token credential for MCP proxying.',
      status: 401,
      code: 'AUTH_REAUTH_REQUIRED',
    });
  });

  it('marks Supabase as first-party remote MCP brokered by camelAI', async () => {
    const records = [
      integration({
        id: 'supabase_main',
        integration_type: 'supabase',
        name: 'main',
        category: 'databases',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'supabase_main',
        type: 'supabase',
        capabilities: ['mcp_tools', 'first_party_mcp_brokered'],
        nativeMcp: {
          serverName: 'supabase',
          transport: 'streamable_http',
          directConnect: false,
          brokered: true,
          authStrategy: 'connected_credentials_broker',
          preferredMode: 'brokered',
        },
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'supabase_main')).rejects.toMatchObject({
      message: 'Connected supabase integration does not have a usable token credential for MCP proxying.',
      status: 400,
    });
  });

  it('does not advertise Square MCP until SSE transport is supported', async () => {
    const records = [
      integration({
        id: 'square_prod',
        integration_type: 'square',
        name: 'prod',
        category: 'saas',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'square_prod',
        type: 'square',
        capabilities: ['authenticated_fetch'],
        nativeMcp: null,
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'square_prod')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('supports both direct Intercom MCP metadata and brokered tools through connected credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(url)).toBe('https://mcp.intercom.com/mcp');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer intercom-token',
        accept: 'application/json, text/event-stream',
      });
      expect(body).toMatchObject({ jsonrpc: '2.0' });
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: body.method === 'tools/list'
          ? { tools: [{ name: 'search' }] }
          : {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'intercom' },
            },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'intercom_support',
        integration_type: 'intercom',
        name: 'support',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'intercom-token' }),
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'intercom_support',
        type: 'intercom',
        capabilities: ['mcp_tools', 'first_party_mcp_brokered'],
        nativeMcp: {
          serverName: 'intercom',
          directConnect: false,
          brokered: true,
          preferredMode: 'brokered',
          broker: {
            url: 'https://mcp.intercom.com/mcp',
            brokerPath: '/mcp/integrations/native/intercom_support',
            authStrategy: 'connected_credentials_broker',
          },
        },
      },
    ]);

    const tools = await listConnectionTools(envWith(records), context, 'intercom_support');
    expect(tools).toMatchObject([{ name: 'search' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/list',
    });
  });

  it('invokes connection tools by method alias', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'search_conversations', inputSchema: { type: 'object' } }] }
        : body.method === 'tools/call'
          ? { results: [{ id: 'conv_1' }] }
          : {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'intercom' },
            };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'intercom_support',
        integration_type: 'intercom',
        name: 'support',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'intercom-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'intercomSupport',
      method: 'searchConversations',
      input: { query: 'refund' },
    })).resolves.toEqual({ results: [{ id: 'conv_1' }] });

    const toolCall = fetchMock.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)))
      .find((body) => body.method === 'tools/call');
    expect(toolCall).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'search_conversations',
        arguments: { query: 'refund' },
      },
    });
  });

  it('surfaces discovery auth errors before method lookup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('invalid token', { status: 401 })
    ));
    const records = [
      integration({
        id: 'intercom_support',
        integration_type: 'intercom',
        name: 'support',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'intercom-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'intercomSupport',
      method: 'searchConversations',
      input: { query: 'refund' },
    })).rejects.toMatchObject({
      message: 'Native MCP request failed with HTTP 401',
      status: 401,
      code: 'AUTH_REAUTH_REQUIRED',
      data: {
        authStatus: 'needs_reauth',
        reauthUrl: '/connections?connection=intercom_support&reauth=1',
      },
    });
  });

  it('supports both direct Typeform MCP metadata and brokered tools through connected credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(url)).toBe('https://api.typeform.com/mcp');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer typeform-token',
        accept: 'application/json, text/event-stream',
      });
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: body.method === 'tools/list'
          ? { tools: [{ name: 'forms_list' }] }
          : {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'typeform' },
            },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'typeform_forms',
        integration_type: 'typeform',
        name: 'forms',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'typeform-token' }),
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'typeform_forms',
        type: 'typeform',
        capabilities: ['mcp_tools', 'first_party_mcp_brokered'],
        nativeMcp: {
          serverName: 'typeform',
          directConnect: false,
          brokered: true,
          preferredMode: 'brokered',
          broker: {
            url: 'https://api.typeform.com/mcp',
            brokerPath: '/mcp/integrations/native/typeform_forms',
            authStrategy: 'connected_credentials_broker',
          },
        },
      },
    ]);

    const tools = await listConnectionTools(envWith(records), context, 'typeform_forms');
    expect(tools).toMatchObject([{ name: 'forms_list' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses multi-event SSE responses from first-party MCP servers', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'forms_list' }] }
        : {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'typeform' },
          };
      return new Response(
        [
          'event: progress',
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: `progress-${body.id}`, result: { ok: true } })}`,
          '',
          'event: message',
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}`,
          '',
          'event: done',
          'data: [DONE]',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'typeform_forms',
        integration_type: 'typeform',
        name: 'forms',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'typeform-token' }),
      }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'typeform_forms')).resolves.toMatchObject([
      { name: 'forms_list' },
    ]);
  });

  it('lists camelAI-hosted Sentry MCP tools', async () => {
    const records = [
      integration({
        id: 'sentry_prod',
        integration_type: 'sentry',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ organization: 'acme' }),
      }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'sentry_prod')).resolves.toMatchObject([
      { name: 'list_organizations' },
      { name: 'list_projects' },
      { name: 'search_issues' },
      { name: 'get_issue' },
      { name: 'list_issue_events' },
    ]);
  });

  it('searches Sentry issues through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://sentry.io/api/0/organizations/acme/issues/?limit=5&query=is%3Aunresolved');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer sentry-token',
      });
      return new Response(JSON.stringify([{ id: '123', title: 'Boom', status: 'unresolved' }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'sentry_prod',
        integration_type: 'sentry',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ organization: 'acme' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'sentry-token' }),
      }),
    ];

    const result = await callConnectionTool(envWith(records), context, 'sentry_prod', 'search_issues', {
      query: 'is:unresolved',
      limit: 5,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      { id: '123', title: 'Boom', status: 'unresolved' },
    ]);
  });

  it('queries Airtable records through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.airtable.com/v0/app123/Tasks?maxRecords=2&view=Open');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer airtable-token',
      });
      return new Response(JSON.stringify({
        records: [
          { id: 'rec1', fields: { Title: 'Fix bug' } },
        ],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'airtable_main',
        integration_type: 'airtable',
        name: 'main',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'airtable-token' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'airtable_main');
    expect(tools).toMatchObject([
      { name: 'list_bases' },
      { name: 'list_tables' },
      { name: 'query_records' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'airtable_main', 'query_records', {
      baseId: 'app123',
      table: 'Tasks',
      view: 'Open',
      maxRecords: 2,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      records: [{ id: 'rec1', fields: { Title: 'Fix bug' } }],
    });
  });

  it('marks hosted MCP broker credentials stale when the provider returns 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid token' } }), { status: 401 })
    ));
    const updates: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'airtable_main',
        integration_type: 'airtable',
        name: 'main',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'airtable-token' }),
      }),
    ];
    const req = new Request('https://worker.test/mcp/integrations/native/airtable_main', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-secret': 'secret',
        'x-chiridion-org-id': context.orgId,
        'x-chiridion-workspace-id': context.workspaceId,
        'x-chiridion-user-id': context.userId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query_records',
          arguments: { baseId: 'app123', table: 'Tasks' },
        },
      }),
    });

    const response = await handleIntegrationsMcp({
      req,
      env: {
        ...envWith(records, (id, status, code, message) => {
          updates.push({ id, status, code, message });
        }),
        SANDBOX_PROXY_SECRET: 'secret',
      } as never,
      ctx: {} as never,
      url: new URL(req.url),
    });

    const body = await response.json() as {
      error?: { code?: number; data?: { auth_status?: string; code?: string } };
    };
    expect(body.error).toMatchObject({
      code: -32001,
      data: {
        auth_status: 'needs_reauth',
        code: 'AUTH_REAUTH_REQUIRED',
      },
    });
    expect(updates).toMatchObject([
      {
        id: 'airtable_main',
        status: 'needs_reauth',
        code: 'AUTH_REAUTH_REQUIRED',
      },
    ]);
  });

  it('marks hosted MCP setup failures as setup incomplete', async () => {
    const updates: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'mongo_prod',
        integration_type: 'mongodb',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ database: 'app', data_source: 'Cluster0' }),
        credentials_encrypted: await encryptedCredentials({ data_api_key: 'mongo-data-key' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records, (id, status, code, message) => {
      updates.push({ id, status, code, message });
    }), context, 'mongo_prod', 'find_documents', {
      collection: 'users',
    })).rejects.toMatchObject({
      status: 400,
      code: 'AUTH_SETUP_INCOMPLETE',
      data: {
        authStatus: 'setup_incomplete',
        reauthUrl: '/connections?connection=mongo_prod&reauth=1',
      },
    });
    expect(updates).toMatchObject([
      {
        id: 'mongo_prod',
        status: 'setup_incomplete',
        code: 'AUTH_SETUP_INCOMPLETE',
      },
    ]);
  });

  it('searches Zendesk tickets through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe('https://acme.zendesk.com/api/v2/search.json');
      expect(target.searchParams.get('query')).toBe('type:ticket status:open');
      expect(target.searchParams.get('per_page')).toBe('2');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('agent@example.com/token:zendesk-token')}`,
      });
      return new Response(JSON.stringify({
        results: [{ id: 123, subject: 'Need help' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'zendesk_support',
        integration_type: 'zendesk',
        name: 'support',
        category: 'saas',
        config: JSON.stringify({ subdomain: 'acme' }),
        credentials_encrypted: await encryptedCredentials({
          email: 'agent@example.com',
          api_key: 'zendesk-token',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'zendesk_support');
    expect(tools).toMatchObject([
      { name: 'search_tickets' },
      { name: 'get_ticket' },
      { name: 'list_ticket_comments' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'zendesk_support', 'search_tickets', {
      query: 'status:open',
      limit: 2,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      results: [{ id: 123, subject: 'Need help' }],
    });
  });

  it('lists Mailchimp campaigns through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe('https://us21.api.mailchimp.com/3.0/campaigns');
      expect(target.searchParams.get('count')).toBe('3');
      expect(target.searchParams.get('list_id')).toBe('aud_123');
      expect(target.searchParams.get('status')).toBe('sent');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('camelai:mailchimp-key-us21')}`,
      });
      return new Response(JSON.stringify({
        campaigns: [{ id: 'cmp_1', status: 'sent' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'mailchimp_marketing',
        integration_type: 'mailchimp',
        name: 'marketing',
        category: 'saas',
        config: JSON.stringify({ data_center: 'us21' }),
        credentials_encrypted: await encryptedCredentials({
          api_key: 'mailchimp-key-us21',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'mailchimp_marketing');
    expect(tools).toMatchObject([
      { name: 'list_audiences' },
      { name: 'get_audience' },
      { name: 'list_campaigns' },
      { name: 'get_campaign' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'mailchimp_marketing', 'list_campaigns', {
      listId: 'aud_123',
      status: 'sent',
      limit: 3,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      campaigns: [{ id: 'cmp_1', status: 'sent' }],
    });
  });

  it('lists SendGrid templates through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe('https://api.sendgrid.com/v3/templates');
      expect(target.searchParams.get('generations')).toBe('dynamic');
      expect(target.searchParams.get('page_size')).toBe('4');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer sendgrid-token',
      });
      return new Response(JSON.stringify({
        templates: [{ id: 'd-template_1', name: 'Welcome' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'sendgrid_txn',
        integration_type: 'sendgrid',
        name: 'transactional',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({
          api_key: 'sendgrid-token',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'sendgrid_txn');
    expect(tools).toMatchObject([
      { name: 'list_sender_identities' },
      { name: 'list_templates' },
      { name: 'get_template' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'sendgrid_txn', 'list_templates', {
      limit: 4,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      templates: [{ id: 'd-template_1', name: 'Welcome' }],
    });
  });

  it('lists Twilio messages through the platform broker', async () => {
    const accountSid = 'AC-test-account';
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
      expect(target.searchParams.get('PageSize')).toBe('2');
      expect(target.searchParams.get('To')).toBe('+15551234567');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa(`${accountSid}:twilio-token`)}`,
      });
      return new Response(JSON.stringify({
        messages: [{ sid: 'SM0123456789abcdef0123456789abcdef', status: 'delivered' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'twilio_sms',
        integration_type: 'twilio',
        name: 'sms',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({
          account_sid: accountSid,
          auth_token: 'twilio-token',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'twilio_sms');
    expect(tools).toMatchObject([
      { name: 'list_messages' },
      { name: 'get_message' },
      { name: 'list_calls' },
      { name: 'get_call' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'twilio_sms', 'list_messages', {
      to: '+15551234567',
      limit: 2,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      messages: [{ sid: 'SM0123456789abcdef0123456789abcdef', status: 'delivered' }],
    });
  });

  it('executes read-only PostHog HogQL through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://us.posthog.com/api/projects/123/query/');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer phx-token',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        query: {
          kind: 'HogQLQuery',
          query: 'select event, count() from events group by event',
        },
      });
      return new Response(JSON.stringify({ results: [['$pageview', 12]] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'posthog_prod',
        integration_type: 'posthog',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ host: 'https://us.posthog.com', project_id: '123' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'phx-token' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'posthog_prod');
    expect(tools).toMatchObject([
      { name: 'list_projects' },
      { name: 'list_feature_flags' },
      { name: 'list_insights' },
      { name: 'execute_hogql_readonly' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'posthog_prod', 'execute_hogql_readonly', {
      query: 'select event, count() from events group by event',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ results: [['$pageview', 12]] });
  });

  it('executes read-only ClickHouse SQL through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://clickhouse.example:8443/?database=default');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('default:secret')}`,
      });
      expect(String(init?.body)).toBe('SELECT event, count() FROM events GROUP BY event LIMIT 10 FORMAT JSON');
      return new Response(JSON.stringify({
        data: [{ event: 'pageview', count: 12 }],
        rows: 1,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'clickhouse_events',
        integration_type: 'clickhouse',
        name: 'events',
        category: 'databases',
        config: JSON.stringify({ host: 'clickhouse.example', port: 8443, database: 'default' }),
        credentials_encrypted: await encryptedCredentials({ username: 'default', password: 'secret' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'clickhouse_events');
    expect(tools).toMatchObject([
      { name: 'list_databases' },
      { name: 'list_tables' },
      { name: 'get_table_info' },
      { name: 'execute_sql_readonly' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'clickhouse_events', 'execute_sql_readonly', {
      query: 'SELECT event, count() FROM events GROUP BY event',
      limit: 10,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      data: [{ event: 'pageview', count: 12 }],
      rows: 1,
    });
  });

  it('executes read-only Postgres SQL through the data proxy MCP broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://sandbox.test/v1/workspaces/org_1/ws_1/data-proxy/postgres/query');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        mode: 'read',
        host: 'db.example.com',
        port: 5432,
        user: 'app',
        password: 'secret',
        database: 'appdb',
        query: 'select id, email from users LIMIT 25',
        params: [],
        sslmode: 'require',
      });
      return new Response(JSON.stringify({
        recordset: [{ id: 1, email: 'ada@example.com' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        category: 'databases',
        config: JSON.stringify({
          host: 'db.example.com',
          port: 5432,
          database: 'appdb',
          schema: 'public',
          ssl_mode: 'require',
        }),
        credentials_encrypted: await encryptedCredentials({ username: 'app', password: 'secret' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'pg_main');
    expect(tools).toMatchObject([
      { name: 'list_schemas' },
      { name: 'list_tables' },
      { name: 'get_table_info' },
      { name: 'execute_sql_readonly' },
    ]);

    const result = await callConnectionTool({
      ...envWith(records),
      SANDBOX_HOST_URL: 'https://sandbox.test',
    }, context, 'pg_main', 'execute_sql_readonly', {
      query: 'select id, email from users',
      limit: 25,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [{ id: 1, email: 'ada@example.com' }],
      rowsAffected: [],
    });
  });

  it('does not append a default SQL LIMIT when the query has a parameterized LIMIT', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        query: 'select id from users LIMIT $1',
        params: [5],
      });
      return new Response(JSON.stringify({
        recordset: [{ id: 1 }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        category: 'databases',
        config: JSON.stringify({ host: 'db.example.com', database: 'appdb' }),
        credentials_encrypted: await encryptedCredentials({ username: 'app', password: 'secret' }),
      }),
    ];

    await expect(callConnectionTool({
      ...envWith(records),
      SANDBOX_HOST_URL: 'https://sandbox.test',
    }, context, 'pg_main', 'execute_sql_readonly', {
      query: 'select id from users LIMIT $1',
      params: [5],
      limit: 25,
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lists MySQL table metadata through the data proxy MCP broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://sandbox.test/v1/workspaces/org_1/ws_1/data-proxy/mysql/query');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        mode: 'read',
        host: 'mysql.example.com',
        user: 'app',
        password: 'secret',
        database: 'appdb',
        params: ['appdb', 'users'],
      });
      return new Response(JSON.stringify({
        recordset: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'mysql_main',
        integration_type: 'mysql',
        name: 'main',
        category: 'databases',
        config: JSON.stringify({
          host: 'mysql.example.com',
          database: 'appdb',
        }),
        credentials_encrypted: await encryptedCredentials({ username: 'app', password: 'secret' }),
      }),
    ];

    const result = await callConnectionTool({
      ...envWith(records),
      SANDBOX_HOST_URL: 'https://sandbox.test',
    }, context, 'mysql_main', 'get_table_info', {
      table: 'users',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO' }],
      rowsAffected: [],
    });
  });

  it('executes read-only Neon SQL through the Postgres data proxy MCP broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://sandbox.test/v1/workspaces/org_1/ws_1/data-proxy/postgres/query');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        mode: 'read',
        host: 'ep-example.us-east-2.aws.neon.tech',
        user: 'app',
        password: 'secret',
        database: 'neondb',
        query: 'select now() LIMIT 5',
        params: [],
        sslmode: 'require',
      });
      return new Response(JSON.stringify({
        recordset: [{ now: '2026-05-08T00:00:00Z' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'neon_main',
        integration_type: 'neon',
        name: 'main',
        category: 'databases',
        credentials_encrypted: await encryptedCredentials({
          connection_string: 'postgresql://app:secret@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'neon_main');
    expect(tools).toMatchObject([
      { name: 'list_schemas' },
      { name: 'list_tables' },
      { name: 'get_table_info' },
      { name: 'execute_sql_readonly' },
    ]);

    const result = await callConnectionTool({
      ...envWith(records),
      SANDBOX_HOST_URL: 'https://sandbox.test',
    }, context, 'neon_main', 'execute_sql_readonly', {
      query: 'select now()',
      limit: 5,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [{ now: '2026-05-08T00:00:00Z' }],
      rowsAffected: [],
    });
  });

  it('executes read-only PlanetScale SQL through the MySQL data proxy MCP broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://sandbox.test/v1/workspaces/org_1/ws_1/data-proxy/mysql/query');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        mode: 'read',
        host: 'aws.connect.psdb.cloud',
        user: 'svc',
        password: 'secret',
        database: 'appdb',
        query: 'select id from users LIMIT 3',
        params: [],
        tls: 'true',
      });
      return new Response(JSON.stringify({
        recordset: [{ id: 1 }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'planetscale_main',
        integration_type: 'planetscale',
        name: 'main',
        category: 'databases',
        credentials_encrypted: await encryptedCredentials({
          connection_string: 'mysql://svc:secret@aws.connect.psdb.cloud/appdb?sslaccept=strict',
        }),
      }),
    ];

    const result = await callConnectionTool({
      ...envWith(records),
      SANDBOX_HOST_URL: 'https://sandbox.test',
    }, context, 'planetscale_main', 'execute_sql_readonly', {
      query: 'select id from users',
      limit: 3,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [{ id: 1 }],
      rowsAffected: [],
    });
  });

  it('forwards SQL database MCP queries without keyword filtering', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        mode: 'read',
        query: 'delete from users LIMIT 100',
      });
      return new Response(JSON.stringify({ rowsAffected: [3] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        category: 'databases',
        config: JSON.stringify({ host: 'db.example.com', database: 'appdb' }),
        credentials_encrypted: await encryptedCredentials({ username: 'app', password: 'secret' }),
      }),
    ];

    const result = await callConnectionTool({
      ...envWith(records),
      SANDBOX_HOST_URL: 'https://sandbox.test',
    }, context, 'pg_main', 'execute_sql_readonly', {
      query: 'delete from users',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [],
      rowsAffected: [3],
    });
  });

  it('queries Mixpanel top events through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://mixpanel.com/api/2.0/events/top?project_id=1234567&from_date=2026-05-01&to_date=2026-05-08&limit=3');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('svc-user:svc-secret')}`,
      });
      return new Response(JSON.stringify({ events: [{ event: 'Signup', count: 42 }] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'mixpanel_prod',
        integration_type: 'mixpanel',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ project_id: '1234567', region: 'us' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'svc-user', api_secret: 'svc-secret' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'mixpanel_prod');
    expect(tools).toMatchObject([
      { name: 'top_events' },
      { name: 'event_properties' },
      { name: 'query_jql_readonly' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'mixpanel_prod', 'top_events', {
      fromDate: '2026-05-01',
      toDate: '2026-05-08',
      limit: 3,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ events: [{ event: 'Signup', count: 42 }] });
  });

  it('queries Amplitude event segmentation through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe('https://amplitude.com/api/2/events/segmentation');
      expect(target.searchParams.get('start')).toBe('20260501');
      expect(target.searchParams.get('end')).toBe('20260508');
      expect(JSON.parse(target.searchParams.get('e') || '{}')).toEqual({ event_type: 'Signup' });
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('amp-key:amp-secret')}`,
      });
      return new Response(JSON.stringify({ data: { series: [1, 2, 3] } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'amplitude_prod',
        integration_type: 'amplitude',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ region: 'us' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'amp-key', api_secret: 'amp-secret' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'amplitude_prod');
    expect(tools).toMatchObject([
      { name: 'list_events' },
      { name: 'list_event_properties' },
      { name: 'query_events_segmentation' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'amplitude_prod', 'query_events_segmentation', {
      eventType: 'Signup',
      start: '20260501',
      end: '20260508',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ data: { series: [1, 2, 3] } });
  });

  it('executes BigQuery read-only SQL through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/jobs')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          configuration: {
            dryRun: true,
            query: {
              query: 'select name, active from users',
              useLegacySql: false,
              defaultDataset: { projectId: 'demo-project', datasetId: 'warehouse' },
              maximumBytesBilled: '1000000000',
            },
          },
        });
        return new Response(JSON.stringify({
          statistics: {
            query: {
              totalBytesProcessed: '42',
              totalBytesBilled: '0',
              cacheHit: false,
            },
          },
        }));
      }
      if (target.endsWith('/queries')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          query: 'select name, active from users',
          useLegacySql: false,
          maxResults: 100,
          timeoutMs: 30000,
        });
        return new Response(JSON.stringify({
          jobComplete: true,
          totalRows: '1',
          schema: {
            fields: [
              { name: 'name', type: 'STRING' },
              { name: 'active', type: 'BOOL' },
            ],
          },
          rows: [{ f: [{ v: 'Ada' }, { v: 'true' }] }],
        }));
      }
      return new Response(JSON.stringify({ error: { message: `unexpected URL ${target}` } }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project', dataset: 'warehouse' }),
        credentials_encrypted: await encryptedCredentials({
          access_token: 'bq-access-token',
          expires_at: Date.now() + 3600_000,
        }),
      }),
    ];

    const result = await callConnectionTool(envWith(records), context, 'bq_prod', 'execute_sql_readonly', {
      query: 'select name, active from users',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      projectId: 'demo-project',
      datasetId: 'warehouse',
      totalRows: '1',
      totalBytesProcessed: '42',
      rows: [{ name: 'Ada', active: true }],
    });
  });

  it('forwards BigQuery SQL without keyword filtering', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const body = JSON.parse(String(init?.body));
      if (target.endsWith('/projects/demo-project/jobs')) {
        expect(body.configuration.query.query).toBe('delete from warehouse.users where true');
        return new Response(JSON.stringify({
          statistics: { query: { totalBytesProcessed: '12', totalBytesBilled: '0' } },
        }));
      }
      if (target.endsWith('/projects/demo-project/queries')) {
        expect(body.query).toBe('delete from warehouse.users where true');
        return new Response(JSON.stringify({
          jobComplete: true,
          totalRows: '0',
          schema: { fields: [] },
          rows: [],
        }));
      }
      return new Response(JSON.stringify({ error: { message: `unexpected URL ${target}` } }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project' }),
        credentials_encrypted: await encryptedCredentials({
          access_token: 'bq-access-token',
          expires_at: Date.now() + 3600_000,
        }),
      }),
    ];

    const result = await callConnectionTool(envWith(records), context, 'bq_prod', 'execute_sql_readonly', {
      query: 'delete from warehouse.users where true',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      projectId: 'demo-project',
      totalRows: '0',
    });
  });

  it('serves BigQuery tools from the integrations MCP broker endpoint', async () => {
    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project' }),
      }),
    ];
    const req = new Request('https://worker.test/mcp/integrations/native/bq_prod', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-secret': 'sandbox-secret',
        'x-chiridion-org-id': 'org_1',
        'x-chiridion-workspace-id': 'ws_1',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const response = await handleIntegrationsMcp({
      req,
      env: {
        ...envWith(records),
        SANDBOX_PROXY_SECRET: 'sandbox-secret',
      },
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    } as Parameters<typeof handleIntegrationsMcp>[0]);

    const body = await response.json() as { result?: { tools?: Array<{ name?: string }> } };
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
    });
    expect(body.result?.tools?.map((tool) => tool.name)).toContain('list_dataset_ids');
  });

  it('preserves JSON-RPC ids and batch shape for native MCP missing-token errors', async () => {
    const updates: Array<{ id: string; status: string; code: string | null }> = [];
    const records = [
      integration({
        id: 'cloudflare_account',
        integration_type: 'cloudflare',
        name: 'account',
        category: 'cloud_providers',
      }),
    ];
    const req = new Request('https://worker.test/mcp/integrations/native/cloudflare_account', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-secret': 'sandbox-secret',
        'x-chiridion-org-id': 'org_1',
        'x-chiridion-workspace-id': 'ws_1',
      },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'tools/list' },
        { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'x' } },
      ]),
    });

    const response = await handleIntegrationsMcp({
      req,
      env: {
        ...envWith(records, (id, status, code) => {
          updates.push({ id, status, code });
        }),
        SANDBOX_PROXY_SECRET: 'sandbox-secret',
      },
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    } as Parameters<typeof handleIntegrationsMcp>[0]);

    const body = await response.json() as Array<{ id: string; error?: { code?: number } }>;
    expect(response.status).toBe(400);
    expect(body).toMatchObject([
      { id: 'a', error: { code: -32002 } },
      { id: 'b', error: { code: -32002 } },
    ]);
    expect(updates).toMatchObject([
      {
        id: 'cloudflare_account',
        status: 'setup_incomplete',
        code: 'AUTH_SETUP_INCOMPLETE',
      },
    ]);
  });

  it('omits Square from the integrations MCP registry until SSE transport is supported', async () => {
    const records = [
      integration({
        id: 'square_prod',
        integration_type: 'square',
        name: 'prod',
        category: 'saas',
      }),
    ];
    const req = new Request('https://worker.test/mcp/integrations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-secret': 'sandbox-secret',
        'x-chiridion-org-id': 'org_1',
        'x-chiridion-workspace-id': 'ws_1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'list_mcp_servers',
          arguments: {},
        },
      }),
    });
    const response = await handleIntegrationsMcp({
      req,
      env: {
        ...envWith(records),
        SANDBOX_PROXY_SECRET: 'sandbox-secret',
      },
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    } as Parameters<typeof handleIntegrationsMcp>[0]);

    const body = await response.json() as {
      result?: { content?: Array<{ type?: string; text?: string }> };
    };
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}');
    expect(payload.servers).toEqual([]);
  });

  it('describes first-party remote MCP servers as camelAI-brokered in the registry endpoint', async () => {
    const records = [
      integration({
        id: 'stripe_prod',
        integration_type: 'stripe',
        name: 'prod',
        category: 'saas',
        credentials_encrypted: 'encrypted-key',
      }),
    ];
    const req = new Request('https://worker.test/mcp/integrations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sandbox-secret': 'sandbox-secret',
        'x-chiridion-org-id': 'org_1',
        'x-chiridion-workspace-id': 'ws_1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'list_mcp_servers',
          arguments: {},
        },
      }),
    });
    const response = await handleIntegrationsMcp({
      req,
      env: {
        ...envWith(records),
        SANDBOX_PROXY_SECRET: 'sandbox-secret',
      },
      ctx: {} as ExecutionContext,
      url: new URL(req.url),
      match: [] as unknown as RegExpMatchArray,
    } as Parameters<typeof handleIntegrationsMcp>[0]);

    const body = await response.json() as {
      result?: { content?: Array<{ type?: string; text?: string }> };
    };
    const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}');
    expect(payload.servers).toMatchObject([
      {
        server_name: 'stripe',
        url: 'https://mcp.stripe.com',
        broker_path: '/mcp/integrations/native/stripe_prod',
        transport: 'streamable_http',
        direct_connect: false,
        brokered: true,
        preferred_mode: 'brokered',
        requires_camelai_broker: true,
        has_connected_credentials: true,
        direct: null,
        broker: {
          server_name: 'stripe',
          url: 'https://mcp.stripe.com',
          broker_path: '/mcp/integrations/native/stripe_prod',
          transport: 'streamable_http',
          auth_strategy: 'connected_credentials_broker',
        },
      },
    ]);
  });

  it('lists MCP tools for the new hosted broker batch', async () => {
    const records = [
      integration({ id: 'snowflake_prod', integration_type: 'snowflake', name: 'prod', category: 'databases' }),
      integration({ id: 'mongo_prod', integration_type: 'mongodb', name: 'prod', category: 'databases' }),
      integration({ id: 'redis_prod', integration_type: 'redis', name: 'prod', category: 'databases' }),
      integration({ id: 'turso_prod', integration_type: 'turso', name: 'prod', category: 'databases' }),
      integration({ id: 'databricks_prod', integration_type: 'databricks', name: 'prod', category: 'databases' }),
      integration({ id: 'shopify_prod', integration_type: 'shopify', name: 'prod', category: 'saas' }),
      integration({ id: 'segment_prod', integration_type: 'segment', name: 'prod', category: 'saas' }),
      integration({ id: 'teams_prod', integration_type: 'teams', name: 'prod', category: 'communication' }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      { id: 'snowflake_prod', capabilities: ['mcp_tools', 'camelai_hosted_mcp'], nativeMcp: { serverName: 'snowflake', brokered: true } },
      { id: 'mongo_prod', capabilities: ['mcp_tools', 'camelai_hosted_mcp'], nativeMcp: { serverName: 'mongodb', brokered: true } },
      { id: 'redis_prod', capabilities: ['mcp_tools', 'camelai_hosted_mcp'], nativeMcp: { serverName: 'redis', brokered: true } },
      { id: 'turso_prod', capabilities: ['mcp_tools', 'camelai_hosted_mcp'], nativeMcp: { serverName: 'turso', brokered: true } },
      { id: 'databricks_prod', capabilities: ['mcp_tools', 'camelai_hosted_mcp'], nativeMcp: { serverName: 'databricks', brokered: true } },
      { id: 'shopify_prod', capabilities: ['mcp_tools', 'camelai_hosted_mcp'], nativeMcp: { serverName: 'shopify', brokered: true } },
      { id: 'segment_prod', capabilities: ['mcp_tools', 'camelai_hosted_mcp'], nativeMcp: { serverName: 'segment', brokered: true } },
      { id: 'teams_prod', capabilities: ['mcp_tools', 'camelai_hosted_mcp'], nativeMcp: { serverName: 'teams', brokered: true } },
    ]);

    await expect(listConnectionTools(envWith(records), context, 'snowflake_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'execute_sql_readonly' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'mongo_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'find_documents' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'redis_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'scan_keys' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'turso_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'execute_sql_readonly' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'databricks_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'list_sql_warehouses' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'shopify_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'list_products' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'segment_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'list_sources' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'teams_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'list_teams' })])
    );
  });

  it('calls Databricks read-only SQL through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://dbc.example.cloud.databricks.com/api/2.0/sql/statements');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer dapi-token' });
      const body = JSON.parse(String(init?.body));
      expect(body.statement).toBe('SELECT * FROM events LIMIT 5');
      expect(body.warehouse_id).toBe('wh_123');
      return Response.json({ statement_id: 'stmt_1', status: { state: 'SUCCEEDED' }, result: { row_count: 1 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'databricks_prod',
        integration_type: 'databricks',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ workspace_url: 'https://dbc.example.cloud.databricks.com', sql_warehouse_id: 'wh_123' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'dapi-token' }),
      }),
    ];

    const result = await callConnectionTool(envWith(records), context, 'databricks_prod', 'execute_sql_readonly', {
      query: 'SELECT * FROM events',
      limit: 5,
    });
    expect(result).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls Shopify Admin GraphQL through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://demo.myshopify.com/admin/api/2026-04/graphql.json');
      expect(init?.headers).toMatchObject({ 'x-shopify-access-token': 'shpat_token' });
      return Response.json({ data: { shop: { name: 'Demo' } } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'shopify_prod',
        integration_type: 'shopify',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ shop_domain: 'demo.myshopify.com' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'shpat_token' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'shopify_prod', 'get_shop')).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
  });

  it('calls MongoDB Atlas Data API through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://data.mongodb-api.com/app/app-id/endpoint/data/v1/action/find');
      expect(init?.headers).toMatchObject({ 'api-key': 'mongo-data-key' });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        dataSource: 'Cluster0',
        database: 'app',
        collection: 'users',
        limit: 2,
      });
      return Response.json({ documents: [{ _id: '1' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'mongo_prod',
        integration_type: 'mongodb',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ database: 'app', data_source: 'Cluster0' }),
        credentials_encrypted: await encryptedCredentials({
          connection_string: 'mongodb+srv://unused',
          data_api_url: 'https://data.mongodb-api.com/app/app-id/endpoint/data/v1',
          data_api_key: 'mongo-data-key',
        }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'mongo_prod', 'find_documents', {
      collection: 'users',
      limit: 2,
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
  });

  it('calls Redis REST through a read-only command allowlist', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://redis.example.upstash.io');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer redis-rest-token' });
      expect(JSON.parse(String(init?.body))).toEqual(['GET', 'session:1']);
      return Response.json({ result: 'value' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'redis_prod',
        integration_type: 'redis',
        name: 'prod',
        category: 'databases',
        credentials_encrypted: await encryptedCredentials({
          connection_string: 'redis://unused',
          rest_url: 'https://redis.example.upstash.io',
          rest_token: 'redis-rest-token',
        }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'redis_prod', 'get_key', {
      key: 'session:1',
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
  });

  it('calls Turso libSQL HTTP through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://db-org.turso.io/v2/pipeline');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer turso-token' });
      const body = JSON.parse(String(init?.body));
      expect(body.requests[0].stmt.sql).toBe('SELECT * FROM users LIMIT 3');
      return Response.json({ results: [{ type: 'ok' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'turso_prod',
        integration_type: 'turso',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ database_url: 'libsql://db-org.turso.io' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'turso-token' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'turso_prod', 'execute_sql_readonly', {
      query: 'SELECT * FROM users',
      limit: 3,
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
  });

  it('calls Segment Public API through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('https://api.segmentapis.com/sources?');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer segment-token' });
      return Response.json({ sources: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'segment_prod',
        integration_type: 'segment',
        name: 'prod',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'segment-token' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'segment_prod', 'list_sources')).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
  });

  it('calls Microsoft Graph for Teams through client credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token') {
        expect(init?.method).toBe('POST');
        return Response.json({ access_token: 'graph-token' });
      }
      expect(target).toContain('https://graph.microsoft.com/v1.0/groups?');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer graph-token' });
      return Response.json({ value: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'teams_prod',
        integration_type: 'teams',
        name: 'prod',
        category: 'communication',
        config: JSON.stringify({ tenant_id: 'tenant-1' }),
        credentials_encrypted: await encryptedCredentials({ client_id: 'client-1', client_secret: 'secret' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'teams_prod', 'list_teams')).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
  });

  it('requires Snowflake SQL API fingerprint setup for hosted MCP calls', async () => {
    const records = [
      integration({
        id: 'snowflake_prod',
        integration_type: 'snowflake',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ account: 'xy12345.us-east-1', database: 'APP', schema: 'PUBLIC' }),
        credentials_encrypted: await encryptedCredentials({
          username: 'svc_user',
          private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
        }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'snowflake_prod', 'list_databases')).rejects.toMatchObject({
      message: 'private_key_fingerprint is required',
      status: 400,
    });
  });

  it('rejects MCP tool listing for non-MCP connection types', async () => {
    const records = [
      integration({ id: 'discord_main', integration_type: 'discord', name: 'main', category: 'communication' }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'discord_main')).rejects.toMatchObject({
      message: 'Connection type "discord" does not have MCP-backed tools.',
      status: 404,
    });
  });
});
