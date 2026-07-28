import { DurableObject } from "cloudflare:workers";
import {
  classifyDiscordGatewayClose,
  discordIdentifyPayload,
  discordInitialHeartbeatDelayMs,
  discordReconnectDelayMs,
  discordResumePayload,
  DISCORD_GATEWAY_VERSION,
} from "./gateway-protocol.js";
import {
  discordContentMode,
  type DiscordBridgeEnv,
  type DiscordGatewayEnvelope,
  type DiscordGatewayHealthState,
} from "./types.js";
import { recordDiscordBridgeEvent } from "./observability.js";

const GATEWAY_INSTANCE_NAME = "gateway:v1:0:1";
const CONTROL_INSTANCE_NAME = "control:v1";
const WATCHDOG_INTERVAL_MS = 60_000;
const SEQUENCE_PERSIST_INTERVAL_MS = 5_000;
const SEQUENCE_PERSIST_DISPATCH_COUNT = 100;
const GATEWAY_CONFIGURATION_FINGERPRINT_KEY = "gateway_configuration_fingerprint";
const GATEWAY_CONFIGURATION_FINGERPRINT_VERSION = "v1";
const CONFIGURATION_RECOVERABLE_FATAL_REASONS = new Set([
  "missing_configuration",
  "application_identity_mismatch",
  "gateway_close_4004",
  "gateway_close_4013",
  "gateway_close_4014",
]);

interface GatewaySessionState {
  sessionId: string;
  resumeGatewayUrl: string;
  sequence: number;
  updatedAt: number;
}

interface GatewayBotMetadata {
  url: string;
  shards: number;
  session_start_limit: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}

function initialHealth(env: DiscordBridgeEnv): DiscordGatewayHealthState {
  return {
    state: "idle",
    shardId: 0,
    shardCount: 1,
    readyAt: null,
    resumedAt: null,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastHeartbeatAckAt: null,
    lastSequence: null,
    reconnectCount: 0,
    lastCloseCode: null,
    sessionStartsRemaining: null,
    sessionStartsResetAt: null,
    maxConcurrency: null,
    recommendedShardCount: null,
    contentMode: discordContentMode(env),
    fatalReason: null,
  };
}

export class DiscordGatewayDO extends DurableObject<DiscordBridgeEnv> {
  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalMs = 0;
  private heartbeatAwaitingAck = false;
  private reconnectAttempt = 0;
  /** Latest Gateway sequence received; used for heartbeats only. */
  private sequence: number | null = null;
  /** Latest sequence durably handled by the control DO; safe to Resume from. */
  private processedSequence: number | null = null;
  private lastSequencePersistAt = 0;
  private dispatchesSinceSequencePersist = 0;
  private dispatchChain: Promise<void> = Promise.resolve();
  private dispatchForwardingFailed = false;
  private nextReconnectDelayMs: number | undefined;
  private connectInFlight: Promise<DiscordGatewayHealthState> | null = null;
  private healthState: DiscordGatewayHealthState;

