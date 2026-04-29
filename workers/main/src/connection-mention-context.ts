/**
 * Per-turn user-message preprocessing for `@<slug>` connection mentions.
 *
 * Two coordinated transformations:
 *   1. Inline `⟦ref: ...⟧` annotations after each known `@<slug>` token so the
 *      agent can resolve the reference unambiguously even after a connection
 *      gets renamed.
 *   2. A `<camelai system message>` block listing available connections + the
 *      env-var prefix the agent should use to access each one's credentials.
 *
 * Both transforms are guarded so a workspace with no integrations falls
 * through unchanged.
 */

import {
  buildSlugMap,
  expandMentions,
  parseMentions,
  type MentionableIntegration,
} from '../../../src/lib/connection-mentions';
import type { WorkspaceIntegrationRecord } from './workspace';
import {
  getEnvVarSuffixesForType,
  normalizeEnvVarName,
  type DynamicFieldForEnv,
} from './integration-env';

interface DynamicFieldsConfig {
  dynamic_fields?: DynamicFieldForEnv[];
}

function envVarPrefix(integrationType: string, integrationName: string): string {
  const typePart = normalizeEnvVarName(integrationType);
  const namePart = normalizeEnvVarName(integrationName);
  return `INT_${typePart}_${namePart}`;
}

function envVarsForIntegration(record: WorkspaceIntegrationRecord): string[] {
  let dynamicFields: DynamicFieldForEnv[] | undefined;
  if (record.integration_type === 'other') {
    try {
      const parsed = JSON.parse(record.config) as DynamicFieldsConfig;
      dynamicFields = parsed?.dynamic_fields;
    } catch {
      dynamicFields = undefined;
    }
  }
  const suffixes = getEnvVarSuffixesForType(record.integration_type, dynamicFields);
  const prefix = envVarPrefix(record.integration_type, record.name);
  return suffixes.map((suffix) => `${prefix}_${suffix}`);
}

function toMentionable(record: WorkspaceIntegrationRecord): MentionableIntegration {
  return {
    id: record.id,
    integration_type: record.integration_type,
    name: record.name,
    created_at: record.created_at,
  };
}

function buildConnectionsSection(
  slugMap: Map<string, MentionableIntegration>,
  integrationsById: Map<string, WorkspaceIntegrationRecord>,
): string {
  if (slugMap.size === 0) return '';

  const entries: string[] = [];
  for (const [slugValue, mentionable] of slugMap) {
    const record = integrationsById.get(mentionable.id);
    if (!record) continue;
    const envVars = envVarsForIntegration(record);
    const envVarsLine = envVars.length > 0
      ? `\n    env: ${envVars.join(', ')}`
      : '';
    entries.push(
      `- @${slugValue} — ${record.integration_type} "${record.name}"${envVarsLine}`,
    );
  }

  if (entries.length === 0) return '';

  return [
    '<camelai system message>',
    '## Available connections',
    '',
    'The user has the following connections (integrations) configured. They may',
    'reference them by `@<slug>` in messages. When they do, prefer using that',
    "specific connection's env vars for the request.",
    '',
    ...entries,
    '</camelai system message>',
  ].join('\n');
}

export interface AppliedMentionContext {
  /** Original content with the connections context prepended and mentions expanded. */
  content: string;
  /** True when at least one `@<slug>` token in the body matched a known integration. */
  hadMatchedMentions: boolean;
}

export function applyConnectionMentionContext(
  rawContent: string,
  integrations: WorkspaceIntegrationRecord[],
): AppliedMentionContext {
  if (!rawContent || integrations.length === 0) {
    return { content: rawContent, hadMatchedMentions: false };
  }

  const slugMap = buildSlugMap(integrations.map(toMentionable));
  if (slugMap.size === 0) {
    return { content: rawContent, hadMatchedMentions: false };
  }

  const expandedBody = expandMentions(rawContent, slugMap);
  const hadMatchedMentions = parseMentions(rawContent, slugMap).some(
    (m) => m.integration !== null,
  );
  if (!hadMatchedMentions) {
    return { content: rawContent, hadMatchedMentions: false };
  }

  const integrationsById = new Map(integrations.map((r) => [r.id, r]));
  const section = buildConnectionsSection(slugMap, integrationsById);
  const content = section
    ? `${section}\n\n${expandedBody}`
    : expandedBody;
  return { content, hadMatchedMentions };
}
