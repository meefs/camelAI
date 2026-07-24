export const DISCORD_CHANNEL_PERMISSION_BITS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

export const DISCORD_CHANNEL_PERMISSION_MASK = Object.values(
  DISCORD_CHANNEL_PERMISSION_BITS,
).reduce((mask, permission) => mask | permission, 0n);

export const DISCORD_CHANNEL_PERMISSION_DECIMAL =
  DISCORD_CHANNEL_PERMISSION_MASK.toString();

export type DiscordMessageContentMode = "full" | "mention_only";

export interface DiscordPendingSetupContext {
  request_id: string;
  thread_id: string;
  return_path: string;
  created_at: number;
}

export interface DiscordChannelConfigV1 {
  schema_version: 1;
  status: "pending_channel" | "active" | "disconnected" | "setup_error";
  application_id: string;
  guild_id: string;
  guild_name: string;
  parent_channel_id?: string;
  parent_channel_name?: string;
  bot_user_id?: string;
  binding_version?: number;
  message_content_mode: DiscordMessageContentMode;
  security_acknowledged_at?: number;
  last_verified_at?: number;
  error_code?: string;
  pending_setup?: DiscordPendingSetupContext;
  binding_transaction_id?: string;
}

export interface DiscordBridgeBindingRecord {
  guildId: string;
  parentChannelId: string;
  integrationId: string;
  orgId: string;
  workspaceId: string;
  guildName: string;
  parentChannelName: string;
  status: "active" | "disconnected";
  version: number;
}

export interface DiscordSelectableChannel {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  position: number;
  missingPermissions: string[];
  canActivate: boolean;
  exposure: "restricted" | "visible_to_everyone";
}

export interface DiscordBridgeDeliveryMessage {
  kind: "message";
  discordMessageId: string;
  guildId: string;
  channelId: string;
  parentChannelId: string;
  threadId: string | null;
  integrationId: string;
  orgId: string;
  workspaceId: string;
  bindingVersion: number;
  ordinal: number;
  content: string;
  messageType: 0 | 19;
  author: {
    id: string;
    username: string | null;
    globalName: string | null;
    guildNickname: string | null;
  };
  mentions: Array<{
    id: string;
    username: string | null;
    globalName: string | null;
  }>;
  attachments: Array<{
    id: string;
    filename: string;
    contentType: string | null;
    size: number;
    url: string;
  }>;
  timestamp: string | null;
  contentMode: DiscordMessageContentMode;
  starter: boolean;
}

export interface DiscordBridgeDeliveryLifecycle {
  kind: "lifecycle";
  lifecycleType: "guild_removed" | "parent_channel_deleted";
  guildId: string;
  parentChannelId: string | null;
  integrationId: string;
  orgId: string;
  workspaceId: string;
  bindingVersion: number;
}

export type DiscordBridgeDelivery =
  | DiscordBridgeDeliveryMessage
  | DiscordBridgeDeliveryLifecycle;

export interface DiscordEventQueueMessage {
  version: 1;
  eventId: string;
}

export type DiscordBridgeFetcher = Fetcher;

const DISCORD_APPLICATION_ID_PATTERN = /^\d{17,20}$/;

export function discordApplicationIdConfigured(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return DISCORD_APPLICATION_ID_PATTERN.test(normalized) &&
    !/^0+$/u.test(normalized);
}

export function discordClientSecretConfigured(value: string | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return normalized.length >= 20 &&
    !normalized.toUpperCase().includes("SET_IN_DISCORD_DEVELOPER_PORTAL");
}

export class DiscordBridgeRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DiscordBridgeRequestError";
  }
}

export async function discordBridgeRequest<T>(
  bridge: DiscordBridgeFetcher | undefined,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!bridge) {
    throw new DiscordBridgeRequestError(
      "not_configured",
      "Discord channel is not configured",
      503,
    );
  }
  const response = await bridge.fetch(
    new Request(`https://discord-bridge.internal${path}`, init),
  );
  const payload = await response.json().catch(() => null) as (
    Record<string, unknown> & {
      error?: string;
      message?: string;
      retryAfterMs?: number;
    }
  ) | null;
  if (!response.ok || payload?.ok === false) {
    throw new DiscordBridgeRequestError(
      payload?.error || "provider_unavailable",
      payload?.message || "Discord bridge request failed",
      response.status,
      payload?.retryAfterMs,
    );
  }
  return payload as T;
}