  constructor(ctx: DurableObjectState, env: DiscordBridgeEnv) {
    super(ctx, env);
    this.healthState = ctx.storage.kv.get<DiscordGatewayHealthState>("gateway_health") ?? initialHealth(env);
    const session = ctx.storage.kv.get<GatewaySessionState>("gateway_session");
    this.sequence = session?.sequence ?? null;
    this.processedSequence = session?.sequence ?? null;
    ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
    });
  }

  private controlStub() {
    return this.env.CONTROL.get(this.env.CONTROL.idFromName(CONTROL_INSTANCE_NAME));
  }

  private observe(
    event: string,
    status: string,
    options: {
      severity?: "debug" | "info" | "warn" | "error";
      count?: number;
      error?: unknown;
    } = {},
  ): void {
    recordDiscordBridgeEvent(this.env, {
      event,
      component: "discord_gateway",
      operation: "gateway_session",
      status,
      severity: options.severity,
      count: options.count,
      error: options.error,
    });
  }

  private persistHealth(): void {
    this.healthState.lastSequence = this.sequence;
    this.ctx.storage.kv.put("gateway_health", this.healthState);
  }

  private storedSession(): GatewaySessionState | null {
    return this.ctx.storage.kv.get<GatewaySessionState>("gateway_session") ?? null;
  }

  private clearSession(): void {
    this.ctx.storage.kv.delete("gateway_session");
    this.sequence = null;
    this.processedSequence = null;
  }

  private async configurationFingerprint(): Promise<string> {
    const input = [
      GATEWAY_CONFIGURATION_FINGERPRINT_VERSION,
      this.env.DISCORD_APPLICATION_ID || "",
      this.env.DISCORD_BOT_TOKEN || "",
      discordContentMode(this.env),
    ].join("\0");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(input),
    );
    return Array.from(new Uint8Array(digest), (byte) => (
      byte.toString(16).padStart(2, "0")
    )).join("");
  }

  private async refreshConfigurationIdentity(): Promise<boolean> {
    const fingerprint = await this.configurationFingerprint();
    const previousFingerprint = this.ctx.storage.kv.get<string>(
      GATEWAY_CONFIGURATION_FINGERPRINT_KEY,
    );
    this.ctx.storage.kv.put(GATEWAY_CONFIGURATION_FINGERPRINT_KEY, fingerprint);
    this.healthState.contentMode = discordContentMode(this.env);

    const shouldReset = previousFingerprint === undefined
      ? (
          this.healthState.state === "fatal" &&
          CONFIGURATION_RECOVERABLE_FATAL_REASONS.has(
            this.healthState.fatalReason || "",
          )
        )
      : previousFingerprint !== fingerprint;
    if (!shouldReset) {
      this.persistHealth();
      return false;
    }

    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.socketGeneration += 1;
    socket?.close(1000, "gateway configuration changed");
    this.clearSession();
    this.heartbeatAwaitingAck = false;
    this.healthState.state = "idle";
    this.healthState.fatalReason = null;
    this.persistHealth();
    this.observe("discord.gateway.configuration_changed", "reset");
    return true;
  }

  private persistProcessedSequence(sequence: number, force = false): void {
    this.processedSequence = sequence;
    const session = this.storedSession();
    if (!session) return;
    const now = Date.now();
    if (
      !force &&
      now - this.lastSequencePersistAt < SEQUENCE_PERSIST_INTERVAL_MS &&
      this.dispatchesSinceSequencePersist < SEQUENCE_PERSIST_DISPATCH_COUNT
    ) {
      return;
    }
    this.ctx.storage.kv.put("gateway_session", {
      ...session,
      sequence,
      updatedAt: now,
    } satisfies GatewaySessionState);
    this.lastSequencePersistAt = now;
    this.dispatchesSinceSequencePersist = 0;
  }

  private async gatewayMetadata(): Promise<GatewayBotMetadata> {
    const response = await this.controlStub().fetch(
      new Request("https://discord-bridge.internal/internal/v1/gateway/bot"),
    );
    if (!response.ok) throw new Error("Failed to load Discord Gateway metadata");
    return await response.json() as GatewayBotMetadata;
  }

  private send(payload: unknown, generation = this.socketGeneration): void {
    if (generation !== this.socketGeneration || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private scheduleHeartbeat(generation: number, delayMs = this.heartbeatIntervalMs): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (generation !== this.socketGeneration) return;
      if (this.heartbeatAwaitingAck) {
        this.observe("discord.gateway.heartbeat_timeout", "missing_ack", {
          severity: "error",
        });
        this.socket?.close(4000, "heartbeat timeout");
        return;
      }
      this.heartbeatAwaitingAck = true;
      this.healthState.lastHeartbeatAt = Date.now();
      this.persistHealth();
      this.send({ op: 1, d: this.sequence }, generation);
      this.scheduleHeartbeat(generation);
    }, Math.max(1, delayMs));
  }

  private authenticate(generation: number): void {
    const session = this.storedSession();
    if (session && Number.isInteger(session.sequence)) {
      this.send(discordResumePayload({
        token: this.env.DISCORD_BOT_TOKEN,
        sessionId: session.sessionId,
        sequence: session.sequence,
      }), generation);
      return;
    }
    if (
      this.healthState.sessionStartsRemaining !== null &&
      this.healthState.sessionStartsRemaining <= 0 &&
      (this.healthState.sessionStartsResetAt ?? 0) > Date.now()
    ) {
      this.healthState.state = "fatal";
      this.healthState.fatalReason = "session_start_limit";
      this.persistHealth();
      this.observe("discord.gateway.fatal", "session_start_limit", { severity: "error" });
      this.socket?.close(1000, "session start limit exhausted");
      return;
    }
    this.send(discordIdentifyPayload({
      token: this.env.DISCORD_BOT_TOKEN,
      mode: discordContentMode(this.env),
      shardId: 0,
      shardCount: 1,
    }), generation);
    if (this.healthState.sessionStartsRemaining !== null) {
      this.healthState.sessionStartsRemaining = Math.max(
        0,
        this.healthState.sessionStartsRemaining - 1,
      );
      this.persistHealth();
    }
  }

  private onHello(envelope: DiscordGatewayEnvelope, generation: number): void {
    const data = envelope.d as { heartbeat_interval?: number };
    const interval = Number(data?.heartbeat_interval);
    if (!Number.isFinite(interval) || interval <= 0) {
      this.socket?.close(4002, "invalid hello");
      return;
    }
    this.heartbeatIntervalMs = interval;
    this.healthState.heartbeatIntervalMs = interval;
    this.persistHealth();
    const jitter = discordInitialHeartbeatDelayMs(interval);
    this.scheduleHeartbeat(generation, jitter);
    queueMicrotask(() => this.authenticate(generation));
  }

  private async onDispatch(
    envelope: DiscordGatewayEnvelope,
    generation: number,
  ): Promise<void> {
    const dispatchSequence = typeof envelope.s === "number" ? envelope.s : null;
    if (envelope.t === "READY") {
      const ready = envelope.d as {
        session_id?: string;
        resume_gateway_url?: string;
        user?: { id?: string };
      };
      if (!ready.session_id || !ready.resume_gateway_url || !ready.user?.id || this.sequence === null) {
        this.socket?.close(4002, "invalid ready");
        return;
      }
      if (ready.user.id !== this.env.DISCORD_APPLICATION_ID) {
        this.healthState.state = "fatal";
        this.healthState.fatalReason = "application_identity_mismatch";
        this.persistHealth();
        this.observe("discord.gateway.fatal", "application_identity_mismatch", {
          severity: "error",
        });
        this.socket?.close(4004, "application identity mismatch");
        return;
      }
      await this.controlStub().setBotIdentity(ready.user.id);
      if (generation !== this.socketGeneration) return;
      const readySequence = dispatchSequence ?? this.sequence;
      this.ctx.storage.kv.put("gateway_session", {
        sessionId: ready.session_id,
        resumeGatewayUrl: ready.resume_gateway_url,
        sequence: readySequence,
        updatedAt: Date.now(),
      } satisfies GatewaySessionState);
      this.processedSequence = readySequence;
      this.lastSequencePersistAt = Date.now();
      this.dispatchesSinceSequencePersist = 0;
      this.healthState.state = "ready";
      this.healthState.readyAt = Date.now();
      this.healthState.fatalReason = null;
      this.reconnectAttempt = 0;
      this.persistHealth();
      this.observe("discord.gateway.ready", "ready");
      return;
    }
    if (envelope.t === "RESUMED") {
      if (dispatchSequence !== null) {
        this.persistProcessedSequence(dispatchSequence, true);
      }
      this.healthState.state = "resumed";
      this.healthState.resumedAt = Date.now();
      this.healthState.fatalReason = null;
      this.reconnectAttempt = 0;
      this.persistHealth();
      this.observe("discord.gateway.resumed", "resumed");
      return;
    }
    if (["MESSAGE_CREATE", "GUILD_CREATE", "GUILD_DELETE", "CHANNEL_DELETE", "THREAD_DELETE"].includes(envelope.t || "")) {
      await this.controlStub().handleGatewayDispatch(envelope);
    }
    if (generation !== this.socketGeneration) return;
    if (dispatchSequence !== null) {
      this.dispatchesSinceSequencePersist += 1;
      this.persistProcessedSequence(dispatchSequence);
    }
  }

  private handleMessage(event: MessageEvent, generation: number): void {
    if (generation !== this.socketGeneration || typeof event.data !== "string") return;
    let envelope: DiscordGatewayEnvelope;
    try {
      envelope = JSON.parse(event.data) as DiscordGatewayEnvelope;
    } catch {
      this.socket?.close(4002, "invalid payload");
      return;
    }
    if (typeof envelope.s === "number") {
      this.sequence = envelope.s;
    }
    switch (envelope.op) {
      case 10:
        this.onHello(envelope, generation);
        return;
      case 11:
        this.heartbeatAwaitingAck = false;
        this.healthState.lastHeartbeatAckAt = Date.now();
        this.persistHealth();
        return;
      case 1:
        this.heartbeatAwaitingAck = true;
        this.send({ op: 1, d: this.sequence }, generation);
        this.healthState.lastHeartbeatAt = Date.now();
        this.persistHealth();
        return;
      case 7:
        this.socket?.close(4000, "gateway reconnect");
        return;
      case 9: {
        const resumable = envelope.d === true;
        if (!resumable) this.clearSession();
        this.nextReconnectDelayMs = 1_000 + Math.floor(Math.random() * 4_000);
        this.socket?.close(resumable ? 4000 : 4007, "invalid session");
        return;
      }
      case 0: {
        const next = this.dispatchChain.then(async () => {
          if (
            generation !== this.socketGeneration ||
            this.dispatchForwardingFailed
          ) return;
          try {
            await this.onDispatch(envelope, generation);
          } catch (error) {
            this.dispatchForwardingFailed = true;
            this.socket?.close(4000, "dispatch forwarding failed");
            throw error;
          }
        });
        const settled = next.catch((error) => {
          console.error("[discord-gateway] dispatch forwarding failed", {
            eventType: envelope.t || "unknown",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        this.dispatchChain = settled;
        this.ctx.waitUntil(settled);
        return;
      }
      default:
        return;
    }
  }

  private handleClose(event: CloseEvent, generation: number): void {
    if (generation !== this.socketGeneration) return;
    if (this.processedSequence !== null) {
      this.persistProcessedSequence(this.processedSequence, true);
    }
    const requestedReconnectDelay = this.nextReconnectDelayMs;
    this.nextReconnectDelayMs = undefined;
    this.clearTimers();
    this.socket = null;
    this.heartbeatAwaitingAck = false;
    this.healthState.lastCloseCode = event.code;
    this.observe("discord.gateway.closed", `close_${event.code}`, {
      severity: event.code === 1000 ? "info" : "warn",
    });
    if (this.healthState.state === "fatal") {
      this.persistHealth();
      return;
    }
    const action = classifyDiscordGatewayClose(event.code);
    if (action === "fatal") {
      this.healthState.state = "fatal";
      this.healthState.fatalReason = `gateway_close_${event.code}`;
      this.persistHealth();
      this.observe("discord.gateway.fatal", `gateway_close_${event.code}`, {
        severity: "error",
      });
      return;
    }
    if (action === "reidentify") this.clearSession();
    this.healthState.state = "reconnecting";
    this.healthState.reconnectCount += 1;
    this.persistHealth();
    this.scheduleReconnect(requestedReconnectDelay);
  }

  private scheduleReconnect(explicitDelay?: number): void {
    if (this.healthState.state === "fatal" || this.reconnectTimer) return;
    const delay = explicitDelay ?? discordReconnectDelayMs(this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch((error) => {
        console.error("[discord-gateway] reconnect failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
      });
    }, delay);
    this.ctx.storage.setAlarm(Date.now() + Math.max(delay, 1_000)).catch(() => undefined);
  }

  async ensureConnected(): Promise<DiscordGatewayHealthState> {
    await this.refreshConfigurationIdentity();
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return this.health();
    }
    if (this.healthState.state === "reconnecting" && this.reconnectTimer) {
      return this.health();
    }
    if (this.connectInFlight) return this.connectInFlight;
    const operation = this.openGatewayConnection();
    this.connectInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.connectInFlight === operation) this.connectInFlight = null;
    }
  }

  private async openGatewayConnection(): Promise<DiscordGatewayHealthState> {
    if (this.healthState.state === "fatal") {
      const resetAt = this.healthState.sessionStartsResetAt;
      if (this.healthState.fatalReason === "session_start_limit" && resetAt && resetAt <= Date.now()) {
        this.healthState.state = "idle";
        this.healthState.fatalReason = null;
      } else if (
        this.healthState.fatalReason === "missing_configuration" &&
        this.env.DISCORD_BOT_TOKEN &&
        this.env.DISCORD_APPLICATION_ID
      ) {
        this.healthState.state = "idle";
        this.healthState.fatalReason = null;
      } else {
        return this.health();
      }
    }
    if (!this.env.DISCORD_BOT_TOKEN || !this.env.DISCORD_APPLICATION_ID) {
      this.healthState.state = "fatal";
      this.healthState.fatalReason = "missing_configuration";
      this.persistHealth();
      this.observe("discord.gateway.fatal", "missing_configuration", { severity: "error" });
      return this.health();
    }
    const metadata = await this.gatewayMetadata();
    this.healthState.sessionStartsRemaining = metadata.session_start_limit.remaining;
    this.healthState.sessionStartsResetAt = Date.now() + metadata.session_start_limit.reset_after;
    this.healthState.maxConcurrency = metadata.session_start_limit.max_concurrency;
    this.healthState.recommendedShardCount = metadata.shards;
    this.observe(
      "discord.gateway.session_start_limit",
      "observed",
      { count: metadata.session_start_limit.remaining },
    );
    this.observe("discord.gateway.recommended_shards", "observed", {
      count: metadata.shards,
    });
    if (metadata.shards > 1) {
      this.healthState.state = "fatal";
      this.healthState.fatalReason = "sharding_required";
      this.persistHealth();
      this.observe("discord.gateway.fatal", "sharding_required", { severity: "error" });
      return this.health();
    }
    this.heartbeatAwaitingAck = false;
    this.healthState.lastHeartbeatAt = null;
    this.healthState.lastHeartbeatAckAt = null;
    this.healthState.state = "connecting";
    this.persistHealth();
    this.observe("discord.gateway.connecting", "connecting");
    const session = this.storedSession();
    const baseUrl = session?.resumeGatewayUrl || metadata.url;
    const gatewayUrl = new URL(baseUrl);
    gatewayUrl.searchParams.set("v", String(DISCORD_GATEWAY_VERSION));
    gatewayUrl.searchParams.set("encoding", "json");
    const socket = new WebSocket(gatewayUrl.toString());
    const generation = ++this.socketGeneration;
    this.dispatchForwardingFailed = false;
    this.dispatchChain = Promise.resolve();
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event, generation));
    socket.addEventListener("close", (event) => this.handleClose(event, generation));
    socket.addEventListener("error", () => socket.close(4000, "gateway socket error"));
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
    return this.health();
  }

  health(): DiscordGatewayHealthState {
    return { ...this.healthState, lastSequence: this.sequence };
  }

  async alarm(): Promise<void> {
    await this.ensureConnected();
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/v1/gateway/connect") {
      return Response.json({ ok: true, health: await this.ensureConnected() });
    }
    if (request.method === "GET" && url.pathname === "/internal/v1/gateway/status") {
      return Response.json({ ok: true, health: this.health() });
    }
    if (request.method === "POST" && url.pathname === "/internal/v1/gateway/reset") {
      this.clearTimers();
      this.socket?.close(1000, "operator reset");
      this.socket = null;
      this.clearSession();
      this.healthState.state = "idle";
      this.healthState.fatalReason = null;
      this.persistHealth();
      return Response.json({ ok: true, health: await this.ensureConnected() });
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
}

export { GATEWAY_INSTANCE_NAME };
