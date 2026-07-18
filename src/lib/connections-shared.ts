import type { Avatar, Integration } from "@/types";
import { getIntegrationDefinition } from "@/lib/integration-registry";
import { getProviderMcpDefinition } from "@/lib/provider-mcp-registry";

export const CHANNEL_INTEGRATION_TYPES = ["slack", "telegram"] as const;

export type ChannelIntegrationType = (typeof CHANNEL_INTEGRATION_TYPES)[number];
export type ConnectionSort = "updated" | "name" | "created";
export type Capability =
  | "query_database"
  | "mcp_tools"
  | "typed_operations"
  | "authenticated_fetch"
  | "channel_send"
  | "slack_api";

export interface ConnectionListItem extends Integration {
  auth_status?: string | null;
  auth_error_code?: string | null;
  auth_error_message?: string | null;
  auth_checked_at?: number | null;
  reauth_required_at?: number | null;
  token_expires_at?: number | null;
  created_by_name?: string | null;
  created_by_avatar?: Avatar | null;
  channelMetadata?: {
    team_id?: string | null;
    team_name?: string | null;
    bot_user_id?: string | null;
  };
  definitionMetadata?: {
    source: string;
    operationCount: number;
    genericFetch: boolean;
  };
}

export interface EmailChannel {
  address: string | null;
  handle: string | null;
  /**
   * TODO(email-channel-mention): wire this once backend defines the native
   * Email channel's synthetic @-mention slug and expansion behavior.
   */
  mentionSlug?: string | null;
  inboxEnabled: boolean;
  workspaceCreatedBy: string | null;
  workspaceCreatedByName?: string | null;
  workspaceCreatedByAvatar?: Avatar | null;
  workspaceCreatedAt: number | null;
}

export type PanelItem =
  | { kind: "connection"; id: string; connection: ConnectionListItem }
  | {
      kind: "channel";
      channel: ChannelIntegrationType;
      id: string;
      connection: ConnectionListItem;
    }
  | { kind: "channel"; channel: "email"; id: "email"; email: EmailChannel };

export const TYPE_COPY = {
  channel:
    "A channel receives messages from outside camelAI and turns them into threads the agent can reply to.",
  connection:
    "A connection gives the agent tools it can call. @-mention it in any chat to put its data and actions to work.",
} as const;

export const CAPABILITY_LABEL: Record<Capability, string> = {
  query_database: "Query database",
  mcp_tools: "MCP tools",
  typed_operations: "Typed API operations",
  authenticated_fetch: "Authenticated API calls",
  channel_send: "Channel send",
  slack_api: "Slack API",
};

export interface DetailField {
  label: string;
  keys: string[];
}

export interface ConnectionDetailRow {
  label: string;
  value: string;
}

