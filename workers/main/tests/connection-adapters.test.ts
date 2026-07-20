import { describe, expect, it } from 'vitest';
import { PROVIDER_MCP_REGISTRY } from '../../../src/lib/provider-mcp-registry';
import {
  HOSTED_CONNECTION_ADAPTERS,
} from '../src/connection-adapters.js';
import type { WorkspaceIntegrationRecord } from '../src/workspace.js';

function record(integrationType: string): WorkspaceIntegrationRecord {
  return {
    id: `${integrationType}_test`,
    integration_type: integrationType,
    name: integrationType,
    category: 'saas',
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
  };
}

const env = { INTEGRATION_SECRET_KEY: 'test' } as never;
const context = { orgId: 'org_1', workspaceId: 'ws_1', userId: 'user_1' };

describe('hosted connection adapters', () => {
  it('has one implementation entry for every camelAI-hosted MCP definition', () => {
    for (const definition of Object.values(PROVIDER_MCP_REGISTRY)) {
      if (!definition.url.startsWith('camelai://')) continue;
      expect(HOSTED_CONNECTION_ADAPTERS[definition.integrationType], definition.integrationType)
        .toBeDefined();
    }
  });

  it('keeps every verification probe aligned with a real read-only tool', async () => {
    for (const [integrationType, adapter] of Object.entries(HOSTED_CONNECTION_ADAPTERS)) {
      const probe = adapter.verification;
      if (!probe) continue;
      const result = await adapter.invoke(env, context, record(integrationType), 'tools/list', {});
      const tools = (result as { tools?: Array<{ name?: string }> }).tools ?? [];
      expect(tools.map((tool) => tool.name), integrationType).toContain(probe.tool);
    }
  });
});
