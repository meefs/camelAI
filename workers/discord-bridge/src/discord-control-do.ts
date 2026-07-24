import { DurableObject } from "cloudflare:workers";
import {
  calculateDiscordChannelPermissions,
  calculateDiscordEveryonePermissions,
  discordEveryoneCanPost,
  missingDiscordBotPermissions,
} from "./discord-permissions.js";
import {
  discordOutboundTextWithNotice,
  normalizeDiscordThreadName,
} from "./gateway-protocol.js";
import { DiscordRestClient } from "./discord-rest.js";
import { evaluateDiscordBridgeReadiness } from "./bridge-health.js";
import { recordDiscordBridgeEvent } from "./observability.js";
import {
  DiscordBridgeError,
  discordContentMode,
  envFlag,
  type DiscordBridgeEnv,
  type DiscordChannelBinding,
  type DiscordChannelPayload,
  type DiscordDeliveryPayload,
  type DiscordGatewayEnvelope,
  type DiscordGuildDeletePayload,
  type DiscordMessageCreatePayload,
  type DiscordReducedLifecycleEvent,
  type DiscordReducedMessageEvent,
  type DiscordRolePayload,
  type DiscordSelectableChannel,
} from "./types.js";

const MAX_INTERNAL_JSON_BYTES = 256 * 1024;
const MAX_OUTBOUND_BODY_BYTES = 26 * 1024 * 1024;
const DELIVERY_LEASE_MS = 5 * 60_000;
const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OUTBOX_EXPIRY_MS = 24 * 60 * 60 * 1_000;
const THREAD_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const AUXILIARY_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;

interface ChannelBindingRow {
  [key: string]: SqlStorageValue;
  guild_id: string;
  parent_channel_id: string;
  integration_id: string;
  org_id: string;
  workspace_id: string;
  guild_name: string;
  parent_channel_name: string;
  status: "active" | "disconnected";
  version: number;
  created_at: number;
  updated_at: number;
}

interface ThreadBindingRow {
  [key: string]: SqlStorageValue;
  thread_id: string;
  guild_id: string;
  parent_channel_id: string;
  integration_id: string;
  org_id: string;
  workspace_id: string;
  next_ingress_ordinal: number;
  mention_notice_sent: number;
  created_at: number;
  last_seen_at: number;
}

interface OutboxRow {
  [key: string]: SqlStorageValue;
  event_id: string;
  discord_message_id: string;
  conversation_key: string;
  ordinal: number;
  binding_version: number;
  payload_json: string | null;
  state: "pending" | "enqueued" | "leased" | "completed" | "failed";
  lease_token: string | null;
  lease_expires_at: number | null;
  enqueue_attempts: number;
  created_at: number;
  updated_at: number;
}

interface ClaimBindingInput {
  guildId: string;
  parentChannelId: string;
  integrationId: string;
  orgId: string;
  workspaceId: string;
  idempotencyKey: string;
}

interface ReplaceBindingResult {
  binding: DiscordChannelBinding;
  previousBinding: DiscordChannelBinding;
}

interface BindingTransactionRow {
  [key: string]: SqlStorageValue;
  transaction_id: string;
  integration_id: string;
  target_guild_id: string;
  target_parent_channel_id: string;
  previous_binding_json: string | null;
  proposed_binding_json: string;
  state: "prepared" | "confirmed" | "committed" | "finalized" | "aborted";
  confirmation_message_ids_json: string | null;
  created_at: number;
  updated_at: number;
}

interface BindingTransactionResult {
  transactionId: string;
  binding: DiscordChannelBinding;
  previousBinding: DiscordChannelBinding | null;
  state: BindingTransactionRow["state"];
  confirmationMessageIds: string[];
}

interface DiscordOperationRow {
  [key: string]: SqlStorageValue;
  operation_kind: string;
  result_json: string;
}

interface FailureNoticeRow {
  [key: string]: SqlStorageValue;
  event_id: string;
  integration_id: string;
  parent_channel_id: string;
  target_channel_id: string;
  discord_message_id: string;
  state: "pending" | "sent" | "suppressed";
  created_at: number;
  updated_at: number;
}

interface ProactiveThreadIntentRow {
  [key: string]: SqlStorageValue;
  operation_id: string;
  integration_id: string;
  guild_id: string;
  parent_channel_id: string;
  thread_name: string;
  starter_message_id: string | null;
  thread_id: string | null;
  started_at: number;
  updated_at: number;
}

