import type { IntegrationAuthMethod } from '@/types';
import { hasBrokeredProviderMcp } from '@/lib/provider-mcp-registry';

interface IntegrationAuthLabelInput {
  type: string;
  authMethod?: IntegrationAuthMethod | string;
  credentialSchema?: unknown[];
}

export function getIntegrationAuthLabel(
  integration: IntegrationAuthLabelInput
): string | undefined {
  if (integration.type === 'remote_mcp' || hasBrokeredProviderMcp(integration.type)) {
    return 'MCP';
  }

  if (integration.type === 'telegram') return 'Bot setup';
  if (integration.type === 'discord_channel') return 'Discord install';

  if (!integration.authMethod) return undefined;

  if (integration.authMethod === 'oauth2') return 'OAuth';

  if (integration.credentialSchema && integration.credentialSchema.length === 0) {
    return 'Setup';
  }

  return 'API Key';
}