export function discordChannelEnabled(env: {
  DISCORD_CHANNEL_ENABLED?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BRIDGE?: DiscordBridgeFetcher;
}): boolean {
  if (!env.DISCORD_BRIDGE) return false;
  if (env.DISCORD_CHANNEL_ENABLED?.trim().toLowerCase() !== "true") return false;
  return discordApplicationIdConfigured(env.DISCORD_CLIENT_ID) &&
    discordClientSecretConfigured(env.DISCORD_CLIENT_SECRET);
}

interface DiscordCatalogBridgeStatus {
  applicationId: string;
  botUserId: string | null;
  readiness: {
    ready: boolean;
    reason: string;
  };
  gateway: {
    state: string;
    heartbeatIntervalMs: number | null;
    lastHeartbeatAckAt: number | null;
  };
}

export interface DiscordChannelAvailability {
  catalogAvailable: boolean;
  operationalReady: boolean;
  reason: string;
}

/**
 * Catalog visibility requires a usable OAuth configuration and a live bridge
 * identity/Gateway. Ingress may intentionally remain dark during setup.
 */
export async function getDiscordChannelAvailability(
  env: {
    DISCORD_CHANNEL_ENABLED?: string;
    DISCORD_CLIENT_ID?: string;
    DISCORD_CLIENT_SECRET?: string;
    DISCORD_BRIDGE?: DiscordBridgeFetcher;
  },
  now = Date.now(),
): Promise<DiscordChannelAvailability> {
  const unavailable = (reason: string): DiscordChannelAvailability => ({
    catalogAvailable: false,
    operationalReady: false,
    reason,
  });
  if (!discordChannelEnabled(env)) return unavailable("main_configuration_unavailable");
  try {
    const status = await discordBridgeRequest<DiscordCatalogBridgeStatus>(
      env.DISCORD_BRIDGE,
      "/internal/v1/status",
    );
    const readinessValid =
      (status.readiness?.ready === true && status.readiness.reason === "ready") ||
      (status.readiness?.ready === false && status.readiness.reason === "ingress_disabled");
    if (
      status.applicationId !== env.DISCORD_CLIENT_ID ||
      status.botUserId !== status.applicationId ||
      !readinessValid ||
      (status.gateway.state !== "ready" && status.gateway.state !== "resumed") ||
      !status.gateway.lastHeartbeatAckAt
    ) {
      return unavailable("bridge_identity_or_gateway_unavailable");
    }
    const freshnessWindow = Math.max(
      120_000,
      (status.gateway.heartbeatIntervalMs ?? 0) * 2,
    );
    if (now - status.gateway.lastHeartbeatAckAt > freshnessWindow) {
      return unavailable("gateway_heartbeat_stale");
    }
    return {
      catalogAvailable: true,
      operationalReady: status.readiness.ready,
      reason: status.readiness.reason,
    };
  } catch {
    return unavailable("bridge_status_unavailable");
  }
}

export async function discordChannelCatalogAvailable(
  env: Parameters<typeof getDiscordChannelAvailability>[0],
  now = Date.now(),
): Promise<boolean> {
  return (await getDiscordChannelAvailability(env, now)).catalogAvailable;
}

export function parseDiscordChannelConfig(value: string): DiscordChannelConfigV1 | null {
  try {
    const parsed = JSON.parse(value) as Partial<DiscordChannelConfigV1>;
    const validStatuses = new Set([
      "pending_channel",
      "active",
      "disconnected",
      "setup_error",
    ]);
    if (
      parsed.schema_version !== 1 ||
      typeof parsed.guild_id !== "string" || !parsed.guild_id.trim() ||
      typeof parsed.guild_name !== "string" || !parsed.guild_name.trim() ||
      typeof parsed.application_id !== "string" || !parsed.application_id.trim() ||
      typeof parsed.status !== "string" || !validStatuses.has(parsed.status) ||
      (parsed.message_content_mode !== "full" &&
        parsed.message_content_mode !== "mention_only") ||
      (parsed.status === "active" &&
        (typeof parsed.parent_channel_id !== "string" ||
          !parsed.parent_channel_id.trim() ||
          !Number.isInteger(parsed.binding_version) ||
          (parsed.binding_version ?? 0) < 1))
    ) {
      return null;
    }
    return parsed as DiscordChannelConfigV1;
  } catch {
    return null;
  }
}
