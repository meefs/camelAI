import {
  splitDiscordMessage,
  stableDiscordNonce,
} from "./gateway-protocol.js";
import {
  DiscordBridgeError,
  type DiscordAttachmentPayload,
  type DiscordChannelPayload,
  type DiscordGuildMemberPayload,
  type DiscordRolePayload,
} from "./types.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_REST_TIMEOUT_MS = 15_000;
const MAX_INLINE_RATE_LIMIT_WAIT_MS = 5_000;
const GLOBAL_REQUEST_LIMIT = 50;

interface DiscordBucketState {
  remaining: number;
  resetAt: number;
}

interface DiscordRequestOptions {
  method?: string;
  body?: BodyInit;
  headers?: HeadersInit;
  majorRoute: string;
  idempotent?: boolean;
}

interface DiscordApiErrorBody {
  code?: number;
  message?: string;
  retry_after?: number;
  global?: boolean;
}

export interface DiscordRestObservation {
  operation: string;
  status: "success" | "retry" | "failed";
  durationMs: number;
  statusCode?: number;
  rateLimitScope?: "global" | "route";
  retryAfterMs?: number;
  error?: unknown;
}

function observableOperation(majorRoute: string): string {
  return majorRoute
    .split(":")
    .map((part) => /^\d{5,}$/.test(part) ? "id" : part)
    .join(".");
}

function secondsHeaderToMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000 : null;
}

function classifyDiscordRestError(
  status: number,
  providerCode?: number,
): DiscordBridgeError["code"] {
  if (status === 400 && providerCode === 160_002) return "active_thread_limit";
  if (status === 401) return "fatal_auth";
  if (status === 403) return "missing_permissions";
  if (status === 404) return "unknown_channel";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "invalid_request";
}

function safeProviderMessage(status: number, providerCode?: number): string {
  if (status === 400 && providerCode === 160_002) {
    return "Discord channel has reached its active thread limit";
  }
  if (status === 401) return "Discord bot authorization failed";
  if (status === 403) return "Discord permissions are missing";
  if (status === 404) return "Discord resource was not found";
  if (status === 429) return "Discord rate limit exceeded";
  if (status >= 500) return "Discord is temporarily unavailable";
  return `Discord request failed (${status})`;
}