const DETAIL_FIELDS_BY_TYPE: Record<string, DetailField[]> = {
  postgres: [
    { label: "Host", keys: ["host", "endpoint"] },
    { label: "Port", keys: ["port"] },
    { label: "Database", keys: ["database"] },
    { label: "Schema", keys: ["schema"] },
  ],
  mysql: [
    { label: "Host", keys: ["host", "endpoint"] },
    { label: "Port", keys: ["port"] },
    { label: "Database", keys: ["database"] },
  ],
  clickhouse: [
    { label: "Host", keys: ["host", "endpoint"] },
    { label: "Port", keys: ["port"] },
    { label: "Database", keys: ["database"] },
  ],
  mongodb: [
    { label: "Cluster", keys: ["cluster_url", "host", "endpoint"] },
    { label: "Database", keys: ["database"] },
  ],
  redis: [
    { label: "Host", keys: ["host", "endpoint"] },
    { label: "Port", keys: ["port"] },
    { label: "Database", keys: ["database"] },
  ],
  snowflake: [
    { label: "Account", keys: ["account"] },
    { label: "Warehouse", keys: ["warehouse"] },
    { label: "Database", keys: ["database"] },
    { label: "Schema", keys: ["schema"] },
  ],
  supabase: [{ label: "Project URL", keys: ["project_url"] }],
  neon: [{ label: "Project ID", keys: ["project_id"] }],
  planetscale: [
    { label: "Organization", keys: ["organization"] },
    { label: "Database", keys: ["database"] },
  ],
  turso: [{ label: "Database URL", keys: ["database_url"] }],
  databricks: [{ label: "Workspace URL", keys: ["workspace_url"] }],
  bigquery: [
    { label: "Project ID", keys: ["project_id"] },
    { label: "Dataset", keys: ["dataset"] },
  ],
  jira: [{ label: "Domain", keys: ["domain"] }],
  zendesk: [{ label: "Subdomain", keys: ["subdomain"] }],
  shopify: [{ label: "Shop domain", keys: ["shop_domain"] }],
  mailchimp: [{ label: "Data center", keys: ["data_center"] }],
  square: [{ label: "Environment", keys: ["environment"] }],
  amplitude: [{ label: "Region", keys: ["region"] }],
  mixpanel: [
    { label: "Project ID", keys: ["project_id"] },
    { label: "Region", keys: ["region"] },
  ],
  posthog: [
    { label: "Host", keys: ["host"] },
    { label: "Project ID", keys: ["project_id"] },
  ],
  google_analytics: [
    { label: "Default property", keys: ["property_name", "property_id"] },
    { label: "Property ID", keys: ["property_id"] },
  ],
  sentry: [{ label: "Organization", keys: ["organization"] }],
  salesforce: [{ label: "Instance URL", keys: ["instance_url"] }],
  remote_mcp: [
    { label: "Server URL", keys: ["server_url"] },
    { label: "Transport", keys: ["transport"] },
    { label: "Auth type", keys: ["auth_type"] },
    { label: "Auth header", keys: ["auth_header"] },
  ],
  other: [
    { label: "Base URL", keys: ["base_url", "url"] },
    { label: "Auth type", keys: ["auth_type"] },
    { label: "Display name", keys: ["display_name"] },
    { label: "Description", keys: ["description"] },
  ],
  aws: [
    { label: "Region", keys: ["region"] },
    { label: "Role ARN", keys: ["role_arn"] },
  ],
  gcp: [{ label: "Project ID", keys: ["project_id"] }],
  azure: [
    { label: "Tenant ID", keys: ["tenant_id"] },
    { label: "Subscription ID", keys: ["subscription_id"] },
  ],
  vercel: [{ label: "Team ID", keys: ["team_id"] }],
  cloudflare: [{ label: "Account ID", keys: ["account_id"] }],
  openai: [{ label: "Organization ID", keys: ["organization_id"] }],
  anthropic: [{ label: "Provider", keys: ["display_name"] }],
  openrouter: [{ label: "Provider", keys: ["display_name"] }],
  discord: [{ label: "Application ID", keys: ["application_id"] }],
  teams: [{ label: "Tenant ID", keys: ["tenant_id"] }],
};

export function isChannelIntegrationType(
  integrationType: string,
): integrationType is ChannelIntegrationType {
  return CHANNEL_INTEGRATION_TYPES.includes(
    integrationType as ChannelIntegrationType,
  );
}

export function panelItemFromConnection(connection: ConnectionListItem): PanelItem {
  if (isChannelIntegrationType(connection.integration_type)) {
    return {
      kind: "channel",
      channel: connection.integration_type,
      id: connection.id,
      connection,
    };
  }
  return { kind: "connection", id: connection.id, connection };
}

export function emailPanelItem(email: EmailChannel): PanelItem {
  return { kind: "channel", channel: "email", id: "email", email };
}

export function panelItemName(item: PanelItem): string {
  if (item.kind === "connection") return item.connection.name;
  if (item.channel === "email") return "Email";
  return item.connection.name;
}

export function panelItemConnection(item: PanelItem): ConnectionListItem | null {
  if (item.kind === "connection") return item.connection;
  if (item.channel === "email") return null;
  return item.connection;
}

export function providerDisplayName(integrationType: string): string {
  return getIntegrationDefinition(integrationType)?.displayName ?? integrationType;
}

export function deriveCapabilities(connection: Integration): Capability[] {
  const caps: Capability[] = [];

  if (connection.category === "databases") caps.push("query_database");

  if (
    connection.integration_type === "remote_mcp" ||
    getProviderMcpDefinition(connection.integration_type)
  ) {
    caps.push("mcp_tools");
  }

  if (
    connection.integration_type === "google_analytics" ||
    ("definitionMetadata" in connection &&
      Boolean((connection as ConnectionListItem).definitionMetadata?.operationCount))
  ) {
    caps.push("typed_operations");
  }

  if (connection.integration_type === "telegram") caps.push("channel_send");
  if (connection.integration_type === "slack") {
    caps.push("channel_send", "slack_api");
  }

  if (
    connection.category !== "databases" &&
    connection.integration_type !== "remote_mcp" &&
    !getProviderMcpDefinition(connection.integration_type) &&
    connection.integration_type !== "telegram" &&
    connection.integration_type !== "slack" &&
    connection.integration_type !== "google_analytics"
  ) {
    caps.push("authenticated_fetch");
  }

  return caps;
}