interface ProactiveThreadResult {
  threadId: string;
  integrationId: string;
  guildId: string;
  parentChannelId: string;
  starterMessageId: string;
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof DiscordBridgeError) {
    const status =
      error.code === "binding_conflict" ? 409
      : error.code === "active_thread_limit" ? 409
      : error.code === "binding_not_found" || error.code === "unknown_channel" ? 404
      : error.code === "missing_permissions" ? 403
      : error.code === "rate_limited" ? 429
      : error.code === "not_configured" || error.code === "provider_unavailable" ? 503
      : error.code === "fatal_auth" ? 502
      : 400;
    return jsonResponse(
      {
        ok: false,
        error: error.code,
        message: error.message,
        retryAfterMs: error.retryAfterMs,
      },
      status,
    );
  }
  console.error("[discord-control] internal operation failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  return jsonResponse(
    { ok: false, error: "provider_unavailable", message: "Discord bridge operation failed" },
    500,
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DiscordBridgeError("invalid_request", `${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readJsonObject(request: Request, maxBytes = MAX_INTERNAL_JSON_BYTES): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new DiscordBridgeError("invalid_request", "Request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new DiscordBridgeError("invalid_request", "Request body is too large");
  }
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new DiscordBridgeError("invalid_request", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DiscordBridgeError("invalid_request", "Request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function toBinding(row: ChannelBindingRow): DiscordChannelBinding {
  return {
    guildId: row.guild_id,
    parentChannelId: row.parent_channel_id,
    integrationId: row.integration_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    guildName: row.guild_name,
    parentChannelName: row.parent_channel_name,
    status: row.status,
    version: row.version,
  };
}

function toBindingTransaction(row: BindingTransactionRow): BindingTransactionResult {
  return {
    transactionId: row.transaction_id,
    binding: JSON.parse(row.proposed_binding_json) as DiscordChannelBinding,
    previousBinding: row.previous_binding_json
      ? JSON.parse(row.previous_binding_json) as DiscordChannelBinding
      : null,
    state: row.state,
    confirmationMessageIds: row.confirmation_message_ids_json
      ? JSON.parse(row.confirmation_message_ids_json) as string[]
      : [],
  };
}

function isRetryableBridgeError(error: unknown): boolean {
  return error instanceof DiscordBridgeError &&
    (error.code === "rate_limited" || error.code === "provider_unavailable");
}

export class DiscordControlDO extends DurableObject<DiscordBridgeEnv> {
  private readonly rest: DiscordRestClient;
  private readonly proactiveThreadInFlight = new Map<string, {
    integrationId: string;
    name: string;
    starterText: string;
    promise: Promise<ProactiveThreadResult>;
  }>();

  constructor(ctx: DurableObjectState, env: DiscordBridgeEnv) {
    super(ctx, env);
    this.rest = new DiscordRestClient(
      env.DISCORD_BOT_TOKEN,
      fetch,
      Date.now,
      (observation) => recordDiscordBridgeEvent(env, {
        event: "discord.rest.request",
        component: "discord_rest",
        operation: observation.operation,
        status: [
          observation.status,
          observation.rateLimitScope,
          observation.retryAfterMs === undefined ? undefined : `${observation.retryAfterMs}ms`,
        ].filter(Boolean).join(":"),
        durationMs: observation.durationMs,
        statusCode: observation.statusCode,
        count: observation.retryAfterMs,
        error: observation.status === "failed" ? observation.error : undefined,
        severity: observation.status === "failed"
          ? "error"
          : observation.status === "retry" ? "warn" : "info",
      }),
    );
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  private assertOutboundEnabled(): void {
    if (!envFlag(this.env.DISCORD_OUTBOUND_ENABLED, true)) {
      throw new DiscordBridgeError(
        "not_configured",
        "Discord outbound mutations are disabled",
      );
    }
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_bindings (
        guild_id TEXT NOT NULL,
        parent_channel_id TEXT NOT NULL,
        integration_id TEXT NOT NULL UNIQUE,
        org_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        guild_name TEXT NOT NULL,
        parent_channel_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disconnected')),
        version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, parent_channel_id)
      );
      CREATE TABLE IF NOT EXISTS thread_bindings (
        thread_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        parent_channel_id TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        next_ingress_ordinal INTEGER NOT NULL DEFAULT 2,
        mention_notice_sent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_bindings_integration
        ON thread_bindings (integration_id);
      CREATE TABLE IF NOT EXISTS ingress_outbox (
        event_id TEXT PRIMARY KEY,
        discord_message_id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        binding_version INTEGER NOT NULL,
        payload_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'enqueued', 'leased', 'completed', 'failed')),
        lease_token TEXT,
        lease_expires_at INTEGER,
        enqueue_attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (conversation_key, ordinal)
      );
      CREATE INDEX IF NOT EXISTS ingress_outbox_state
        ON ingress_outbox (state, updated_at);
      CREATE TABLE IF NOT EXISTS conversation_state (
        conversation_key TEXT PRIMARY KEY,
        completed_ordinal INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS internal_operations (
        operation_id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS control_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS guild_presence (
        guild_id TEXT PRIMARY KEY,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failure_notices (
        event_id TEXT PRIMARY KEY,
        integration_id TEXT NOT NULL,
        parent_channel_id TEXT NOT NULL,
        target_channel_id TEXT NOT NULL,
        discord_message_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'suppressed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proactive_thread_intents (
        operation_id TEXT PRIMARY KEY,
        integration_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        parent_channel_id TEXT NOT NULL,
        thread_name TEXT NOT NULL,
        starter_message_id TEXT,
        thread_id TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS binding_transactions (
        transaction_id TEXT PRIMARY KEY,
        integration_id TEXT NOT NULL,
        target_guild_id TEXT NOT NULL,
        target_parent_channel_id TEXT NOT NULL,
        previous_binding_json TEXT,
        proposed_binding_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('prepared', 'confirmed', 'committed', 'finalized', 'aborted')
        ),
        confirmation_message_ids_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS binding_transactions_live_integration
        ON binding_transactions (integration_id)
        WHERE state IN ('prepared', 'confirmed', 'committed');
      CREATE UNIQUE INDEX IF NOT EXISTS binding_transactions_live_target
        ON binding_transactions (target_guild_id, target_parent_channel_id)
        WHERE state IN ('prepared', 'confirmed', 'committed');
    `);
    const threadColumns = this.ctx.storage.sql.exec<{ name: string }>(
      "PRAGMA table_info(thread_bindings)",
    ).toArray();
    if (!threadColumns.some((column) => column.name === "mention_notice_sent")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE thread_bindings ADD COLUMN mention_notice_sent INTEGER NOT NULL DEFAULT 0",
      );
    }
    const proactiveIntentColumns = this.ctx.storage.sql.exec<{ name: string }>(
      "PRAGMA table_info(proactive_thread_intents)",
    ).toArray();
    if (!proactiveIntentColumns.some((column) => column.name === "starter_message_id")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE proactive_thread_intents ADD COLUMN starter_message_id TEXT",
      );
    }
  }

  private activeBindingByIntegration(integrationId: string): ChannelBindingRow | null {
    return this.ctx.storage.sql.exec<ChannelBindingRow>(
      "SELECT * FROM channel_bindings WHERE integration_id = ? AND status = 'active'",
      integrationId,
    ).toArray()[0] ?? null;
  }

  private activeBindingForChannel(guildId: string, channelId: string): ChannelBindingRow | null {
    return this.ctx.storage.sql.exec<ChannelBindingRow>(
      "SELECT * FROM channel_bindings WHERE guild_id = ? AND parent_channel_id = ? AND status = 'active'",
      guildId,
      channelId,
    ).toArray()[0] ?? null;
  }

  private threadBinding(threadId: string): ThreadBindingRow | null {
    return this.ctx.storage.sql.exec<ThreadBindingRow>(
      "SELECT * FROM thread_bindings WHERE thread_id = ?",
      threadId,
    ).toArray()[0] ?? null;
  }

  private operationResult<T>(operationId: string, expectedKind: string): T | null {
    const row = this.ctx.storage.sql.exec<DiscordOperationRow>(
      "SELECT operation_kind, result_json FROM internal_operations WHERE operation_id = ?",
      operationId,
    ).toArray()[0];
    if (row && row.operation_kind !== expectedKind) {
      throw new DiscordBridgeError(
        "invalid_request",
        "Idempotency key was already used for a different Discord operation",
      );
    }
    return row ? JSON.parse(row.result_json) as T : null;
  }

  private storeOperation(operationId: string, kind: string, result: unknown): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO internal_operations
       (operation_id, operation_kind, result_json, created_at) VALUES (?, ?, ?, ?)`,
      operationId,
      kind,
      JSON.stringify(result),
      Date.now(),
    );
  }

  private nextBindingVersion(): number {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM control_metadata WHERE key = 'next_binding_version'",
    ).toArray()[0];
    const version = row ? Number(row.value) : 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO control_metadata (key, value, updated_at) VALUES ('next_binding_version', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      String(version + 1),
      Date.now(),
    );
    return version;
  }

  private async botUserId(): Promise<string> {
    const stored = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM control_metadata WHERE key = 'bot_user_id'",
    ).toArray()[0]?.value;
    if (stored) return stored;
    const bot = await this.rest.getCurrentUser();
    await this.setBotIdentity(bot.id);
    return bot.id;
  }

  async setBotIdentity(botUserId: string): Promise<void> {
    if (!botUserId) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO control_metadata (key, value, updated_at) VALUES ('bot_user_id', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      botUserId,
      Date.now(),
    );
  }

  private storeManagedBotRoleIds(
    guildId: string,
    botUserId: string,
    roles: DiscordRolePayload[],
  ): string[] {
    const roleIds = roles
      .filter((role) => role.managed === true && role.tags?.bot_id === botUserId)
      .map((role) => role.id);
    this.ctx.storage.sql.exec(
      `INSERT INTO control_metadata (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      `bot_role_ids:${guildId}`,
      JSON.stringify(roleIds),
      Date.now(),
    );
    return roleIds;
  }

  private cachedManagedBotRoleIds(guildId: string): string[] | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM control_metadata WHERE key = ?",
      `bot_role_ids:${guildId}`,
    ).toArray()[0];
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : null;
    } catch {
      return null;
    }
  }

  private async managedBotRoleIds(
    guildId: string,
    botUserId: string,
  ): Promise<string[]> {
    const cached = this.cachedManagedBotRoleIds(guildId);
    if (cached) return cached;
    return this.storeManagedBotRoleIds(
      guildId,
      botUserId,
      await this.rest.getGuildRoles(guildId),
    );
  }

  private async inspectGuild(guildId: string): Promise<{
    guild: { id: string; name: string };
    botUserId: string;
    contentMode: "full" | "mention_only";
    channels: DiscordSelectableChannel[];
  }> {
    const botUserId = await this.botUserId();
    let guild: { id: string; name: string };
    let channels: DiscordChannelPayload[];
    let roles;
    let member;
    try {
      [guild, channels, roles, member] = await Promise.all([
        this.rest.getGuild(guildId),
        this.rest.getGuildChannels(guildId),
        this.rest.getGuildRoles(guildId),
        this.rest.getGuildMember(guildId, botUserId),
      ]);
    } catch (error) {
      if (error instanceof DiscordBridgeError && error.code === "unknown_channel") {
        throw new DiscordBridgeError("bot_removed", "Camel is not installed in this Discord server");
      }
      throw error;
    }
    this.storeManagedBotRoleIds(guildId, botUserId, roles);
    const categories = new Map(
      channels.filter((channel) => channel.type === 4).map((channel) => [channel.id, channel.name || ""]),
    );
    return {
      guild,
      botUserId,
      contentMode: discordContentMode(this.env),
      channels: channels
        .filter((channel) => channel.type === 0)
        .map((channel) => {
          const permissions = calculateDiscordChannelPermissions({ guildId, roles, member, channel });
          const everyone = calculateDiscordEveryonePermissions({ guildId, roles, channel });
          const missingPermissions = missingDiscordBotPermissions(permissions);
          return {
            id: channel.id,
            name: channel.name || channel.id,
            categoryId: channel.parent_id || null,
            categoryName: channel.parent_id ? categories.get(channel.parent_id) || null : null,
            position: channel.position ?? 0,
            missingPermissions,
            canActivate: missingPermissions.length === 0,
            exposure: discordEveryoneCanPost(everyone)
              ? "visible_to_everyone" as const
              : "restricted" as const,
          };
        })
        .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name)),
    };
  }

  private async preflightBinding(guildId: string, parentChannelId: string) {
    const inspected = await this.inspectGuild(guildId);
    const channel = inspected.channels.find((candidate) => candidate.id === parentChannelId);
    if (!channel) {
      throw new DiscordBridgeError("unknown_channel", "Select a standard Discord text channel");
    }
    if (!channel.canActivate) {
      throw new DiscordBridgeError(
        "missing_permissions",
        `Camel is missing: ${channel.missingPermissions.join(", ")}`,
      );
    }
    return { ...inspected, channel };
  }

  private async claimBinding(input: ClaimBindingInput): Promise<DiscordChannelBinding> {
    const cached = this.operationResult<DiscordChannelBinding>(input.idempotencyKey, "binding_claim");
    if (cached) return cached;
    const inspected = await this.preflightBinding(input.guildId, input.parentChannelId);
    const existingTarget = this.ctx.storage.sql.exec<ChannelBindingRow>(
      "SELECT * FROM channel_bindings WHERE guild_id = ? AND parent_channel_id = ?",
      input.guildId,
      input.parentChannelId,
    ).toArray()[0];
    if (existingTarget && existingTarget.integration_id !== input.integrationId) {
      throw new DiscordBridgeError(
        "binding_conflict",
        `#${inspected.channel.name} is already connected to another workspace`,
      );
    }
    const existingIntegration = this.ctx.storage.sql.exec<ChannelBindingRow>(
      "SELECT * FROM channel_bindings WHERE integration_id = ?",
      input.integrationId,
    ).toArray()[0];
    if (
      existingIntegration &&
      (existingIntegration.guild_id !== input.guildId ||
        existingIntegration.parent_channel_id !== input.parentChannelId)
    ) {
      throw new DiscordBridgeError(
        "binding_conflict",
        "This integration already owns a different Discord channel; use change channel",
      );
    }

    const now = Date.now();
    const version = existingTarget?.version ?? this.nextBindingVersion();
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_bindings (
        guild_id, parent_channel_id, integration_id, org_id, workspace_id,
        guild_name, parent_channel_name, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(guild_id, parent_channel_id) DO UPDATE SET
        org_id = excluded.org_id,
        workspace_id = excluded.workspace_id,
        guild_name = excluded.guild_name,
        parent_channel_name = excluded.parent_channel_name,
        status = 'active',
        updated_at = excluded.updated_at`,
      input.guildId,
      input.parentChannelId,
      input.integrationId,
      input.orgId,
      input.workspaceId,
      inspected.guild.name,
      inspected.channel.name,
      version,
      now,
      now,
    );
    const result = toBinding(this.activeBindingByIntegration(input.integrationId)!);
    this.storeOperation(input.idempotencyKey, "binding_claim", result);
    recordDiscordBridgeEvent(this.env, {
      event: "discord.binding.claimed",
      component: "discord_control",
      operation: "claim",
      status: "active",
      orgId: result.orgId,
      workspaceId: result.workspaceId,
      integrationId: result.integrationId,
    });
    return result;
  }

  private async replaceBinding(input: ClaimBindingInput & { expectedVersion: number }): Promise<ReplaceBindingResult> {
    const cached = this.operationResult<ReplaceBindingResult>(input.idempotencyKey, "binding_replace");
    if (cached) return cached;
    const prior = this.activeBindingByIntegration(input.integrationId);
    if (!prior || prior.version !== input.expectedVersion) {
      throw new DiscordBridgeError("binding_mismatch", "Discord binding changed; refresh and try again");
    }
    const previousBinding = toBinding(prior);
    if (prior.guild_id === input.guildId && prior.parent_channel_id === input.parentChannelId) {
      const result = { binding: previousBinding, previousBinding };
      this.storeOperation(input.idempotencyKey, "binding_replace", result);
      return result;
    }
    const inspected = await this.preflightBinding(input.guildId, input.parentChannelId);
    const result = this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql.exec<ChannelBindingRow>(
        "SELECT * FROM channel_bindings WHERE integration_id = ? AND status = 'active'",
        input.integrationId,
      ).toArray()[0];
      if (!current || current.version !== input.expectedVersion) {
        throw new DiscordBridgeError(
          "binding_mismatch",
          "Discord binding changed; refresh and try again",
        );
      }
      const conflict = this.ctx.storage.sql.exec<ChannelBindingRow>(
        "SELECT * FROM channel_bindings WHERE guild_id = ? AND parent_channel_id = ?",
        input.guildId,
        input.parentChannelId,
      ).toArray()[0];
      if (conflict && conflict.integration_id !== input.integrationId) {
        throw new DiscordBridgeError(
          "binding_conflict",
          `#${inspected.channel.name} is already connected to another workspace`,
        );
      }
      const version = this.nextBindingVersion();
      const now = Date.now();
      this.ctx.storage.sql.exec(
        "DELETE FROM channel_bindings WHERE integration_id = ? AND version = ?",
        input.integrationId,
        input.expectedVersion,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO channel_bindings (
          guild_id, parent_channel_id, integration_id, org_id, workspace_id,
          guild_name, parent_channel_name, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        input.guildId,
        input.parentChannelId,
        input.integrationId,
        input.orgId,
        input.workspaceId,
        inspected.guild.name,
        inspected.channel.name,
        version,
        now,
        now,
      );
      return toBinding(this.activeBindingByIntegration(input.integrationId)!);
    });
    const replacement = { binding: result, previousBinding };
    this.storeOperation(input.idempotencyKey, "binding_replace", replacement);
    recordDiscordBridgeEvent(this.env, {
      event: "discord.binding.replaced",
      component: "discord_control",
      operation: "replace",
      status: "active",
      orgId: result.orgId,
      workspaceId: result.workspaceId,
      integrationId: result.integrationId,
    });
    return replacement;
  }

  private bindingTransaction(transactionId: string): BindingTransactionRow | null {
    return this.ctx.storage.sql.exec<BindingTransactionRow>(
      "SELECT * FROM binding_transactions WHERE transaction_id = ?",
      transactionId,
    ).toArray()[0] ?? null;
  }

  private insertExactBinding(binding: DiscordChannelBinding, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO channel_bindings (
        guild_id, parent_channel_id, integration_id, org_id, workspace_id,
        guild_name, parent_channel_name, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      binding.guildId,
      binding.parentChannelId,
      binding.integrationId,
      binding.orgId,
      binding.workspaceId,
      binding.guildName,
      binding.parentChannelName,
      binding.version,
      now,
      now,
    );
  }

  private async prepareBindingTransaction(
    input: ClaimBindingInput & { expectedVersion?: number },
  ): Promise<BindingTransactionResult> {
    const existing = this.bindingTransaction(input.idempotencyKey);
    const retryingAborted = existing?.state === "aborted";
    if (existing) {
      const result = toBindingTransaction(existing);
      if (
        result.binding.integrationId !== input.integrationId ||
        result.binding.guildId !== input.guildId ||
        result.binding.parentChannelId !== input.parentChannelId ||
        result.binding.orgId !== input.orgId ||
        result.binding.workspaceId !== input.workspaceId
      ) {
        throw new DiscordBridgeError(
          "invalid_request",
          "Binding transaction id was already used for different inputs",
        );
      }
      if (!retryingAborted) return result;
    }

    const inspected = await this.preflightBinding(input.guildId, input.parentChannelId);
    return this.ctx.storage.transactionSync(() => {
      const current = this.activeBindingByIntegration(input.integrationId);
      if (
        input.expectedVersion === undefined
          ? current !== null
          : !current || current.version !== input.expectedVersion
      ) {
        throw new DiscordBridgeError(
          "binding_mismatch",
          "Discord binding changed; refresh and try again",
        );
      }
      if (
        current &&
        (current.org_id !== input.orgId || current.workspace_id !== input.workspaceId)
      ) {
        throw new DiscordBridgeError(
          "binding_conflict",
          "Discord binding ownership does not match this workspace",
        );
      }
      const target = this.ctx.storage.sql.exec<ChannelBindingRow>(
        "SELECT * FROM channel_bindings WHERE guild_id = ? AND parent_channel_id = ?",
        input.guildId,
        input.parentChannelId,
      ).toArray()[0];
      if (target && target.integration_id !== input.integrationId) {
        throw new DiscordBridgeError(
          "binding_conflict",
          `#${inspected.channel.name} is already connected to another workspace`,
        );
      }
      const inFlight = this.ctx.storage.sql.exec<BindingTransactionRow>(
        `SELECT * FROM binding_transactions
         WHERE state IN ('prepared', 'confirmed', 'committed')
           AND (
             integration_id = ? OR
             (target_guild_id = ? AND target_parent_channel_id = ?)
           )
         LIMIT 1`,
        input.integrationId,
        input.guildId,
        input.parentChannelId,
      ).toArray()[0];
      if (inFlight) {
        throw new DiscordBridgeError(
          "binding_conflict",
          "Another Discord channel activation is still being reconciled",
        );
      }

      const previousBinding = current ? toBinding(current) : null;
      const sameTarget = current?.guild_id === input.guildId &&
        current.parent_channel_id === input.parentChannelId;
      const retriedBinding = existing
        ? toBindingTransaction(existing).binding
        : null;
      const binding: DiscordChannelBinding = {
        guildId: input.guildId,
        parentChannelId: input.parentChannelId,
        integrationId: input.integrationId,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        guildName: inspected.guild.name,
        parentChannelName: inspected.channel.name,
        status: "active",
        version: retriedBinding?.version ??
          (sameTarget ? current!.version : this.nextBindingVersion()),
      };
      const now = Date.now();
      if (retryingAborted) {
        const retried = toBindingTransaction(existing!);
        const previousStillMatches = retried.previousBinding
          ? previousBinding?.guildId === retried.previousBinding.guildId &&
            previousBinding.parentChannelId === retried.previousBinding.parentChannelId &&
            previousBinding.version === retried.previousBinding.version
          : previousBinding === null;
        if (!previousStillMatches) {
          throw new DiscordBridgeError(
            "binding_mismatch",
            "Discord binding changed after the previous activation attempt",
          );
        }
        const retryState = retried.confirmationMessageIds.length > 0
          ? "confirmed"
          : "prepared";
        this.ctx.storage.sql.exec(
          `UPDATE binding_transactions
           SET proposed_binding_json = ?, state = ?, updated_at = ?
           WHERE transaction_id = ? AND state = 'aborted'`,
          JSON.stringify(binding),
          retryState,
          now,
          input.idempotencyKey,
        );
      } else {
        this.ctx.storage.sql.exec(
          `INSERT INTO binding_transactions (
            transaction_id, integration_id, target_guild_id, target_parent_channel_id,
            previous_binding_json, proposed_binding_json, state,
            confirmation_message_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
          input.idempotencyKey,
          input.integrationId,
          input.guildId,
          input.parentChannelId,
          previousBinding ? JSON.stringify(previousBinding) : null,
          JSON.stringify(binding),
          now,
          now,
        );
      }
      if (retryingAborted) {
        return toBindingTransaction(this.bindingTransaction(input.idempotencyKey)!);
      }
      return {
        transactionId: input.idempotencyKey,
        binding,
        previousBinding,
        state: "prepared" as const,
        confirmationMessageIds: [],
      };
    });
  }

  private async confirmBindingTransaction(
    transactionId: string,
  ): Promise<BindingTransactionResult> {
    this.assertOutboundEnabled();
    const row = this.bindingTransaction(transactionId);
    if (!row) {
      throw new DiscordBridgeError("binding_not_found", "Binding transaction was not found");
    }
    const existing = toBindingTransaction(row);
    if (existing.confirmationMessageIds.length > 0) return existing;
    if (row.state !== "prepared" && row.state !== "confirmed") {
      throw new DiscordBridgeError(
        "binding_mismatch",
        "Binding transaction can no longer send a confirmation",
      );
    }
    const sent = await this.rest.createMessages({
      threadId: existing.binding.parentChannelId,
      operationId: `binding-confirmation:${transactionId}`,
      text: "Camel is connected. Mention @Camel in this channel to start a conversation thread.",
    });
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE binding_transactions
       SET state = 'confirmed', confirmation_message_ids_json = ?, updated_at = ?
       WHERE transaction_id = ? AND state IN ('prepared', 'confirmed')`,
      JSON.stringify(sent.messageIds),
      now,
      transactionId,
    );
    return toBindingTransaction(this.bindingTransaction(transactionId)!);
  }

  private commitBindingTransaction(transactionId: string): BindingTransactionResult {
    const row = this.bindingTransaction(transactionId);
    if (!row) {
      throw new DiscordBridgeError("binding_not_found", "Binding transaction was not found");
    }
    if (row.state === "committed" || row.state === "finalized") {
      return toBindingTransaction(row);
    }
    if (row.state !== "confirmed") {
      throw new DiscordBridgeError(
        "binding_mismatch",
        "Binding transaction must be confirmed before commit",
      );
    }
    const transaction = toBindingTransaction(row);
    this.ctx.storage.transactionSync(() => {
      const current = this.activeBindingByIntegration(transaction.binding.integrationId);
      const previous = transaction.previousBinding;
      const sameSnapshot = previous &&
        previous.guildId === transaction.binding.guildId &&
        previous.parentChannelId === transaction.binding.parentChannelId &&
        previous.version === transaction.binding.version;
      if (sameSnapshot) {
        if (!current || current.version !== previous.version) {
          throw new DiscordBridgeError(
            "binding_mismatch",
            "Discord binding changed before transaction commit",
          );
        }
      } else {
        if (
          previous
            ? !current || current.version !== previous.version
            : current !== null
        ) {
          throw new DiscordBridgeError(
            "binding_mismatch",
            "Discord binding changed before transaction commit",
          );
        }
        const conflict = this.activeBindingForChannel(
          transaction.binding.guildId,
          transaction.binding.parentChannelId,
        );
        if (conflict && conflict.integration_id !== transaction.binding.integrationId) {
          throw new DiscordBridgeError(
            "binding_conflict",
            "The selected Discord channel is already connected",
          );
        }
        if (current) {
          this.ctx.storage.sql.exec(
            "DELETE FROM channel_bindings WHERE integration_id = ? AND version = ?",
            current.integration_id,
            current.version,
          );
        }
        this.insertExactBinding(transaction.binding, Date.now());
      }
      this.ctx.storage.sql.exec(
        "UPDATE binding_transactions SET state = 'committed', updated_at = ? WHERE transaction_id = ?",
        Date.now(),
        transactionId,
      );
    });
    const committed = toBindingTransaction(this.bindingTransaction(transactionId)!);
    recordDiscordBridgeEvent(this.env, {
      event: "discord.binding.transaction_committed",
      component: "discord_control",
      operation: "binding_transaction",
      status: "committed",
      orgId: committed.binding.orgId,
      workspaceId: committed.binding.workspaceId,
      integrationId: committed.binding.integrationId,
    });
    return committed;
  }

  private finalizeBindingTransaction(transactionId: string): BindingTransactionResult {
    const row = this.bindingTransaction(transactionId);
    if (!row) {
      throw new DiscordBridgeError("binding_not_found", "Binding transaction was not found");
    }
    if (row.state === "finalized") return toBindingTransaction(row);
    if (row.state !== "committed") {
      throw new DiscordBridgeError(
        "binding_mismatch",
        "Only a committed binding transaction can be finalized",
      );
    }
    const transaction = toBindingTransaction(row);
    this.ctx.storage.transactionSync(() => {
      if (
        transaction.previousBinding &&
        transaction.previousBinding.parentChannelId !== transaction.binding.parentChannelId
      ) {
        this.ctx.storage.sql.exec(
          "DELETE FROM thread_bindings WHERE integration_id = ? AND parent_channel_id != ?",
          transaction.binding.integrationId,
          transaction.binding.parentChannelId,
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE binding_transactions SET state = 'finalized', updated_at = ? WHERE transaction_id = ?",
        Date.now(),
        transactionId,
      );
    });
    return toBindingTransaction(this.bindingTransaction(transactionId)!);
  }

  private abortBindingTransaction(transactionId: string): BindingTransactionResult {
    const row = this.bindingTransaction(transactionId);
    if (!row) {
      throw new DiscordBridgeError("binding_not_found", "Binding transaction was not found");
    }
    if (row.state === "aborted") return toBindingTransaction(row);
    if (row.state === "finalized") {
      throw new DiscordBridgeError(
        "binding_mismatch",
        "A finalized binding transaction cannot be aborted",
      );
    }
    const transaction = toBindingTransaction(row);
    this.ctx.storage.transactionSync(() => {
      if (row.state === "committed") {
        const current = this.activeBindingByIntegration(transaction.binding.integrationId);
        if (
          !current ||
          current.version !== transaction.binding.version ||
          current.guild_id !== transaction.binding.guildId ||
          current.parent_channel_id !== transaction.binding.parentChannelId
        ) {
          throw new DiscordBridgeError(
            "binding_mismatch",
            "Discord binding changed before transaction abort",
          );
        }
        const sameSnapshot = transaction.previousBinding &&
          transaction.previousBinding.guildId === transaction.binding.guildId &&
          transaction.previousBinding.parentChannelId === transaction.binding.parentChannelId &&
          transaction.previousBinding.version === transaction.binding.version;
        if (!sameSnapshot) {
          this.ctx.storage.sql.exec(
            "DELETE FROM channel_bindings WHERE integration_id = ? AND version = ?",
            transaction.binding.integrationId,
            transaction.binding.version,
          );
          if (transaction.previousBinding) {
            this.insertExactBinding(transaction.previousBinding, Date.now());
          }
        }
      }
      this.ctx.storage.sql.exec(
        "UPDATE binding_transactions SET state = 'aborted', updated_at = ? WHERE transaction_id = ?",
        Date.now(),
        transactionId,
      );
    });
    const aborted = toBindingTransaction(this.bindingTransaction(transactionId)!);
    recordDiscordBridgeEvent(this.env, {
      event: "discord.binding.transaction_aborted",
      component: "discord_control",
      operation: "binding_transaction",
      status: "aborted",
      orgId: aborted.binding.orgId,
      workspaceId: aborted.binding.workspaceId,
      integrationId: aborted.binding.integrationId,
    });
    return aborted;
  }

  private releaseBinding(integrationId: string, version?: number): boolean {
    const existing = this.ctx.storage.sql.exec<ChannelBindingRow>(
      "SELECT * FROM channel_bindings WHERE integration_id = ?",
      integrationId,
    ).toArray()[0];
    if (!existing) return true;
    if (version !== undefined && existing.version !== version) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM thread_bindings WHERE integration_id = ?", integrationId);
      this.ctx.storage.sql.exec("DELETE FROM channel_bindings WHERE integration_id = ?", integrationId);
    });
    recordDiscordBridgeEvent(this.env, {
      event: "discord.binding.released",
      component: "discord_control",
      operation: "release",
      status: "released",
      orgId: existing.org_id,
      workspaceId: existing.workspace_id,
      integrationId,
    });
    return true;
  }

  private async verifyBinding(integrationId: string) {
    const binding = this.activeBindingByIntegration(integrationId);
    if (!binding) {
      recordDiscordBridgeEvent(this.env, {
        event: "discord.verification",
        component: "discord_control",
        operation: "verify_binding",
        status: "needs_authorization",
        integrationId,
      });
      return { status: "needs_authorization", message: "Select a Discord channel", binding: null };
    }
    try {
      const gateway = await this.env.GATEWAY.get(
        this.env.GATEWAY.idFromName("gateway:v1:0:1"),
      ).health();
      const readiness = evaluateDiscordBridgeReadiness(this.env, gateway);
      if (!readiness.ready) {
        recordDiscordBridgeEvent(this.env, {
          event: "discord.verification",
          component: "discord_control",
          operation: "verify_binding",
          status: readiness.reason,
          severity: "warn",
          orgId: binding.org_id,
          workspaceId: binding.workspace_id,
          integrationId,
        });
        return {
          status: "degraded" as const,
          message: readiness.message,
          binding: toBinding(binding),
          checkedAt: Date.now(),
          contentMode: discordContentMode(this.env),
          readiness,
          gateway,
        };
      }
      const inspected = await this.preflightBinding(binding.guild_id, binding.parent_channel_id);
      const status = discordContentMode(this.env) === "full" ? "ready" : "degraded";
      recordDiscordBridgeEvent(this.env, {
        event: "discord.verification",
        component: "discord_control",
        operation: "verify_binding",
        status,
        orgId: binding.org_id,
        workspaceId: binding.workspace_id,
        integrationId,
      });
      return {
        status,
        message: discordContentMode(this.env) === "full"
          ? "Discord channel is ready"
          : "Every Discord follow-up must mention @Camel until Message Content is enabled",
        binding: toBinding(binding),
        channel: inspected.channel,
        checkedAt: Date.now(),
        contentMode: discordContentMode(this.env),
        readiness,
        gateway,
      };
    } catch (error) {
      const code = error instanceof DiscordBridgeError ? error.code : "provider_unavailable";
      recordDiscordBridgeEvent(this.env, {
        event: "discord.verification",
        component: "discord_control",
        operation: "verify_binding",
        status: code,
        severity: "warn",
        orgId: binding.org_id,
        workspaceId: binding.workspace_id,
        integrationId,
      });
      return {
        status: code === "bot_removed" ? "needs_authorization" : "misconfigured",
        message: error instanceof Error ? error.message : "Discord verification failed",
        binding: toBinding(binding),
        checkedAt: Date.now(),
        contentMode: discordContentMode(this.env),
      };
    }
  }

  private registerThread(args: {
    threadId: string;
    binding: ChannelBindingRow;
    starter: boolean;
  }): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO thread_bindings (
        thread_id, guild_id, parent_channel_id, integration_id, org_id,
        workspace_id, next_ingress_ordinal, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      args.threadId,
      args.binding.guild_id,
      args.binding.parent_channel_id,
      args.binding.integration_id,
      args.binding.org_id,
      args.binding.workspace_id,
      args.starter ? 2 : 1,
      now,
      now,
    );
  }

  private async startThreadFromMessage(input: Record<string, unknown>) {
    this.assertOutboundEnabled();
    const integrationId = requireString(input.integrationId, "integrationId");
    const parentChannelId = requireString(input.parentChannelId, "parentChannelId");
    const messageId = requireString(input.messageId, "messageId");
    const operationId = requireString(input.idempotencyKey, "idempotencyKey");
    const cached = this.operationResult<{ threadId: string; integrationId: string }>(operationId, "thread_from_message");
    if (cached) return cached;
    const binding = this.activeBindingByIntegration(integrationId);
    if (!binding || binding.parent_channel_id !== parentChannelId) {
      throw new DiscordBridgeError("binding_mismatch", "Discord channel binding no longer matches");
    }
    const thread = await this.rest.startThreadFromMessage({
      parentChannelId,
      messageId,
      name: normalizeDiscordThreadName(optionalString(input.name) || "Camel request"),
    });
    this.registerThread({ threadId: thread.id, binding, starter: true });
    const result = { threadId: thread.id, integrationId, parentChannelId };
    this.storeOperation(operationId, "thread_from_message", result);
    return result;
  }

  private startProactiveThread(input: Record<string, unknown>): Promise<ProactiveThreadResult> {
    const integrationId = requireString(input.integrationId, "integrationId");
    const operationId = requireString(input.idempotencyKey, "idempotencyKey");
    const name = normalizeDiscordThreadName(optionalString(input.name) || "Camel update");
    const starterText = optionalString(input.starterText) ||
      "Camel started a conversation.";
    const intent = this.ctx.storage.sql.exec<ProactiveThreadIntentRow>(
      "SELECT * FROM proactive_thread_intents WHERE operation_id = ?",
      operationId,
    ).toArray()[0] ?? null;
    if (intent && (intent.integration_id !== integrationId || intent.thread_name !== name)) {
      throw new DiscordBridgeError(
        "invalid_request",
        "Idempotency key was already used for a different proactive Discord thread",
      );
    }
    const inFlight = this.proactiveThreadInFlight.get(operationId);
    if (inFlight) {
      if (
        inFlight.integrationId !== integrationId ||
        inFlight.name !== name ||
        inFlight.starterText !== starterText
      ) {
        throw new DiscordBridgeError(
          "invalid_request",
          "Idempotency key is already creating a different proactive Discord thread",
        );
      }
      return inFlight.promise;
    }
    const promise = this.startProactiveThreadOperation(
      integrationId,
      operationId,
      name,
      starterText,
    );
    this.proactiveThreadInFlight.set(
      operationId,
      { integrationId, name, starterText, promise },
    );
    const cleanup = () => {
      if (this.proactiveThreadInFlight.get(operationId)?.promise === promise) {
        this.proactiveThreadInFlight.delete(operationId);
      }
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  private async startProactiveThreadOperation(
    integrationId: string,
    operationId: string,
    name: string,
    starterText: string,
  ): Promise<ProactiveThreadResult> {
    this.assertOutboundEnabled();
    const cached = this.operationResult<ProactiveThreadResult>(operationId, "thread_proactive");
    if (cached) return cached;
    const binding = this.activeBindingByIntegration(integrationId);
    if (!binding) {
      throw new DiscordBridgeError("binding_not_found", "Discord integration is not connected");
    }
    let intent = this.ctx.storage.sql.exec<ProactiveThreadIntentRow>(
      "SELECT * FROM proactive_thread_intents WHERE operation_id = ?",
      operationId,
    ).toArray()[0] ?? null;
    if (
      intent &&
      (intent.integration_id !== integrationId ||
        intent.guild_id !== binding.guild_id ||
        intent.parent_channel_id !== binding.parent_channel_id ||
        intent.thread_name !== name)
    ) {
      throw new DiscordBridgeError(
        "invalid_request",
        "Idempotency key was already used for a different proactive Discord thread",
      );
    }
    if (!intent) {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO proactive_thread_intents (
          operation_id, integration_id, guild_id, parent_channel_id,
          thread_name, starter_message_id, thread_id, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        operationId,
        integrationId,
        binding.guild_id,
        binding.parent_channel_id,
        name,
        now,
        now,
      );
      intent = this.ctx.storage.sql.exec<ProactiveThreadIntentRow>(
        "SELECT * FROM proactive_thread_intents WHERE operation_id = ?",
        operationId,
      ).toArray()[0]!;
    }

    let thread: { id: string; name?: string; parent_id?: string } | null = intent.thread_id
      ? { id: intent.thread_id, name, parent_id: binding.parent_channel_id }
      : null;
    let starterMessageId = intent.starter_message_id;
    if (!thread) {
      if (!starterMessageId) {
        const starter = await this.rest.createMessages({
          threadId: binding.parent_channel_id,
          operationId: `proactive-starter:${operationId}`,
          text: starterText,
        });
        starterMessageId = starter.messageIds[0];
        if (!starterMessageId) {
          throw new DiscordBridgeError(
            "provider_unavailable",
            "Discord did not return the proactive starter message",
          );
        }
        this.ctx.storage.sql.exec(
          `UPDATE proactive_thread_intents
           SET starter_message_id = ?, updated_at = ? WHERE operation_id = ?`,
          starterMessageId,
          Date.now(),
          operationId,
        );
      }
      thread = await this.rest.startThreadFromMessage({
        parentChannelId: binding.parent_channel_id,
        messageId: starterMessageId,
        name,
      });
    }
    this.ctx.storage.sql.exec(
      "UPDATE proactive_thread_intents SET thread_id = ?, updated_at = ? WHERE operation_id = ?",
      thread.id,
      Date.now(),
      operationId,
    );
    this.registerThread({ threadId: thread.id, binding, starter: false });
    const result = {
      threadId: thread.id,
      integrationId,
      guildId: binding.guild_id,
      parentChannelId: binding.parent_channel_id,
      starterMessageId: starterMessageId!,
    };
    this.storeOperation(operationId, "thread_proactive", result);
    return result;
  }

  private async sendMessage(input: {
    integrationId: string;
    threadId: string;
    operationId: string;
    text?: string;
    attachments: Array<{ filename: string; contentType: string; content: Blob }>;
  }) {
    this.assertOutboundEnabled();
    const cached = this.operationResult<{
      threadId: string;
      integrationId: string;
      messageIds: string[];
      chunkCount: number;
      attachmentCount: number;
    }>(input.operationId, "message_send");
    if (cached) return cached;
    const thread = this.threadBinding(input.threadId);
    if (!thread || thread.integration_id !== input.integrationId) {
      throw new DiscordBridgeError("binding_mismatch", "Discord thread does not belong to this integration");
    }
    const binding = this.activeBindingByIntegration(input.integrationId);
    if (!binding || binding.parent_channel_id !== thread.parent_channel_id) {
      throw new DiscordBridgeError("binding_mismatch", "Discord integration is no longer active");
    }
    if (!input.text && input.attachments.length === 0) {
      throw new DiscordBridgeError("invalid_request", "text or attachments are required");
    }
    const outbound = discordOutboundTextWithNotice(
      input.text,
      discordContentMode(this.env),
      thread.mention_notice_sent === 1,
    );
    const sent = await this.rest.createMessages({
      threadId: input.threadId,
      operationId: input.operationId,
      text: outbound.text,
      attachments: input.attachments,
    });
    if (outbound.includedNotice) {
      this.ctx.storage.sql.exec(
        "UPDATE thread_bindings SET mention_notice_sent = 1, last_seen_at = ? WHERE thread_id = ?",
        Date.now(),
        input.threadId,
      );
    }
    const result = {
      threadId: input.threadId,
      integrationId: input.integrationId,
      messageIds: sent.messageIds,
      chunkCount: sent.chunkCount,
      attachmentCount: input.attachments.length,
    };
    this.storeOperation(input.operationId, "message_send", result);
    return result;
  }

  private async sendBindingConfirmation(integrationId: string, operationId: string) {
    this.assertOutboundEnabled();
    const cached = this.operationResult<{
      integrationId: string;
      messageIds: string[];
      chunkCount: number;
    }>(operationId, "binding_confirmation");
    if (cached) return cached;
    const binding = this.activeBindingByIntegration(integrationId);
    if (!binding) {
      throw new DiscordBridgeError("binding_not_found", "Discord integration is not connected");
    }
    const sent = await this.rest.createMessages({
      threadId: binding.parent_channel_id,
      operationId,
      text: "Camel is connected. Mention @Camel in this channel to start a conversation thread.",
    });
    const result = {
      integrationId,
      messageIds: sent.messageIds,
      chunkCount: sent.chunkCount,
    };
    this.storeOperation(operationId, "binding_confirmation", result);
    return result;
  }

  private async sendStarterFailureNotice(input: Record<string, unknown>) {
    this.assertOutboundEnabled();
    const integrationId = requireString(input.integrationId, "integrationId");
    const parentChannelId = requireString(input.parentChannelId, "parentChannelId");
    const messageId = requireString(input.messageId, "messageId");
    const operationId = requireString(input.idempotencyKey, "idempotencyKey");
    const reason = requireString(input.reason, "reason");
    const cached = this.operationResult<{
      integrationId: string;
      messageId: string;
      noticeMessageId: string;
      suppressed?: boolean;
    }>(operationId, "starter_failure_notice");
    if (cached) return cached;
    const binding = this.activeBindingByIntegration(integrationId);
    if (!binding || binding.parent_channel_id !== parentChannelId) {
      throw new DiscordBridgeError("binding_mismatch", "Discord channel binding no longer matches");
    }
    const rateLimitKey = `failure_notice:${parentChannelId}`;
    const lastNoticeAt = Number(this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM control_metadata WHERE key = ?",
      rateLimitKey,
    ).toArray()[0]?.value ?? 0);
    if (Date.now() - lastNoticeAt < 60_000) {
      const suppressed = {
        integrationId,
        messageId,
        noticeMessageId: "",
        suppressed: true,
      };
      this.storeOperation(operationId, "starter_failure_notice", suppressed);
      return suppressed;
    }
    const text = reason === "active_thread_limit"
      ? "Camel couldn't start a thread because this channel has too many active threads. Archive an older thread and try again."
      : reason === "missing_permissions"
        ? "Camel couldn't start a thread. Grant Camel Create Public Threads, Send Messages in Threads, View Channel, Send Messages, and Read Message History, then try again."
        : "Camel couldn't start a thread in this channel. Verify Camel's channel permissions and try again.";
    const sent = await this.rest.createStarterFailureNotice({
      parentChannelId,
      messageId,
      operationId,
      text,
    });
    const result = {
      integrationId,
      messageId,
      noticeMessageId: sent.id,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO control_metadata (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      rateLimitKey,
      String(Date.now()),
      Date.now(),
    );
    this.storeOperation(operationId, "starter_failure_notice", result);
    return result;
  }

  private writeOutboxEvent(args: {
    discordMessageId: string;
    conversationKey: string;
    ordinal: number;
    bindingVersion: number;
    payload: DiscordDeliveryPayload;
  }): string {
    const eventId = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO conversation_state (conversation_key, completed_ordinal, updated_at)
       VALUES (?, 0, ?)`,
      args.conversationKey,
      now,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO ingress_outbox (
        event_id, discord_message_id, conversation_key, ordinal, binding_version,
        payload_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      eventId,
      args.discordMessageId,
      args.conversationKey,
      args.ordinal,
      args.bindingVersion,
      JSON.stringify(args.payload),
      now,
      now,
    );
    return eventId;
  }

  private insertOutboxEvent(args: {
    discordMessageId: string;
    conversationKey: string;
    ordinal: number;
    bindingVersion: number;
    payload: DiscordDeliveryPayload;
  }): string | null {
    return this.ctx.storage.transactionSync(() => {
      const duplicate = this.ctx.storage.sql.exec<{ event_id: string }>(
        "SELECT event_id FROM ingress_outbox WHERE discord_message_id = ?",
        args.discordMessageId,
      ).toArray()[0];
      return duplicate ? null : this.writeOutboxEvent(args);
    });
  }

  private insertThreadMessageOutboxEvent(args: {
    threadId: string;
    conversationKey: string;
    bindingVersion: number;
    payload: Omit<DiscordReducedMessageEvent, "ordinal">;
  }): string | null {
    return this.ctx.storage.transactionSync(() => {
      // Dedupe before consuming an ordinal. Otherwise a Gateway Resume replay
      // creates a permanent hole that blocks every later delivery.
      const duplicate = this.ctx.storage.sql.exec<{ event_id: string }>(
        "SELECT event_id FROM ingress_outbox WHERE discord_message_id = ?",
        args.payload.discordMessageId,
      ).toArray()[0];
      if (duplicate) return null;
      const thread = this.threadBinding(args.threadId);
      if (!thread) return null;
      const ordinal = thread.next_ingress_ordinal;
      this.ctx.storage.sql.exec(
        "UPDATE thread_bindings SET next_ingress_ordinal = next_ingress_ordinal + 1, last_seen_at = ? WHERE thread_id = ?",
        Date.now(),
        args.threadId,
      );
      return this.writeOutboxEvent({
        discordMessageId: args.payload.discordMessageId,
        conversationKey: args.conversationKey,
        ordinal,
        bindingVersion: args.bindingVersion,
        payload: { ...args.payload, ordinal },
      });
    });
  }

  private async publishEvent(eventId: string): Promise<void> {
    try {
      await this.env.DISCORD_EVENTS_QUEUE.send({ version: 1, eventId });
      this.ctx.storage.sql.exec(
        `UPDATE ingress_outbox SET state = 'enqueued', enqueue_attempts = enqueue_attempts + 1,
         updated_at = ? WHERE event_id = ? AND state = 'pending'`,
        Date.now(),
        eventId,
      );
      recordDiscordBridgeEvent(this.env, {
        event: "discord.ingress.outbox_enqueued",
        component: "discord_control",
        operation: "queue_publish",
        status: "enqueued",
      });
    } catch (error) {
      this.ctx.storage.sql.exec(
        "UPDATE ingress_outbox SET enqueue_attempts = enqueue_attempts + 1, updated_at = ? WHERE event_id = ?",
        Date.now(),
        eventId,
      );
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      recordDiscordBridgeEvent(this.env, {
        event: "discord.ingress.retried",
        component: "discord_control",
        operation: "queue_publish",
        status: "pending",
        severity: "warn",
      });
      throw error;
    }
  }

  private async handleMessageCreate(payload: DiscordMessageCreatePayload): Promise<void> {
    const filtered = (
      status: string,
      binding?: Pick<ChannelBindingRow, "org_id" | "workspace_id" | "integration_id"> | null,
    ) => recordDiscordBridgeEvent(this.env, {
      event: "discord.ingress.filtered",
      component: "discord_control",
      operation: "message_create",
      status,
      count: 1,
      orgId: binding?.org_id,
      workspaceId: binding?.workspace_id,
      integrationId: binding?.integration_id,
    });
    if (!envFlag(this.env.DISCORD_INGRESS_ENABLED, false)) {
      filtered("ingress_disabled");
      return;
    }
    const messageId = optionalString(payload.id);
    const guildId = optionalString(payload.guild_id);
    const channelId = optionalString(payload.channel_id);
    const authorId = optionalString(payload.author?.id);
    if (!messageId || !guildId || !channelId || !authorId) {
      filtered("invalid_identifiers");
      return;
    }
    if (payload.author?.bot || payload.webhook_id) {
      filtered("automated_author");
      return;
    }
    if (payload.type !== 0 && payload.type !== 19) {
      filtered("unsupported_message_type");
      return;
    }
    const botUserId = await this.botUserId();
    if (authorId === botUserId) {
      filtered("bot_self_message");
      return;
    }
    const mentionsBotUser = (payload.mentions || []).some(
      (mention) => mention.id === botUserId,
    );
    const mentionedRoleIds = (payload.mention_roles || []).filter(
      (roleId): roleId is string => typeof roleId === "string" && roleId.length > 0,
    );
    const managedBotRoleIds = mentionedRoleIds.length > 0
      ? await this.managedBotRoleIds(guildId, botUserId)
      : [];
    const mentionedManagedBotRoleIds = managedBotRoleIds.filter(
      (roleId) => mentionedRoleIds.includes(roleId),
    );
    const mentionsBot = mentionsBotUser || mentionedManagedBotRoleIds.length > 0;
    const contentMode = discordContentMode(this.env);
    const content = typeof payload.content === "string" ? payload.content : "";
    const attachments = (payload.attachments || []).flatMap((attachment) => {
      const id = optionalString(attachment.id);
      const filename = optionalString(attachment.filename);
      const url = optionalString(attachment.url);
      const size = Number(attachment.size);
      return id && filename && url && Number.isFinite(size) && size >= 0
        ? [{
            id,
            filename,
            contentType: optionalString(attachment.content_type) || null,
            size,
            url,
          }]
        : [];
    });
    const contentWithoutBotMention = content
      .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
      .replace(
        new RegExp(
          `<@&(?:${mentionedManagedBotRoleIds.join("|") || "(?!)"})>`,
          "g",
        ),
        "",
      )
      .trim();
    if (!contentWithoutBotMention && attachments.length === 0) {
      filtered("empty_message");
      return;
    }

    let binding = this.activeBindingForChannel(guildId, channelId);
    let thread: ThreadBindingRow | null = null;
    let starter = true;
    if (binding) {
      if (!mentionsBot) {
        filtered("parent_without_mention", binding);
        return;
      }
    } else {
      thread = this.threadBinding(channelId);
      if (!thread || thread.guild_id !== guildId) {
        filtered("unbound_channel");
        return;
      }
      binding = this.activeBindingByIntegration(thread.integration_id);
      if (!binding || binding.parent_channel_id !== thread.parent_channel_id) {
        filtered("stale_thread_binding", binding);
        return;
      }
      if (contentMode === "mention_only" && !mentionsBot) {
        filtered("thread_without_mention", binding);
        return;
      }
      starter = false;
    }

    const conversationKey = `${guildId}:${starter ? messageId : channelId}`;
    const reduced: Omit<DiscordReducedMessageEvent, "ordinal"> = {
      kind: "message",
      discordMessageId: messageId,
      guildId,
      channelId,
      parentChannelId: binding.parent_channel_id,
      threadId: starter ? null : channelId,
      integrationId: binding.integration_id,
      orgId: binding.org_id,
      workspaceId: binding.workspace_id,
      bindingVersion: binding.version,
      content: contentWithoutBotMention,
      messageType: payload.type,
      author: {
        id: authorId,
        username: optionalString(payload.author?.username) || null,
        globalName: optionalString(payload.author?.global_name) || null,
        guildNickname: optionalString(payload.member?.nick) || null,
      },
      mentions: (payload.mentions || []).flatMap((mention) => {
        const id = optionalString(mention.id);
        return id ? [{
          id,
          username: optionalString(mention.username) || null,
          globalName: optionalString(mention.global_name) || null,
        }] : [];
      }),
      attachments,
      timestamp: optionalString(payload.timestamp) || null,
      contentMode,
      starter,
    };
    const eventId = starter
      ? this.insertOutboxEvent({
          discordMessageId: messageId,
          conversationKey,
          ordinal: 1,
          bindingVersion: binding.version,
          payload: { ...reduced, ordinal: 1 },
        })
      : this.insertThreadMessageOutboxEvent({
          threadId: channelId,
          conversationKey,
          bindingVersion: binding.version,
          payload: reduced,
        });
    if (!eventId && !starter && !this.threadBinding(channelId)) {
      filtered("thread_disappeared", binding);
    }
    if (eventId) await this.publishEvent(eventId);
  }

  private async enqueueLifecycleEvent(
    binding: ChannelBindingRow,
    lifecycleType: DiscordReducedLifecycleEvent["lifecycleType"],
    providerEventId: string,
  ): Promise<void> {
    recordDiscordBridgeEvent(this.env, {
      event: "discord.binding.invalidated",
      component: "discord_control",
      operation: lifecycleType,
      status: "queued",
      orgId: binding.org_id,
      workspaceId: binding.workspace_id,
      integrationId: binding.integration_id,
    });
    const payload: DiscordReducedLifecycleEvent = {
      kind: "lifecycle",
      lifecycleType,
      guildId: binding.guild_id,
      parentChannelId: lifecycleType === "parent_channel_deleted" ? binding.parent_channel_id : null,
      integrationId: binding.integration_id,
      orgId: binding.org_id,
      workspaceId: binding.workspace_id,
      bindingVersion: binding.version,
    };
    const eventId = this.insertOutboxEvent({
      discordMessageId: providerEventId,
      conversationKey: `lifecycle:${binding.integration_id}:${binding.version}`,
      ordinal: 1,
      bindingVersion: binding.version,
      payload,
    });
    if (eventId) await this.publishEvent(eventId);
  }

  async handleGatewayDispatch(event: DiscordGatewayEnvelope): Promise<void> {
    switch (event.t) {
      case "MESSAGE_CREATE":
        await this.handleMessageCreate(event.d as DiscordMessageCreatePayload);
        return;
      case "GUILD_CREATE": {
        const guildId = optionalString((event.d as { id?: string }).id);
        if (guildId) {
          this.ctx.storage.sql.exec(
            `INSERT INTO guild_presence (guild_id, last_seen_at) VALUES (?, ?)
             ON CONFLICT(guild_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
            guildId,
            Date.now(),
          );
        }
        return;
      }
      case "GUILD_DELETE": {
        const payload = event.d as DiscordGuildDeletePayload;
        const guildId = optionalString(payload.id);
        if (!guildId || payload.unavailable === true) return;
        this.ctx.storage.sql.exec("DELETE FROM guild_presence WHERE guild_id = ?", guildId);
        const bindings = this.ctx.storage.sql.exec<ChannelBindingRow>(
          "SELECT * FROM channel_bindings WHERE guild_id = ? AND status = 'active'",
          guildId,
        ).toArray();
        for (const binding of bindings) {
          await this.enqueueLifecycleEvent(
            binding,
            "guild_removed",
            `guild-delete:${guildId}:${binding.integration_id}:${binding.version}`,
          );
        }
        return;
      }
      case "CHANNEL_DELETE": {
        const payload = event.d as { id?: string; guild_id?: string };
        const guildId = optionalString(payload.guild_id);
        const channelId = optionalString(payload.id);
        if (!guildId || !channelId) return;
        const binding = this.activeBindingForChannel(guildId, channelId);
        if (binding) {
          await this.enqueueLifecycleEvent(
            binding,
            "parent_channel_deleted",
            `channel-delete:${guildId}:${channelId}:${binding.version}`,
          );
        }
        return;
      }
      case "THREAD_DELETE": {
        const payload = event.d as { id?: string };
        const threadId = optionalString(payload.id);
        if (threadId) {
          this.ctx.storage.sql.exec("DELETE FROM thread_bindings WHERE thread_id = ?", threadId);
        }
        return;
      }
      default:
        return;
    }
  }

  private claimDelivery(eventId: string) {
    const result = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<OutboxRow>(
        "SELECT * FROM ingress_outbox WHERE event_id = ?",
        eventId,
      ).toArray()[0];
      if (!row) return { status: "invalid" as const };
      if (row.state === "completed" || row.state === "failed") {
        return { status: "completed" as const };
      }
      const completed = this.ctx.storage.sql.exec<{ completed_ordinal: number }>(
        "SELECT completed_ordinal FROM conversation_state WHERE conversation_key = ?",
        row.conversation_key,
      ).toArray()[0]?.completed_ordinal ?? 0;
      if (row.ordinal !== completed + 1) {
        return { status: "wait" as const, retryAfterMs: 2_000 };
      }
      const now = Date.now();
      if (row.state === "leased" && (row.lease_expires_at ?? 0) > now) {
        return { status: "wait" as const, retryAfterMs: Math.min(5_000, (row.lease_expires_at ?? now) - now) };
      }
      if (!row.payload_json) return { status: "invalid" as const };
      const leaseToken = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `UPDATE ingress_outbox SET state = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE event_id = ?`,
        leaseToken,
        now + DELIVERY_LEASE_MS,
        now,
        eventId,
      );
      return {
        status: "claimed" as const,
        leaseToken,
        payload: JSON.parse(row.payload_json) as DiscordDeliveryPayload,
      };
    });
    recordDiscordBridgeEvent(this.env, {
      event: "discord.ingress.claimed",
      component: "discord_control",
      operation: "delivery_claim",
      status: result.status,
      severity: result.status === "wait" ? "debug" : "info",
    });
    return result;
  }

  private finishDelivery(eventId: string, leaseToken: string, failed: boolean): boolean {
    let shouldPublishNext = false;
    const finished = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<OutboxRow>(
        "SELECT * FROM ingress_outbox WHERE event_id = ?",
        eventId,
      ).toArray()[0];
      if (!row) return true;
      if (row.state === "completed" || row.state === "failed") return true;
      if (row.lease_token !== leaseToken) return false;
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE conversation_state SET completed_ordinal = MAX(completed_ordinal, ?), updated_at = ?
         WHERE conversation_key = ?`,
        row.ordinal,
        now,
        row.conversation_key,
      );
      this.ctx.storage.sql.exec(
        `UPDATE ingress_outbox SET state = ?, payload_json = NULL, lease_token = NULL,
         lease_expires_at = NULL, updated_at = ? WHERE event_id = ?`,
        failed ? "failed" : "completed",
        now,
        eventId,
      );
      const next = this.ctx.storage.sql.exec<OutboxRow>(
        `SELECT * FROM ingress_outbox
         WHERE conversation_key = ? AND ordinal = ? AND state = 'enqueued'`,
        row.conversation_key,
        row.ordinal + 1,
      ).toArray()[0];
      if (next) {
        this.ctx.storage.sql.exec(
          "UPDATE ingress_outbox SET state = 'pending', updated_at = ? WHERE event_id = ?",
          now,
          next.event_id,
        );
        shouldPublishNext = true;
      }
      return true;
    });
    if (shouldPublishNext) {
      this.ctx.storage.setAlarm(Date.now() + 1).catch(() => undefined);
    }
    if (finished) {
      recordDiscordBridgeEvent(this.env, {
        event: failed ? "discord.ingress.failed" : "discord.ingress.accepted",
        component: "discord_control",
        operation: failed ? "delivery_fail" : "delivery_complete",
        status: failed ? "failed" : "completed",
        severity: failed ? "error" : "info",
      });
    }
    return finished;
  }

  private retryDelivery(eventId: string, leaseToken: string): boolean {
    const row = this.ctx.storage.sql.exec<OutboxRow>(
      "SELECT * FROM ingress_outbox WHERE event_id = ?",
      eventId,
    ).toArray()[0];
    if (!row || row.state === "completed" || row.state === "failed") return true;
    if (row.lease_token !== leaseToken) return false;
    this.ctx.storage.sql.exec(
      `UPDATE ingress_outbox SET state = 'enqueued', lease_token = NULL,
       lease_expires_at = NULL, updated_at = ? WHERE event_id = ?`,
      Date.now(),
      eventId,
    );
    recordDiscordBridgeEvent(this.env, {
      event: "discord.ingress.retried",
      component: "discord_control",
      operation: "delivery_retry",
      status: "enqueued",
      severity: "warn",
    });
    return true;
  }

  private async sendDeadLetterFailureNotice(notice: FailureNoticeRow): Promise<void> {
    this.assertOutboundEnabled();
    if (notice.state !== "pending") return;
    const binding = this.activeBindingByIntegration(notice.integration_id);
    if (!binding || binding.parent_channel_id !== notice.parent_channel_id) {
      this.ctx.storage.sql.exec(
        "UPDATE failure_notices SET state = 'suppressed', updated_at = ? WHERE event_id = ?",
        Date.now(),
        notice.event_id,
      );
      return;
    }
    const rateLimitKey = `failure_notice:${notice.target_channel_id}`;
    const lastNoticeAt = Number(this.ctx.storage.sql.exec<{ value: string }>(
      "SELECT value FROM control_metadata WHERE key = ?",
      rateLimitKey,
    ).toArray()[0]?.value ?? 0);
    if (Date.now() - lastNoticeAt < 60_000) {
      this.ctx.storage.sql.exec(
        "UPDATE failure_notices SET state = 'suppressed', updated_at = ? WHERE event_id = ?",
        Date.now(),
        notice.event_id,
      );
      return;
    }
    await this.rest.createStarterFailureNotice({
      parentChannelId: notice.target_channel_id,
      messageId: notice.discord_message_id,
      operationId: `discord-dlq-failure:${notice.event_id}`,
      text: "Camel couldn't process this message after several retries. Please try again.",
    });
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE failure_notices SET state = 'sent', updated_at = ? WHERE event_id = ?",
        now,
        notice.event_id,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO control_metadata (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        rateLimitKey,
        String(now),
        now,
      );
    });
  }

  private async failDeliveryFromDeadLetter(eventId: string) {
    let shouldPublishNext = false;
    const outcome = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<OutboxRow>(
        "SELECT * FROM ingress_outbox WHERE event_id = ?",
        eventId,
      ).toArray()[0];
      if (!row) return { status: "invalid" as const };
      const existingNotice = this.ctx.storage.sql.exec<FailureNoticeRow>(
        "SELECT * FROM failure_notices WHERE event_id = ?",
        eventId,
      ).toArray()[0] ?? null;
      if (row.state === "completed") {
        return { status: "completed" as const, notice: existingNotice };
      }
      if (row.state === "failed") {
        return { status: "failed" as const, notice: existingNotice };
      }
      const completed = this.ctx.storage.sql.exec<{ completed_ordinal: number }>(
        "SELECT completed_ordinal FROM conversation_state WHERE conversation_key = ?",
        row.conversation_key,
      ).toArray()[0]?.completed_ordinal ?? 0;
      if (row.ordinal !== completed + 1) {
        return { status: "wait" as const, retryAfterMs: 2_000 };
      }
      const now = Date.now();
      let notice = existingNotice;
      if (!notice && row.payload_json) {
        const payload = JSON.parse(row.payload_json) as DiscordDeliveryPayload;
        if (payload.kind === "message") {
          this.ctx.storage.sql.exec(
            `INSERT INTO failure_notices (
              event_id, integration_id, parent_channel_id, target_channel_id,
              discord_message_id, state, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
            eventId,
            payload.integrationId,
            payload.parentChannelId,
            payload.channelId,
            payload.discordMessageId,
            now,
            now,
          );
          notice = this.ctx.storage.sql.exec<FailureNoticeRow>(
            "SELECT * FROM failure_notices WHERE event_id = ?",
            eventId,
          ).toArray()[0] ?? null;
        }
      }
      this.ctx.storage.sql.exec(
        `UPDATE conversation_state SET completed_ordinal = MAX(completed_ordinal, ?), updated_at = ?
         WHERE conversation_key = ?`,
        row.ordinal,
        now,
        row.conversation_key,
      );
      this.ctx.storage.sql.exec(
        `UPDATE ingress_outbox SET state = 'failed', payload_json = NULL,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE event_id = ?`,
        now,
        eventId,
      );
      const next = this.ctx.storage.sql.exec<OutboxRow>(
        `SELECT * FROM ingress_outbox
         WHERE conversation_key = ? AND ordinal = ? AND state = 'enqueued'`,
        row.conversation_key,
        row.ordinal + 1,
      ).toArray()[0];
      if (next) {
        this.ctx.storage.sql.exec(
          "UPDATE ingress_outbox SET state = 'pending', updated_at = ? WHERE event_id = ?",
          now,
          next.event_id,
        );
        shouldPublishNext = true;
      }
      return { status: "failed" as const, notice };
    });
    if (shouldPublishNext) {
      await this.ctx.storage.setAlarm(Date.now() + 1);
    }
    if (outcome.status === "failed" && outcome.notice) {
      await this.sendDeadLetterFailureNotice(outcome.notice);
    }
    recordDiscordBridgeEvent(this.env, {
      event: "discord.ingress.failed",
      component: "discord_control",
      operation: "dead_letter",
      status: outcome.status,
      severity: outcome.status === "wait" ? "warn" : "error",
    });
    return outcome;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const pending = this.ctx.storage.sql.exec<{ event_id: string }>(
      "SELECT event_id FROM ingress_outbox WHERE state = 'pending' ORDER BY created_at LIMIT 50",
    ).toArray();
    for (const { event_id: eventId } of pending) {
      await this.publishEvent(eventId).catch(() => undefined);
    }
    const expired = this.ctx.storage.sql.exec<OutboxRow>(
      `SELECT * FROM ingress_outbox
       WHERE state IN ('pending', 'enqueued', 'leased') AND created_at < ? LIMIT 100`,
      now - OUTBOX_EXPIRY_MS,
    ).toArray();
    let expiredUnblockedConversation = false;
    for (const row of expired) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE conversation_state SET completed_ordinal = MAX(completed_ordinal, ?), updated_at = ?
           WHERE conversation_key = ?`,
          row.ordinal,
          now,
          row.conversation_key,
        );
        this.ctx.storage.sql.exec(
          `UPDATE ingress_outbox SET state = 'failed', payload_json = NULL,
           lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE event_id = ?`,
          now,
          row.event_id,
        );
        const next = this.ctx.storage.sql.exec<OutboxRow>(
          `SELECT * FROM ingress_outbox
           WHERE conversation_key = ? AND ordinal = ? AND state = 'enqueued'`,
          row.conversation_key,
          row.ordinal + 1,
        ).toArray()[0];
        if (next) {
          this.ctx.storage.sql.exec(
            "UPDATE ingress_outbox SET state = 'pending', updated_at = ? WHERE event_id = ?",
            now,
            next.event_id,
          );
          expiredUnblockedConversation = true;
        }
      });
    }
    if (expired.length > 0) {
      recordDiscordBridgeEvent(this.env, {
        event: "discord.ingress.failed",
        component: "discord_control",
        operation: "outbox_expiry",
        status: "expired",
        severity: "error",
        count: expired.length,
      });
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM ingress_outbox WHERE state IN ('completed', 'failed') AND updated_at < ?",
      now - OUTBOX_RETENTION_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM thread_bindings
       WHERE last_seen_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM ingress_outbox
           WHERE ingress_outbox.conversation_key =
             thread_bindings.guild_id || ':' || thread_bindings.thread_id
             AND ingress_outbox.state IN ('pending', 'enqueued', 'leased')
         )`,
      now - THREAD_RETENTION_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM failure_notices
       WHERE state IN ('sent', 'suppressed') AND updated_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM ingress_outbox
           WHERE ingress_outbox.event_id = failure_notices.event_id
             AND ingress_outbox.state IN ('pending', 'enqueued', 'leased')
         )`,
      now - OUTBOX_RETENTION_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM proactive_thread_intents
       WHERE thread_id IS NOT NULL AND updated_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM thread_bindings
           WHERE thread_bindings.thread_id = proactive_thread_intents.thread_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM internal_operations
           WHERE internal_operations.operation_id =
             proactive_thread_intents.operation_id
         )`,
      now - AUXILIARY_RETENTION_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM conversation_state
       WHERE updated_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM ingress_outbox
           WHERE ingress_outbox.conversation_key =
             conversation_state.conversation_key
             AND ingress_outbox.state IN ('pending', 'enqueued', 'leased')
         )
         AND NOT EXISTS (
           SELECT 1 FROM thread_bindings
           WHERE conversation_state.conversation_key =
             thread_bindings.guild_id || ':' || thread_bindings.thread_id
         )`,
      now - AUXILIARY_RETENTION_MS,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM binding_transactions
       WHERE state IN ('finalized', 'aborted') AND updated_at < ?`,
      now - AUXILIARY_RETENTION_MS,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM internal_operations WHERE created_at < ?",
      now - OUTBOX_RETENTION_MS,
    );
    if (expiredUnblockedConversation) {
      await this.ctx.storage.setAlarm(now + 1);
    } else if (pending.length > 0) {
      await this.ctx.storage.setAlarm(now + 5_000);
    }
  }

  async maintenance(): Promise<void> {
    await this.alarm();
  }

  private async parseMessageRequest(request: Request) {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const length = Number(request.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_OUTBOUND_BODY_BYTES) {
        throw new DiscordBridgeError("invalid_request", "Discord upload is too large");
      }
      const form = await request.formData();
      const rawPayload = form.get("payload");
      if (typeof rawPayload !== "string") {
        throw new DiscordBridgeError("invalid_request", "payload is required");
      }
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawPayload) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("payload must be an object");
        }
        input = parsed as Record<string, unknown>;
      } catch {
        throw new DiscordBridgeError("invalid_request", "payload must be valid JSON");
      }
      const attachments: Array<{ filename: string; contentType: string; content: Blob }> = [];
      let aggregateSize = 0;
      for (const entry of form.getAll("files")) {
        if (typeof entry === "string") continue;
        aggregateSize += entry.size;
        if (aggregateSize > 25 * 1024 * 1024) {
          throw new DiscordBridgeError("invalid_request", "Discord attachments exceed 25 MiB");
        }
        attachments.push({
          filename: entry.name.slice(0, 180) || "attachment",
          contentType: entry.type || "application/octet-stream",
          content: entry,
        });
      }
      return {
        integrationId: requireString(input.integrationId, "integrationId"),
        threadId: requireString(input.threadId, "threadId"),
        operationId: requireString(input.idempotencyKey, "idempotencyKey"),
        text: optionalString(input.text),
        attachments,
      };
    }
    const input = await readJsonObject(request);
    return {
      integrationId: requireString(input.integrationId, "integrationId"),
      threadId: requireString(input.threadId, "threadId"),
      operationId: requireString(input.idempotencyKey, "idempotencyKey"),
      text: optionalString(input.text),
      attachments: [],
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/internal/v1/status") {
        const outbox = this.ctx.storage.sql.exec<{
          pending_count: number;
          oldest_created_at: number | null;
        }>(
          `SELECT COUNT(*) AS pending_count, MIN(created_at) AS oldest_created_at
           FROM ingress_outbox WHERE state IN ('pending', 'enqueued', 'leased')`,
        ).toArray()[0];
        const installedGuildCount = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM guild_presence",
        ).toArray()[0]?.count ?? 0;
        const botUserId = this.ctx.storage.sql.exec<{ value: string }>(
          "SELECT value FROM control_metadata WHERE key = 'bot_user_id'",
        ).toArray()[0]?.value ?? null;
        return jsonResponse({
          ok: true,
          applicationId: this.env.DISCORD_APPLICATION_ID,
          botUserId,
          contentMode: discordContentMode(this.env),
          ingressEnabled: envFlag(this.env.DISCORD_INGRESS_ENABLED, false),
          outboundEnabled: envFlag(this.env.DISCORD_OUTBOUND_ENABLED, true),
          pendingDeliveries: outbox?.pending_count ?? 0,
          oldestDeliveryAt: outbox?.oldest_created_at ?? null,
          installedGuildCount,
        });
      }
      if (request.method === "GET" && path === "/internal/v1/gateway/bot") {
        return jsonResponse(await this.rest.getGatewayBot());
      }
      const guildChannels = path.match(/^\/internal\/v1\/guilds\/([^/]+)\/channels$/);
      if (request.method === "GET" && guildChannels) {
        return jsonResponse({ ok: true, ...(await this.inspectGuild(decodeURIComponent(guildChannels[1]))) });
      }
      if (request.method === "POST" && path === "/internal/v1/binding-transactions/prepare") {
        const input = await readJsonObject(request);
        const expectedVersionValue = input.expectedVersion;
        const expectedVersion = expectedVersionValue === undefined
          ? undefined
          : Number(expectedVersionValue);
        if (
          expectedVersion !== undefined &&
          (!Number.isInteger(expectedVersion) || expectedVersion < 1)
        ) {
          throw new DiscordBridgeError("invalid_request", "expectedVersion must be a positive integer");
        }
        const transaction = await this.prepareBindingTransaction({
          guildId: requireString(input.guildId, "guildId"),
          parentChannelId: requireString(input.parentChannelId, "parentChannelId"),
          integrationId: requireString(input.integrationId, "integrationId"),
          orgId: requireString(input.orgId, "orgId"),
          workspaceId: requireString(input.workspaceId, "workspaceId"),
          idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        });
        return jsonResponse({ ok: true, transaction });
      }
      const bindingTransactionRoute = path.match(
        /^\/internal\/v1\/binding-transactions\/([^/]+)\/(confirm|commit|finalize|abort)$/,
      );
      if (bindingTransactionRoute && request.method === "POST") {
        const transactionId = decodeURIComponent(bindingTransactionRoute[1]);
        const action = bindingTransactionRoute[2];
        const transaction = action === "confirm"
          ? await this.confirmBindingTransaction(transactionId)
          : action === "commit"
            ? this.commitBindingTransaction(transactionId)
            : action === "finalize"
              ? this.finalizeBindingTransaction(transactionId)
              : this.abortBindingTransaction(transactionId);
        return jsonResponse({ ok: true, transaction });
      }
      if (request.method === "POST" && path === "/internal/v1/bindings/claim") {
        const input = await readJsonObject(request);
        const binding = await this.claimBinding({
          guildId: requireString(input.guildId, "guildId"),
          parentChannelId: requireString(input.parentChannelId, "parentChannelId"),
          integrationId: requireString(input.integrationId, "integrationId"),
          orgId: requireString(input.orgId, "orgId"),
          workspaceId: requireString(input.workspaceId, "workspaceId"),
          idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
        });
        return jsonResponse({ ok: true, binding });
      }
      if (request.method === "POST" && path === "/internal/v1/bindings/replace") {
        const input = await readJsonObject(request);
        const expectedVersion = Number(input.expectedVersion);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
          throw new DiscordBridgeError("invalid_request", "expectedVersion is required");
        }
        const replacement = await this.replaceBinding({
          guildId: requireString(input.guildId, "guildId"),
          parentChannelId: requireString(input.parentChannelId, "parentChannelId"),
          integrationId: requireString(input.integrationId, "integrationId"),
          orgId: requireString(input.orgId, "orgId"),
          workspaceId: requireString(input.workspaceId, "workspaceId"),
          idempotencyKey: requireString(input.idempotencyKey, "idempotencyKey"),
          expectedVersion,
        });
        return jsonResponse({ ok: true, ...replacement });
      }
      const bindingRoute = path.match(/^\/internal\/v1\/bindings\/([^/]+)$/);
      if (bindingRoute && request.method === "GET") {
        const binding = this.activeBindingByIntegration(decodeURIComponent(bindingRoute[1]));
        return binding
          ? jsonResponse({ ok: true, binding: toBinding(binding) })
          : jsonResponse({ ok: false, error: "binding_not_found" }, 404);
      }
      if (bindingRoute && request.method === "DELETE") {
        const versionValue = url.searchParams.get("version");
        const released = this.releaseBinding(
          decodeURIComponent(bindingRoute[1]),
          versionValue ? Number(versionValue) : undefined,
        );
        return jsonResponse({ ok: released, released }, released ? 200 : 409);
      }
      const verifyRoute = path.match(/^\/internal\/v1\/bindings\/([^/]+)\/verify$/);
      if (verifyRoute && request.method === "POST") {
        return jsonResponse({ ok: true, verification: await this.verifyBinding(decodeURIComponent(verifyRoute[1])) });
      }
      const confirmationRoute = path.match(/^\/internal\/v1\/bindings\/([^/]+)\/confirmation$/);
      if (confirmationRoute && request.method === "POST") {
        const input = await readJsonObject(request);
        const integrationId = decodeURIComponent(confirmationRoute[1]);
        return jsonResponse({
          ok: true,
          ...(await this.sendBindingConfirmation(
            integrationId,
            requireString(input.idempotencyKey, "idempotencyKey"),
          )),
        });
      }
      if (request.method === "POST" && path === "/internal/v1/threads/from-message") {
        return jsonResponse({ ok: true, ...(await this.startThreadFromMessage(await readJsonObject(request))) });
      }
      if (request.method === "POST" && path === "/internal/v1/threads/proactive") {
        return jsonResponse({ ok: true, ...(await this.startProactiveThread(await readJsonObject(request))) });
      }
      if (request.method === "POST" && path === "/internal/v1/messages") {
        return jsonResponse({ ok: true, ...(await this.sendMessage(await this.parseMessageRequest(request))) });
      }
      if (request.method === "POST" && path === "/internal/v1/failure-notices") {
        return jsonResponse({
          ok: true,
          ...(await this.sendStarterFailureNotice(await readJsonObject(request))),
        });
      }
      const delivery = path.match(/^\/internal\/v1\/deliveries\/([^/]+)\/(claim|complete|retry|fail|dead-letter)$/);
      if (delivery && request.method === "POST") {
        const eventId = decodeURIComponent(delivery[1]);
        const action = delivery[2];
        if (action === "claim") return jsonResponse({ ok: true, ...this.claimDelivery(eventId) });
        if (action === "dead-letter") {
          return jsonResponse({ ok: true, ...(await this.failDeliveryFromDeadLetter(eventId)) });
        }
        const input = await readJsonObject(request);
        const leaseToken = requireString(input.leaseToken, "leaseToken");
        const success = action === "retry"
          ? this.retryDelivery(eventId, leaseToken)
          : this.finishDelivery(eventId, leaseToken, action === "fail");
        return jsonResponse({ ok: success }, success ? 200 : 409);
      }
      return jsonResponse({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      if (
        error instanceof DiscordBridgeError &&
        error.code === "binding_conflict"
      ) {
        recordDiscordBridgeEvent(this.env, {
          event: "discord.binding.conflict",
          component: "discord_control",
          operation: path.endsWith("/replace") ? "replace" : "claim",
          status: error.code,
          severity: "warn",
        });
      }
      return errorResponse(error);
    }
  }
}

export { isRetryableBridgeError };
