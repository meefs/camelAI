/**
 * Per-turn user-message preprocessing for `@<slug>` connection mentions.
 *
 * Two coordinated transformations:
 *   1. Inline `⟦ref: ...⟧` annotations after each known `@<slug>` token so the
 *      agent can resolve the reference unambiguously even after a connection
 *      gets renamed.
 *   2. A `<camelai system message>` block listing available connections and
 *      reminding the agent to use the connections binding instead of raw
 *      credential environment variables.
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
    entries.push(
      `- @${slugValue} — ${record.integration_type} "${record.name}" (connection id: ${record.id})`,
    );
  }

  if (entries.length === 0) return '';

  return [
    '<camelai system message>',
    '## Available connections',
    '',
    'The user has the following connections (integrations) configured. They may',
    'reference them by `@<slug>` in messages. Use the `js_exec` tool and the',
    '`connections` facade or `env.CONNECTIONS` binding to inspect and call',
    'connection methods. Do not inspect `process.env` or `INT_*` variables for',
    'connection credentials unless the user explicitly asks for legacy env vars.',
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
