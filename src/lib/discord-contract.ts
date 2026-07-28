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

export interface DiscordPendingReauthorization {
  activation_attempt_id: string;
  application_id: string;
  guild_id: string;
  guild_name: string;
  bot_user_id?: string;
  message_content_mode: DiscordMessageContentMode;
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
  pending_reauthorization?: DiscordPendingReauthorization;
  activation_attempt_id?: string;
}

export interface DiscordBridgeBinding {
  guildId: string;
  parentChannelId: string;
  integrationId: string;
  orgId: string;
  workspaceId: string;
  guildName: string;
  parentChannelName: string;
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

export interface DiscordBridgeStatus {
  applicationId: string;
  botUserId: string | null;
  contentMode: DiscordMessageContentMode;
  readiness: {
    ready: boolean;
    status: string;
    reason: string;
    message: string;
  };
  gateway: {
    state: string;
    heartbeatIntervalMs: number | null;
    lastHeartbeatAckAt: number | null;
  };
}

export interface DiscordGuildChannels {
  guild: { id: string; name: string };
  botUserId: string;
  contentMode: DiscordMessageContentMode;
  channels: DiscordSelectableChannel[];
}

export interface DiscordActivateBindingInput {
  guildId: string;
  parentChannelId: string;
  integrationId: string;
  orgId: string;
  workspaceId: string;
  idempotencyKey: string;
  expectedVersion?: number;
}

export interface DiscordActivateBindingResult {
  binding: DiscordBridgeBinding;
  previousBinding: DiscordBridgeBinding | null;
  confirmationMessageIds: string[];
}

export type DiscordDeliveryClaim =
  | {
      status: "claimed";
      leaseToken: string;
      payload: DiscordBridgeDelivery;
    }
  | {
      status: "ordered_wait" | "wait" | "completed" | "invalid";
      retryAfterMs?: number;
    };

export interface DiscordMessageSendResult {
  ok: true;
  threadId: string;
  integrationId: string;
  messageIds: string[];
  chunkCount: number;
  attachmentCount: number;
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
