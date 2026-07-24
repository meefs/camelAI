export type DiscordMessageContentMode = "full" | "mention_only";

export interface DiscordBridgeEnv {
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_MESSAGE_CONTENT_MODE?: string;
  DISCORD_INGRESS_ENABLED?: string;
  DISCORD_OUTBOUND_ENABLED?: string;
  DISCORD_EVENTS_QUEUE: Queue<DiscordQueueMessage>;
  GATEWAY: DurableObjectNamespace<import("./discord-gateway-do.js").DiscordGatewayDO>;
  CONTROL: DurableObjectNamespace<import("./discord-control-do.js").DiscordControlDO>;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
}

export interface DiscordGatewayHealthState {
  state: "idle" | "connecting" | "ready" | "resumed" | "reconnecting" | "fatal";
  shardId: 0;
  shardCount: 1;
  readyAt: number | null;
  resumedAt: number | null;
  heartbeatIntervalMs: number | null;
  lastHeartbeatAt: number | null;
  lastHeartbeatAckAt: number | null;
  lastSequence: number | null;
  reconnectCount: number;
  lastCloseCode: number | null;
  sessionStartsRemaining: number | null;
  sessionStartsResetAt: number | null;
  maxConcurrency: number | null;
  recommendedShardCount: number | null;
  contentMode: DiscordMessageContentMode;
  fatalReason: string | null;
}

export interface DiscordQueueMessage {
  version: 1;
  eventId: string;
}

export interface DiscordGatewayEnvelope {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export interface DiscordUserPayload {
  id?: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordAttachmentPayload {
  id?: string;
  filename?: string;
  content_type?: string | null;
  size?: number;
  url?: string;
}

export interface DiscordMessageCreatePayload {
  id?: string;
  guild_id?: string;
  channel_id?: string;
  content?: string;
  type?: number;
  webhook_id?: string;
  timestamp?: string;
  author?: DiscordUserPayload;
  member?: { nick?: string | null };
  mentions?: DiscordUserPayload[];
  mention_roles?: string[];
  attachments?: DiscordAttachmentPayload[];
}

export interface DiscordGuildDeletePayload {
  id?: string;
  unavailable?: boolean;
}

export interface DiscordChannelDeletePayload {
  id?: string;
  guild_id?: string;
  parent_id?: string | null;
  type?: number;
}

export interface DiscordReducedMessageEvent {
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

export interface DiscordReducedLifecycleEvent {
  kind: "lifecycle";
  lifecycleType: "guild_removed" | "parent_channel_deleted";
  guildId: string;
  parentChannelId: string | null;
  integrationId: string;
  orgId: string;
  workspaceId: string;
  bindingVersion: number;
}

export type DiscordDeliveryPayload =
  | DiscordReducedMessageEvent
  | DiscordReducedLifecycleEvent;

export interface DiscordChannelBinding {
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

export interface DiscordThreadBinding {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  integrationId: string;
  orgId: string;
  workspaceId: string;
}

export interface DiscordRolePayload {
  id: string;
  name?: string;
  permissions: string;
  managed?: boolean;
  tags?: {
    bot_id?: string;
  };
}

export interface DiscordGuildMemberPayload {
  user?: DiscordUserPayload;
  roles?: string[];
}

export interface DiscordPermissionOverwritePayload {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface DiscordChannelPayload {
  id: string;
  guild_id?: string;
  parent_id?: string | null;
  name?: string;
  type: number;
  position?: number;
  permission_overwrites?: DiscordPermissionOverwritePayload[];
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

export type DiscordBridgeErrorCode =
  | "invalid_request"
  | "not_configured"
  | "binding_conflict"
  | "binding_not_found"
  | "binding_mismatch"
  | "missing_permissions"
  | "active_thread_limit"
  | "unknown_channel"
  | "bot_removed"
  | "rate_limited"
  | "provider_unavailable"
  | "fatal_auth";

export class DiscordBridgeError extends Error {
  constructor(
    public readonly code: DiscordBridgeErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DiscordBridgeError";
  }
}

export function discordContentMode(env: Pick<DiscordBridgeEnv, "DISCORD_MESSAGE_CONTENT_MODE">): DiscordMessageContentMode {
  return env.DISCORD_MESSAGE_CONTENT_MODE?.trim().toLowerCase() === "mention_only"
    ? "mention_only"
    : "full";
}

export function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