export function getConnectionDetailRows(
  connection: ConnectionListItem,
): ConnectionDetailRow[] {
  const fields = DETAIL_FIELDS_BY_TYPE[connection.integration_type] ?? [];
  return fields.flatMap((field) => {
    const value = firstConfigValue(connection.config, field.keys);
    return value ? [{ label: field.label, value }] : [];
  });
}

export function connectionRequiresOutboundIpAllowlist(
  connection: ConnectionListItem,
): boolean {
  return Boolean(
    getIntegrationDefinition(connection.integration_type)?.requiresOutboundIpAllowlist,
  );
}

export function canReconnectConnection(connection: ConnectionListItem): boolean {
  if (connection.integration_type === "telegram") return false;
  if (
    connection.integration_type === "slack" ||
    connection.integration_type === "notion" ||
    connection.integration_type === "salesforce"
  ) {
    return true;
  }
  return (
    connection.integration_type === "remote_mcp" &&
    connection.config.auth_type === "oauth"
  );
}

export function getSlackChannelMetadata(connection: ConnectionListItem): {
  team_id: string | null;
  team_name: string | null;
  bot_user_id: string | null;
} {
  return {
    team_id:
      connection.channelMetadata?.team_id ??
      stringConfigValue(connection.config, "team_id"),
    team_name:
      connection.channelMetadata?.team_name ??
      stringConfigValue(connection.config, "team_name"),
    bot_user_id:
      connection.channelMetadata?.bot_user_id ??
      stringConfigValue(connection.config, "bot_user_id"),
  };
}

export function buildConnectionGroups(
  connections: readonly ConnectionListItem[],
  email: EmailChannel,
): { channels: PanelItem[]; connections: PanelItem[] } {
  const channels: PanelItem[] = [emailPanelItem(email)];
  const connectionItems: PanelItem[] = [];

  for (const connection of connections) {
    const item = panelItemFromConnection(connection);
    if (item.kind === "channel") {
      channels.push(item);
    } else {
      connectionItems.push(item);
    }
  }

  return { channels, connections: connectionItems };
}

export function filterAndSortConnectionGroups(
  groups: { channels: PanelItem[]; connections: PanelItem[] },
  query: string,
  sortBy: ConnectionSort,
): { channels: PanelItem[]; connections: PanelItem[] } {
  return {
    channels: sortPanelItems(
      groups.channels.filter((item) => panelItemMatchesQuery(item, query)),
      sortBy,
    ),
    connections: sortPanelItems(
      groups.connections.filter((item) => panelItemMatchesQuery(item, query)),
      sortBy,
    ),
  };
}

export function sortPanelItems(
  items: readonly PanelItem[],
  sortBy: ConnectionSort,
): PanelItem[] {
  return [...items].sort((a, b) => {
    if (a.kind === "channel" && a.channel === "email") return -1;
    if (b.kind === "channel" && b.channel === "email") return 1;

    switch (sortBy) {
      case "name":
        return panelItemName(a).localeCompare(panelItemName(b), undefined, {
          sensitivity: "base",
        });
      case "created":
        return itemCreatedAt(b) - itemCreatedAt(a);
      case "updated":
      default:
        return itemUpdatedAt(b) - itemUpdatedAt(a);
    }
  });
}

function panelItemMatchesQuery(item: PanelItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  if (item.kind === "channel" && item.channel === "email") {
    return ["email", item.email.address, item.email.handle]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized));
  }

  const connection = panelItemConnection(item);
  if (!connection) return false;
  return [
    connection.name,
    connection.integration_type,
    providerDisplayName(connection.integration_type),
  ].some((value) => value.toLowerCase().includes(normalized));
}

function itemCreatedAt(item: PanelItem): number {
  if (item.kind === "channel" && item.channel === "email") {
    return item.email.workspaceCreatedAt ?? 0;
  }
  const connection = panelItemConnection(item);
  if (connection) return connection.created_at;
  return 0;
}

function itemUpdatedAt(item: PanelItem): number {
  if (item.kind === "channel" && item.channel === "email") {
    return item.email.workspaceCreatedAt ?? 0;
  }
  const connection = panelItemConnection(item);
  if (connection) return connection.updated_at;
  return 0;
}

function firstConfigValue(
  config: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = formatConfigValue(config[key]);
    if (value) return value;
  }
  return null;
}

function stringConfigValue(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const value = config[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatConfigValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}
