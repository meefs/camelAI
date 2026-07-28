import type {
  DiscordActivateBindingInput,
  DiscordActivateBindingResult,
  DiscordBridgeBinding,
  DiscordDeliveryClaim,
  DiscordBridgeStatus,
  DiscordChannelConfigV1,
  DiscordGuildChannels,
  DiscordMessageSendResult,
} from "../../../src/lib/discord-contract.js";

export {
  DISCORD_CHANNEL_PERMISSION_BITS,
  DISCORD_CHANNEL_PERMISSION_DECIMAL,
  DISCORD_CHANNEL_PERMISSION_MASK,
} from "../../../src/lib/discord-contract.js";
export type {
  DiscordBridgeDelivery,
  DiscordBridgeDeliveryLifecycle,
  DiscordBridgeDeliveryMessage,
  DiscordChannelConfigV1,
  DiscordEventQueueMessage,
  DiscordMessageContentMode,
  DiscordPendingReauthorization,
  DiscordPendingSetupContext,
  DiscordSelectableChannel,
  DiscordActivateBindingInput,
  DiscordActivateBindingResult,
  DiscordBridgeStatus,
  DiscordGuildChannels,
  DiscordDeliveryClaim,
  DiscordMessageSendResult,
} from "../../../src/lib/discord-contract.js";

export type DiscordBridgeBindingRecord = DiscordBridgeBinding;

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

export class DiscordBridgeClient {
  constructor(private readonly bridge: DiscordBridgeFetcher | undefined) {}

  status(): Promise<DiscordBridgeStatus> {
    return discordBridgeRequest(this.bridge, "/internal/v1/status");
  }

  guildChannels(guildId: string): Promise<DiscordGuildChannels> {
    return discordBridgeRequest(
      this.bridge,
      `/internal/v1/guilds/${encodeURIComponent(guildId)}/channels`,
    );
  }

  async binding(integrationId: string): Promise<DiscordBridgeBindingRecord | null> {
    try {
      const result = await discordBridgeRequest<{
        binding: DiscordBridgeBindingRecord;
      }>(
        this.bridge,
        `/internal/v1/bindings/${encodeURIComponent(integrationId)}`,
      );
      return result.binding;
    } catch (error) {
      if (error instanceof DiscordBridgeRequestError && error.code === "binding_not_found") {
        return null;
      }
      throw error;
    }
  }

  async activateBinding(
    input: DiscordActivateBindingInput,
  ): Promise<DiscordActivateBindingResult> {
    const result = await discordBridgeRequest<
      DiscordActivateBindingResult & { ok: true }
    >(this.bridge, "/internal/v1/bindings/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return result;
  }

  releaseBinding(integrationId: string, version?: number): Promise<{ released: boolean }> {
    const query = version === undefined ? "" : `?version=${version}`;
    return discordBridgeRequest(
      this.bridge,
      `/internal/v1/bindings/${encodeURIComponent(integrationId)}${query}`,
      { method: "DELETE" },
    );
  }

  async releaseCurrentBinding(integrationId: string): Promise<{ released: boolean }> {
    const current = await this.binding(integrationId);
    return current
      ? this.releaseBinding(integrationId, current.version)
      : { released: false };
  }

  async verifyBinding<TStatus extends string = string>(
    integrationId: string,
  ): Promise<{
    status: TStatus;
    message: string;
    checkedAt?: number;
    binding: DiscordBridgeBindingRecord | null;
  }> {
    const result = await discordBridgeRequest<{
      verification: {
        status: TStatus;
        message: string;
        checkedAt?: number;
        binding: DiscordBridgeBindingRecord | null;
      };
    }>(
      this.bridge,
      `/internal/v1/bindings/${encodeURIComponent(integrationId)}/verify`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    return result.verification;
  }

  private postJson<T>(path: string, body: unknown): Promise<T> {
    return discordBridgeRequest(this.bridge, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  claimDelivery(eventId: string): Promise<DiscordDeliveryClaim> {
    return this.postJson(
      `/internal/v1/deliveries/${encodeURIComponent(eventId)}/claim`,
      {},
    );
  }

  finishDelivery(
    eventId: string,
    leaseToken: string,
    action: "complete" | "retry" | "fail",
  ): Promise<unknown> {
    return this.postJson(
      `/internal/v1/deliveries/${encodeURIComponent(eventId)}/${action}`,
      { leaseToken },
    );
  }

  deadLetterDelivery(eventId: string): Promise<{
    status: "failed" | "completed" | "invalid" | "wait";
    retryAfterMs?: number;
  }> {
    return this.postJson(
      `/internal/v1/deliveries/${encodeURIComponent(eventId)}/dead-letter`,
      {},
    );
  }

  startThreadFromMessage(input: {
    integrationId: string;
    parentChannelId: string;
    messageId: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ threadId: string }> {
    return this.postJson("/internal/v1/threads/from-message", input);
  }

  startProactiveThread(input: {
    integrationId: string;
    name: string;
    starterText?: string;
    idempotencyKey: string;
  }): Promise<{ threadId: string; guildId: string; starterMessageId?: string }> {
    return this.postJson("/internal/v1/threads/proactive", input);
  }

  sendMessage(
    input: FormData | {
      integrationId: string;
      threadId: string;
      text: string;
      idempotencyKey: string;
    },
  ): Promise<DiscordMessageSendResult> {
    if (input instanceof FormData) {
      return discordBridgeRequest(this.bridge, "/internal/v1/messages", {
        method: "POST",
        body: input,
      });
    }
    return this.postJson("/internal/v1/messages", input);
  }

  sendFailureNotice(input: {
    integrationId: string;
    parentChannelId: string;
    messageId: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<unknown> {
    return this.postJson("/internal/v1/failure-notices", input);
  }
}

export function discordBridgeClient(
  bridge: DiscordBridgeFetcher | undefined,
): DiscordBridgeClient {
  return new DiscordBridgeClient(bridge);
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
    const status = await discordBridgeClient(env.DISCORD_BRIDGE).status();
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
    const pendingReauthorization = parsed.pending_reauthorization;
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
      (parsed.activation_attempt_id !== undefined &&
        (typeof parsed.activation_attempt_id !== "string" ||
          !parsed.activation_attempt_id.trim())) ||
      (pendingReauthorization !== undefined &&
        (!pendingReauthorization ||
          typeof pendingReauthorization !== "object" ||
          typeof pendingReauthorization.activation_attempt_id !== "string" ||
          !pendingReauthorization.activation_attempt_id.trim() ||
          typeof pendingReauthorization.application_id !== "string" ||
          !pendingReauthorization.application_id.trim() ||
          typeof pendingReauthorization.guild_id !== "string" ||
          !pendingReauthorization.guild_id.trim() ||
          typeof pendingReauthorization.guild_name !== "string" ||
          !pendingReauthorization.guild_name.trim() ||
          (pendingReauthorization.message_content_mode !== "full" &&
            pendingReauthorization.message_content_mode !== "mention_only"))) ||
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