export class DiscordRestClient {
  private readonly buckets = new Map<string, DiscordBucketState>();
  private readonly routeBuckets = new Map<string, string>();
  private globalRequests: number[] = [];
  private globalResetAt = 0;
  private serial: Promise<void> = Promise.resolve();

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly observe?: (observation: DiscordRestObservation) => void,
  ) {}

  private record(observation: DiscordRestObservation): void {
    try {
      this.observe?.(observation);
    } catch {
      // Observability must never change provider delivery behavior.
    }
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async waitForCapacity(majorRoute: string): Promise<void> {
    let now = this.now();
    if (this.globalResetAt > now) {
      const delay = this.globalResetAt - now;
      if (delay > MAX_INLINE_RATE_LIMIT_WAIT_MS) {
        throw new DiscordBridgeError("rate_limited", "Discord global rate limit", delay);
      }
      await this.wait(delay);
      now = this.now();
    }
    this.globalRequests = this.globalRequests.filter((timestamp) => timestamp > now - 1_000);
    if (this.globalRequests.length >= GLOBAL_REQUEST_LIMIT) {
      const delay = this.globalRequests[0] + 1_000 - now;
      if (delay > MAX_INLINE_RATE_LIMIT_WAIT_MS) {
        throw new DiscordBridgeError("rate_limited", "Discord global rate limit", delay);
      }
      await this.wait(delay);
      now = this.now();
      this.globalRequests = this.globalRequests.filter(
        (timestamp) => timestamp > now - 1_000,
      );
    }

    const bucketId = this.routeBuckets.get(majorRoute);
    const bucket = bucketId ? this.buckets.get(bucketId) : undefined;
    if (bucket && bucket.remaining <= 0 && bucket.resetAt > this.now()) {
      const delay = bucket.resetAt - this.now();
      if (delay > MAX_INLINE_RATE_LIMIT_WAIT_MS) {
        throw new DiscordBridgeError("rate_limited", "Discord route rate limit", delay);
      }
      await this.wait(delay);
    }
  }

  private async request<T>(path: string, options: DiscordRequestOptions): Promise<T> {
    return this.runSerialized(async () => {
      let ambiguousRetryUsed = false;
      let rateLimitRetryUsed = false;
      while (true) {
        await this.waitForCapacity(options.majorRoute);
        const startedAt = this.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DISCORD_REST_TIMEOUT_MS);
        let response: Response;
        try {
          this.globalRequests.push(this.now());
          const fetchImpl = this.fetchImpl;
          response = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
            method: options.method || "GET",
            headers: {
              Authorization: `Bot ${this.token}`,
              ...options.headers,
            },
            body: options.body,
            signal: controller.signal,
          });
        } catch (error) {
          if (options.idempotent && !ambiguousRetryUsed) {
            ambiguousRetryUsed = true;
            this.record({
              operation: observableOperation(options.majorRoute),
              status: "retry",
              durationMs: this.now() - startedAt,
              error,
            });
            continue;
          }
          this.record({
            operation: observableOperation(options.majorRoute),
            status: "failed",
            durationMs: this.now() - startedAt,
            error,
          });
          throw new DiscordBridgeError(
            "provider_unavailable",
            error instanceof Error && error.name === "AbortError"
              ? "Discord request timed out"
              : "Discord request failed",
          );
        } finally {
          clearTimeout(timeout);
        }

        const bucketId = response.headers.get("x-ratelimit-bucket");
        const remaining = Number(response.headers.get("x-ratelimit-remaining"));
        const resetAfter = secondsHeaderToMs(response.headers.get("x-ratelimit-reset-after"));
        if (bucketId) {
          this.routeBuckets.set(options.majorRoute, bucketId);
          if (Number.isFinite(remaining) && resetAfter !== null) {
            this.buckets.set(bucketId, {
              remaining,
              resetAt: this.now() + resetAfter,
            });
          }
        }

        if (response.ok) {
          this.record({
            operation: observableOperation(options.majorRoute),
            status: "success",
            durationMs: this.now() - startedAt,
            statusCode: response.status,
          });
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }

        const errorBody = await response.json().catch(() => null) as DiscordApiErrorBody | null;
        const retryAfterMs =
          typeof errorBody?.retry_after === "number"
            ? errorBody.retry_after * 1_000
            : secondsHeaderToMs(response.headers.get("retry-after"));
        if (response.status === 429 && retryAfterMs !== null) {
          if (errorBody?.global) {
            this.globalResetAt = Math.max(this.globalResetAt, this.now() + retryAfterMs);
          } else if (bucketId) {
            this.buckets.set(bucketId, {
              remaining: 0,
              resetAt: this.now() + retryAfterMs,
            });
          }
        }
        if (
          response.status === 429 &&
          retryAfterMs !== null &&
          retryAfterMs <= MAX_INLINE_RATE_LIMIT_WAIT_MS &&
          !rateLimitRetryUsed
        ) {
          rateLimitRetryUsed = true;
          this.record({
            operation: observableOperation(options.majorRoute),
            status: "retry",
            durationMs: this.now() - startedAt,
            statusCode: response.status,
            rateLimitScope: errorBody?.global ? "global" : "route",
            retryAfterMs,
          });
          await this.wait(retryAfterMs);
          continue;
        }
        if (response.status >= 500 && options.idempotent && !ambiguousRetryUsed) {
          ambiguousRetryUsed = true;
          this.record({
            operation: observableOperation(options.majorRoute),
            status: "retry",
            durationMs: this.now() - startedAt,
            statusCode: response.status,
          });
          continue;
        }
        this.record({
          operation: observableOperation(options.majorRoute),
          status: "failed",
          durationMs: this.now() - startedAt,
          statusCode: response.status,
          rateLimitScope: response.status === 429
            ? errorBody?.global ? "global" : "route"
            : undefined,
          retryAfterMs: retryAfterMs ?? undefined,
        });
        throw new DiscordBridgeError(
          classifyDiscordRestError(response.status, errorBody?.code),
          safeProviderMessage(response.status, errorBody?.code),
          retryAfterMs ?? undefined,
        );
      }
    });
  }

  getGatewayBot(): Promise<{
    url: string;
    shards: number;
    session_start_limit: {
      total: number;
      remaining: number;
      reset_after: number;
      max_concurrency: number;
    };
  }> {
    return this.request("/gateway/bot", { majorRoute: "gateway:bot", idempotent: true });
  }

  getCurrentUser(): Promise<{ id: string; username: string }> {
    return this.request("/users/@me", { majorRoute: "users:@me", idempotent: true });
  }

  getGuild(guildId: string): Promise<{ id: string; name: string }> {
    return this.request(`/guilds/${guildId}`, {
      majorRoute: `guild:${guildId}`,
      idempotent: true,
    });
  }

  getGuildChannels(guildId: string): Promise<DiscordChannelPayload[]> {
    return this.request(`/guilds/${guildId}/channels`, {
      majorRoute: `guild:${guildId}:channels`,
      idempotent: true,
    });
  }

  getGuildRoles(guildId: string): Promise<DiscordRolePayload[]> {
    return this.request(`/guilds/${guildId}/roles`, {
      majorRoute: `guild:${guildId}:roles`,
      idempotent: true,
    });
  }

  getGuildMember(guildId: string, userId: string): Promise<DiscordGuildMemberPayload> {
    return this.request(`/guilds/${guildId}/members/${userId}`, {
      majorRoute: `guild:${guildId}:member`,
      idempotent: true,
    });
  }

  getChannel(channelId: string): Promise<DiscordChannelPayload> {
    return this.request(`/channels/${channelId}`, {
      majorRoute: `channel:${channelId}`,
      idempotent: true,
    });
  }

  async startThreadFromMessage(args: {
    parentChannelId: string;
    messageId: string;
    name: string;
  }): Promise<{ id: string; name?: string; parent_id?: string }> {
    try {
      return await this.request(
        `/channels/${args.parentChannelId}/messages/${args.messageId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: args.name, auto_archive_duration: 1_440 }),
          majorRoute: `channel:${args.parentChannelId}:thread-from-message`,
          idempotent: true,
        },
      );
    } catch (error) {
      if (
        !(error instanceof DiscordBridgeError) ||
        !["invalid_request", "provider_unavailable"].includes(error.code)
      ) {
        throw error;
      }
      try {
        const existing = await this.getChannel(args.messageId);
        if (existing.type === 11 && existing.parent_id === args.parentChannelId) {
          return {
            id: existing.id,
            name: existing.name,
            parent_id: existing.parent_id ?? undefined,
          };
        }
      } catch {
        // Preserve the original operation error when recovery cannot prove the
        // thread exists.
      }
      throw error;
    }
  }

  async createStarterFailureNotice(args: {
    parentChannelId: string;
    messageId: string;
    operationId: string;
    text: string;
  }): Promise<{ id: string }> {
    const nonce = await stableDiscordNonce(args.operationId, 0);
    return this.request(`/channels/${args.parentChannelId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: args.text,
        nonce,
        enforce_nonce: true,
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: {
          message_id: args.messageId,
          fail_if_not_exists: false,
        },
      }),
      majorRoute: `channel:${args.parentChannelId}:messages`,
      idempotent: true,
    });
  }

  async createMessages(args: {
    threadId: string;
    operationId: string;
    text?: string;
    attachments?: Array<{
      filename: string;
      contentType: string;
      content: Blob;
      description?: string;
    }>;
  }): Promise<{ messageIds: string[]; chunkCount: number }> {
    const chunks = args.text ? splitDiscordMessage(args.text) : [];
    const sends = chunks.length > 0 ? chunks : [""];
    const messageIds: string[] = [];
    for (const [index, content] of sends.entries()) {
      const nonce = await stableDiscordNonce(args.operationId, index);
      const existing = await this.findRecentMessageByNonce(args.threadId, nonce);
      if (existing) {
        messageIds.push(existing.id);
        continue;
      }
      const attachments = index === 0 ? args.attachments || [] : [];
      const payload = {
        content: content || undefined,
        nonce,
        enforce_nonce: true,
        allowed_mentions: { parse: [], replied_user: false },
        attachments: attachments.map((attachment, attachmentIndex) => ({
          id: attachmentIndex,
          filename: attachment.filename,
          description: attachment.description,
        })),
      };
      let body: BodyInit;
      let headers: HeadersInit | undefined;
      if (attachments.length > 0) {
        const form = new FormData();
        form.set("payload_json", JSON.stringify(payload));
        for (const [attachmentIndex, attachment] of attachments.entries()) {
          form.set(`files[${attachmentIndex}]`, attachment.content, attachment.filename);
        }
        body = form;
      } else {
        headers = { "Content-Type": "application/json" };
        body = JSON.stringify(payload);
      }
      let result: { id: string };
      try {
        result = await this.request<{ id: string }>(
          `/channels/${args.threadId}/messages`,
          {
            method: "POST",
            headers,
            body,
            majorRoute: `channel:${args.threadId}:messages`,
            idempotent: true,
          },
        );
      } catch (error) {
        const recovered = await this.findRecentMessageByNonce(args.threadId, nonce);
        if (!recovered) throw error;
        result = recovered;
      }
      messageIds.push(result.id);
    }
    return { messageIds, chunkCount: sends.length };
  }

  private async findRecentMessageByNonce(
    channelId: string,
    nonce: string,
  ): Promise<{ id: string } | null> {
    const messages = await this.request<unknown>(
      `/channels/${channelId}/messages?limit=100`,
      {
        majorRoute: `channel:${channelId}:messages`,
        idempotent: true,
      },
    ).catch(() => []);
    if (!Array.isArray(messages)) return null;
    const match = (messages as Array<{ id?: string; nonce?: string | number | null }>).find((message) =>
      message.id && message.nonce !== undefined && message.nonce !== null &&
      String(message.nonce) === nonce
    );
    return match?.id ? { id: match.id } : null;
  }
}

export type { DiscordAttachmentPayload };
