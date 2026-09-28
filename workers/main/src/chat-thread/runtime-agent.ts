/**
 * A thread's agent on the hosted agent runtime (plans/agent-runtime-migration.md).
 *
 * `RuntimeAgentSession` stands where ChatThreadDO's in-process Pi `Agent`
 * stands, with the few members the DO uses (`state`, `subscribe`, `prompt`,
 * `steer`, `abort`, `continue`, `waitForIdle`). The runtime runs the model
 * loop and sends native Pi `AgentEvent`s over its client event stream, so the
 * DO's event handler, chunk encoder, pi_core mirror and UI transport work
 * unchanged. The runtime owns the transcript, compaction, retries and turn
 * handoff; this class only relays.
 *
 * Durable per thread (DO KV via `RuntimeAgentStore`): the agent's id and
 * token, the event cursor at the last run boundary, and the run in flight. A
 * DO that restarts mid-run replays that run's events from its start cursor
 * (the runtime buffers them) instead of prompting again.
 */
import type { AgentEvent, AgentMessage, AgentState } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  RUNTIME_TOOL_PREFIX as TOOL_PREFIX,
  localToolName,
  readableProviderError,
  type RuntimeInput,
  type RuntimeInputAnswer,
} from "../../../../src/lib/agent-runtime-shared";

export {
  RUNTIME_TOOL_SERVER,
  localToolName,
  readableProviderError,
  runtimeInputQuestions,
  type RuntimeInput,
  type RuntimeInputAnswer,
  type RuntimeInputCard,
} from "../../../../src/lib/agent-runtime-shared";
/** The tenant's model endpoint in the runtime (chiridion's forwarder). */
export const RUNTIME_MODEL_ENDPOINT = "chiridion";
const FRAME_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Leads chiridion's system prompt when it is appended to the runtime's: the
 * prompt was written for the in-DO tool surface, whose names and js_exec
 * bindings differ here.
 */
export const RUNTIME_PROMPT_PREAMBLE = [
  "# camelAI tools on this runtime",
  `camelAI's tools are named ${TOOL_PREFIX}<tool> (for example ${TOOL_PREFIX}read, ${TOOL_PREFIX}deploy_project, ${TOOL_PREFIX}set_preview). Where the instructions below name a tool, use its ${TOOL_PREFIX} form; in js_exec call it as tools.${TOOL_PREFIX}<tool>(args).`,
  `js_exec has no env bindings, connections object or network here: query or call a connection with ${TOOL_PREFIX}connections_query / ${TOOL_PREFIX}connections_invoke, drive a browser with ${TOOL_PREFIX}browser_launch / ${TOOL_PREFIX}browser_action, generate images or transcribe audio with ${TOOL_PREFIX}generate_image / ${TOOL_PREFIX}transcribe_audio, call a deployed app with ${TOOL_PREFIX}http_request, and read the web with web_fetch / web_search.`,
  [
    "There are two filesystems.",
    "/workspace is this conversation's scratch space: files attached to messages, files tools return (under /workspace/tool-outputs/), and your own intermediate files. Read and write it with fs in js_exec, and give a file to the user with present_file. It is private to this conversation and deleted with it.",
    `The camelAI workspace is the user's durable storage, shared with their apps and other chats: workspace, project and uploaded files live there (location "workspace", "project" or "r2"). Use the ${TOOL_PREFIX} file tools for it, never fs. Save something from /workspace into it only when the user asks.`,
    "Where the instructions below name a camelAI file path (such as /workspace/AGENTS.md, or a project VM's /workspace for shell commands), that is the camelAI workspace or the project, not the scratch space.",
  ].join(" "),
  `In js_exec, await tools.${TOOL_PREFIX}<tool>(args) returns the tool's data itself (for example ${TOOL_PREFIX}list_apps gives { total, count, apps: [...] }; a file read gives its text, or { text, ...details }): use it directly, without JSON.parse or unwrapping.`,
].join("\n\n");

/**
 * The version of the instructions chiridion appends for runtime agents
 * (RUNTIME_PROMPT_PREAMBLE and the prompt after it). Bump it when they change
 * in a way existing threads must get: their next send re-sends them.
 */
export const RUNTIME_PROMPT_VERSION = 2;

export interface RuntimeAgentEnv {
  AGENT_RUNTIME_URL?: string;
  AGENT_RUNTIME_TENANT?: string;
  AGENT_RUNTIME_API_TOKEN?: string;
  AGENT_RUNTIME_DEFINITION?: string;
  APP_KV: KVNamespace;
}

export interface RuntimeAgentRecord {
  id: string;
  token: string;
  /** The runtime model and key scope last configured. */
  model?: string;
  keyScope?: string | null;
}

/** A run's configuration: a Pi model id (or the Codex forwarder's), its key scope, and its spend limit. */
export interface RuntimeRunConfig {
  model: string;
  /** `hosted` or `org_<id>`; null for the Codex forwarder (a tenant endpoint). */
  keyScope: string | null;
  /** USD the run may spend; null for no limit. */
  spendLimitUsd: number | null;
  /** Non-secret headers on every model call (the hosted scope's gateway metadata); null for none. They follow the key scope. */
  modelHeaders: Record<string, string> | null;
}

export interface RuntimeRunRecord {
  requestId: string;
  /** Event cursor before the run began: a restart replays the run from here. */
  cursor: number;
}

export interface RuntimeAgentStore {
  agent(): RuntimeAgentRecord | null;
  saveAgent(agent: RuntimeAgentRecord): void;
  run(): RuntimeRunRecord | null;
  saveRun(run: RuntimeRunRecord | null): void;
}

export interface RuntimeAgentIdentity {
  orgId: string;
  workspaceId: string;
  threadId: string;
  /** The thread's creator: `sub` in the agent's identity tokens. */
  subject: string;
}

export interface RuntimeAgentSessionOptions {
  env: RuntimeAgentEnv;
  store: RuntimeAgentStore;
  identity: RuntimeAgentIdentity;
  /** Who is acting in the run being started: `act` in its tokens. */
  actor: () => string | null;
  /** Instructions for the run being started, sent ahead of its message. */
  runInstructions?: () => string | null;
  /**
   * Before each run (and the agent's creation): the thread's model and key
   * scope now, after the gates as the acting user, and the spend limit the
   * run may use. Throws when the run may not start (credits, limits, a route
   * the runtime cannot take).
   */
  prepareRun: () => Promise<RuntimeRunConfig>;
  /** The committed transcript the DO loaded; runtime messages append to it. */
  initialState: Pick<AgentState, "systemPrompt" | "model" | "tools" | "messages" | "thinkingLevel">;
  /** The configuration applied once, right after the agent is created. */
  configuration: () => Promise<{ systemPromptAppend: string }>;
  /** Called for the runtime's heartbeats, so the DO's stall watchdog sees a long tool call as alive. */
  onActivity?: () => void;
  /**
   * Ask the thread's user one of the inputs a suspended run waits on, and
   * return the answer to send; rejects when nobody answers in time or the
   * signal aborts (the turn then ends and the input stays pending).
   */
  answerInput?: (input: RuntimeInput, signal: AbortSignal) => Promise<RuntimeInputAnswer>;
  fetch?: typeof globalThis.fetch;
}

type Listener = (event: AgentEvent) => unknown;
/** Pi's `AgentState`, writable: this session maintains it from the runtime's events. */
type RuntimeAgentState = { -readonly [K in keyof AgentState]: AgentState[K] } & { pendingToolCalls: Set<string> };
type ClientFrame =
  | { type: "event"; requestId: string; event: Record<string, unknown> }
  | { type: "response"; id: string; outcome: { result?: unknown; error?: string; uncertain?: boolean } };

export function runtimeUrl(env: RuntimeAgentEnv): string {
  return (env.AGENT_RUNTIME_URL || "https://agents.camelai.dev").replace(/\/+$/, "");
}

/**
 * Whether this deployment has a runtime tenant: its operator token, tenant id
 * and agent definition. Without them every thread runs on the in-DO loop.
 */
export function runtimeConfigured(env: Partial<RuntimeAgentEnv>): boolean {
  return Boolean(env.AGENT_RUNTIME_API_TOKEN?.trim() && env.AGENT_RUNTIME_TENANT?.trim() && env.AGENT_RUNTIME_DEFINITION?.trim());
}

export class RuntimeAgentError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "RuntimeAgentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localizeMessage<T>(input: T): T {
  if (!isRecord(input)) return input;
  const message: Record<string, unknown> = input.role === "assistant" && typeof input.errorMessage === "string"
    ? { ...input, errorMessage: readableProviderError(input.errorMessage) }
    : input;
  if (message.role === "toolResult" && typeof message.toolName === "string") {
    return { ...message, toolName: localToolName(message.toolName) } as T;
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((block) =>
        isRecord(block) && block.type === "toolCall" ? { ...block, name: localToolName(block.name) } : block),
    } as T;
  }
  return message as T;
}

/** A runtime event with chiridion's tool names, as the DO's handler expects it. */
export function localizeEvent(event: Record<string, unknown>): Record<string, unknown> {
  const localized: Record<string, unknown> = { ...event };
  if ("toolName" in localized) localized.toolName = localToolName(localized.toolName);
  if ("message" in localized) localized.message = localizeMessage(localized.message);
  if (Array.isArray(localized.messages)) localized.messages = localized.messages.map(localizeMessage);
  if (isRecord(localized.assistantMessageEvent)) {
    const inner = { ...localized.assistantMessageEvent };
    if (isRecord(inner.toolCall)) inner.toolCall = { ...inner.toolCall, name: localToolName(inner.toolCall.name) };
    if ("partial" in inner) inner.partial = localizeMessage(inner.partial);
    localized.assistantMessageEvent = inner;
  }
  return localized;
}

function userText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isRecord(part) && part.type === "text" ? String(part.text ?? "") : "")).join("");
}

/** Replay gaps one run may recover from before it gives up, so a stream that keeps answering 409 cannot loop. */
const MAX_REPLAY_GAPS = 3;

const SPEND_LIMIT_MESSAGE =
  "This reply stopped at your spending limit (your LLM usage limit or your organization's remaining hosted credits).";

function errorAssistant(model: AgentState["model"], message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

export class RuntimeAgentSession {
  readonly state: RuntimeAgentState;
  private readonly options: RuntimeAgentSessionOptions;
  private readonly listeners = new Set<Listener>();
  /** Local copies of user messages sent this run, to keep their render ids when the runtime echoes them. */
  private readonly sentUserMessages: AgentMessage[] = [];
  private running: Promise<void> | null = null;
  private streamAbort: AbortController | null = null;
  private sawAgentEnd = false;
  /** A suspended run's agent_end, held so the UI turn stays open while the user answers. */
  private heldAgentEnd: Record<string, unknown> | null = null;
  /** Set while relaying a resume run, whose agent_start continues the open turn. */
  private resuming = false;
  private inputAbort: AbortController | null = null;

  constructor(options: RuntimeAgentSessionOptions) {
    this.options = options;
    this.state = {
      ...options.initialState,
      messages: [...options.initialState.messages],
      isStreaming: false,
      pendingToolCalls: new Set<string>(),
    } as RuntimeAgentState;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private get fetcher() {
    return this.options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call(path: string, init: { method?: string; body?: unknown; token: string; headers?: Record<string, string> }) {
    const response = await this.fetcher(`${runtimeUrl(this.options.env)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${init.token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as unknown : null;
    if (!response.ok) {
      const message = isRecord(body) && typeof body.error === "string" ? body.error : text.slice(0, 500);
      throw new RuntimeAgentError(`Agent runtime ${init.method ?? "GET"} ${path.split("?")[0]}: HTTP ${response.status} ${message}`, response.status);
    }
    return body;
  }

  /** The thread's runtime agent, created (idempotently, per thread) on first use. */
  private async agent(run?: RuntimeRunConfig): Promise<RuntimeAgentRecord> {
    const stored = this.options.store.agent();
    if (stored) return stored;
    const { env, identity } = this.options;
    const { systemPromptAppend } = await this.options.configuration();
    const config = run ?? await this.options.prepareRun();
    const created = await this.call("/v1/agents", {
      method: "POST",
      token: env.AGENT_RUNTIME_API_TOKEN ?? "",
      headers: { "Idempotency-Key": `thread_${identity.threadId}` },
      body: {
        definition: env.AGENT_RUNTIME_DEFINITION,
        name: identity.threadId,
        type: "camelai-thread",
        ttlSeconds: null,
        model: config.model,
        ...(config.keyScope ? { keyScope: config.keyScope } : {}),
        ...(config.spendLimitUsd !== null ? { spendLimit: { usd: config.spendLimitUsd } } : {}),
        ...(config.modelHeaders ? { modelHeaders: config.modelHeaders } : {}),
        thinkingLevel: this.state.thinkingLevel,
        systemPromptAppend,
        fileTools: false,
        ...(identity.subject ? { subject: identity.subject } : {}),
        context: { org: identity.orgId, workspace: identity.workspaceId, thread: identity.threadId },
      },
    }) as { id?: unknown; token?: unknown };
    if (typeof created.id !== "string" || typeof created.token !== "string") {
      throw new RuntimeAgentError("Agent runtime returned no agent id or token");
    }
    const record = { id: created.id, token: created.token, model: config.model, keyScope: config.keyScope };
    this.options.store.saveAgent(record);
    return record;
  }

  /**
   * Before a run: follow the thread's route (model, key scope and the model
   * headers that go with it) and set the
   * run's spend limit, in one configuration change the runtime applies before
   * the run.
   */
  private async configureRun(agent: RuntimeAgentRecord, run: RuntimeRunConfig): Promise<void> {
    await this.call(`/v1/agents/${agent.id}/configuration`, {
      method: "PATCH",
      token: this.options.env.AGENT_RUNTIME_API_TOKEN ?? "",
      body: {
        requestId: `run_${crypto.randomUUID()}`,
        spendLimit: run.spendLimitUsd === null ? null : { usd: run.spendLimitUsd },
        ...(agent.model !== run.model ? { model: run.model, thinkingLevel: this.state.thinkingLevel } : {}),
        ...((agent.keyScope ?? null) !== run.keyScope ? { keyScope: run.keyScope, modelHeaders: run.modelHeaders } : {}),
      },
    });
    if (agent.model !== run.model || (agent.keyScope ?? null) !== run.keyScope) {
      this.options.store.saveAgent({ ...agent, model: run.model, keyScope: run.keyScope });
    }
  }

  private async request(method: string, params: Record<string, unknown>, id: string = crypto.randomUUID()) {
    const agent = await this.agent();
    return await this.call(`/clients/${agent.id}/requests`, {
      method: "POST",
      token: agent.token,
      body: { id, method, params },
    });
  }

  /**
   * The agent's live event cursor, read before each run: event ids restart at
   * a new base when the runtime unloads an idle agent and loads it again, so a
   * cursor kept from an earlier run can fall below its buffer.
   */
  private async currentCursor(agent: RuntimeAgentRecord): Promise<number> {
    const state = await this.call(`/clients/${agent.id}/state`, { token: agent.token }) as { cursor?: unknown };
    return typeof state.cursor === "number" ? state.cursor : 0;
  }

  private async emit(event: Record<string, unknown>) {
    const localized = localizeEvent(event) as unknown as AgentEvent & { message?: AgentMessage; toolCallId?: string };
    const details = (value: unknown) => (isRecord(value) && isRecord(value.details) ? value.details : undefined);
    // A call waiting on a person gets a placeholder result that the answer later replaces.
    if (localized.type === "tool_execution_end" && details((localized as { result?: unknown }).result)?.inputRequired) return;
    if (localized.type === "message_end" && (localized.message as { role?: string })?.role === "toolResult" && details(localized.message)?.inputRequired) return;
    if (localized.type === "agent_start" && this.resuming) return;
    if (localized.type === "agent_end") {
      // Emitted once the response says whether the run finished or suspended.
      this.heldAgentEnd = localized as unknown as Record<string, unknown>;
      return;
    }
    // A resumed call's result arrives as a message only: show it as the tool's end first.
    if (this.resuming && localized.type === "message_end" && (localized.message as { role?: string })?.role === "toolResult") {
      const result = localized.message as unknown as { toolCallId: string; toolName: string; content: unknown; details?: unknown; isError?: boolean };
      await this.emit({
        type: "tool_execution_end",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: { content: result.content, details: result.details },
        isError: result.isError === true,
      });
    }
    switch (localized.type) {
      case "agent_start":
        this.state.isStreaming = true;
        break;
      case "message_start":
        if ((localized.message as { role?: string } | undefined)?.role === "assistant") this.state.streamingMessage = localized.message;
        break;
      case "message_end": {
        let message = localized.message as AgentMessage;
        if ((message as { role?: string }).role === "user") {
          // Keep the DO's stamped copy (render id, metadata) of what it sent.
          // Run instructions may precede the text the DO sent.
          const index = this.sentUserMessages.findIndex((sent) => userText(message).endsWith(userText(sent)));
          if (index >= 0) [message] = this.sentUserMessages.splice(index, 1);
          localized.message = message;
        }
        if ((message as { role?: string }).role === "assistant") this.state.streamingMessage = undefined;
        this.state.messages.push(message);
        break;
      }
      case "tool_execution_start":
        if (localized.toolCallId) this.state.pendingToolCalls.add(localized.toolCallId);
        break;
      case "tool_execution_end":
        if (localized.toolCallId) this.state.pendingToolCalls.delete(localized.toolCallId);
        break;
    }
    for (const listener of [...this.listeners]) await listener(localized);
  }

  /**
   * Relay the agent's events from `cursor` until the response to `requestId`
   * arrives. Reconnects on a dropped stream; a replay gap (the runtime no
   * longer buffers the run's events) recovers the run's messages from history.
   */
  private async relay(agent: RuntimeAgentRecord, requestId: string, cursor: number): Promise<void> {
    let position = cursor;
    let backoffMs = 250;
    let gaps = 0;
    for (;;) {
      this.streamAbort = new AbortController();
      let response: Response;
      try {
        response = await this.fetcher(`${runtimeUrl(this.options.env)}/clients/${agent.id}/events`, {
          headers: { Authorization: `Bearer ${agent.token}`, Accept: "text/event-stream", "Last-Event-ID": String(position) },
          signal: this.streamAbort.signal,
        });
      } catch (error) {
        if (this.streamAbort.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(5000, backoffMs * 2);
        continue;
      }
      if (response.status === 409) {
        await response.body?.cancel();
        const resume = await this.recoverFromHistory(agent, requestId);
        if (resume === null) return;
        // The run is still going: relay the rest of it from the live cursor.
        if (++gaps > MAX_REPLAY_GAPS) throw new RuntimeAgentError("Agent runtime event stream kept losing its place");
        position = resume;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if ([401, 403, 404, 410].includes(response.status)) {
          throw new RuntimeAgentError(`Agent runtime event stream: HTTP ${response.status}`, response.status);
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(5000, backoffMs * 2);
        continue;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          if (buffer.length > FRAME_LIMIT_BYTES) throw new RuntimeAgentError("Agent runtime event frame too large");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = raw.split("\n");
            const idLine = lines.find((line) => line.startsWith("id:"));
            const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            // `ready`, heartbeats, and the runtime's live MCP relay carry no id.
            if (!idLine || !data) {
              this.options.onActivity?.();
              continue;
            }
            const id = Number(idLine.slice(3));
            if (!Number.isSafeInteger(id) || id <= position) continue;
            position = id;
            const frame = JSON.parse(data) as ClientFrame;
            if (frame.type === "event" && isRecord(frame.event)) {
              // Runtime notices (turn_resumed, file_presented, …) carry no Pi shape; the DO ignores unknown types.
              if (frame.requestId === requestId || frame.requestId === "") await this.emit(frame.event);
            } else if (frame.type === "response" && frame.id === requestId) {
              const resume = await this.answerInputs(agent, frame.outcome);
              if (resume) {
                // The turn goes on in the resume run: keep relaying, now for it.
                requestId = resume;
                this.options.store.saveRun({ requestId, cursor: position });
                this.heldAgentEnd = null;
                this.resuming = true;
                continue;
              }
              this.resuming = false;
              await this.settle(frame.outcome);
              return;
            }
          }
        }
      } catch (error) {
        if (this.streamAbort.signal.aborted) return;
        if (error instanceof RuntimeAgentError) throw error;
      } finally {
        reader.releaseLock();
      }
      backoffMs = 250;
    }
  }

  /**
   * A run that suspended for input (`stopped: "input_required"`): ask the
   * thread's user each input and answer it, and return the resume run the
   * last answer starts. Null when the run did not suspend, or when an input
   * goes unanswered (the turn then ends; the runtime keeps the input pending
   * until the next message supersedes it).
   */
  private async answerInputs(
    agent: RuntimeAgentRecord,
    outcome: { result?: unknown } | undefined,
  ): Promise<string | null> {
    const result = isRecord(outcome?.result) ? outcome.result : undefined;
    const inputs = result?.stopped === "input_required" && Array.isArray(result.inputs)
      ? (result.inputs as RuntimeInput[]).filter((input) => isRecord(input) && typeof input.id === "string")
      : [];
    if (inputs.length === 0 || !this.options.answerInput) return null;
    this.inputAbort = new AbortController();
    let resume: string | null = null;
    // The runtime lets the run's actor answer (the thread's user who sent it);
    // chiridion already checked who may use the chat.
    const actor = this.options.actor();
    try {
      for (const input of inputs) {
        const answer = await this.options.answerInput(input, this.inputAbort.signal);
        const answered = await this.call(`/v1/agents/${agent.id}/inputs/${encodeURIComponent(input.id)}`, {
          method: "POST",
          token: this.options.env.AGENT_RUNTIME_API_TOKEN ?? "",
          body: { ...answer, ...(actor ? { actor } : {}) },
        }) as { request?: { id?: unknown } | null };
        if (typeof answered.request?.id === "string") resume = answered.request.id;
      }
    } catch (error) {
      if (!this.inputAbort.signal.aborted) console.error("[RuntimeAgentSession] input not answered", error);
      return null;
    } finally {
      this.inputAbort = null;
    }
    return resume;
  }

  /**
   * The run ended: make sure the DO sees an agent_end even when the runtime
   * refused the run outright, and say why a turn stopped at its spend limit
   * (the runtime ends it quietly after the response that crossed it).
   */
  private async settle(outcome: { error?: string; result?: unknown } | undefined) {
    const held = this.heldAgentEnd;
    this.heldAgentEnd = null;
    if (held && isRecord(outcome?.result) && outcome.result.stopped === "spend_limit") {
      const notice = errorAssistant(this.state.model, SPEND_LIMIT_MESSAGE);
      await this.emit({ type: "message_start", message: notice });
      await this.emit({ type: "message_end", message: notice });
      held.messages = [...(Array.isArray(held.messages) ? held.messages : []), notice];
    }
    if (held) {
      this.sawAgentEnd = true;
      this.state.isStreaming = false;
      for (const listener of [...this.listeners]) await listener(held as unknown as AgentEvent);
      return;
    }
    if (this.sawAgentEnd) return;
    const failure = errorAssistant(this.state.model, outcome?.error || "The agent run ended without a result");
    await this.emit({ type: "message_start", message: failure });
    await this.emit({ type: "message_end", message: failure });
    await this.emit({ type: "turn_end", message: failure, toolResults: [] });
    this.heldAgentEnd = { type: "agent_end", messages: [failure] };
    await this.settle(outcome);
  }

  /**
   * Replay gap: take the run's messages from the agent's history. A finished
   * run is closed out (null); one still going returns the live cursor to
   * relay the rest of it from.
   */
  private async recoverFromHistory(agent: RuntimeAgentRecord, requestId: string): Promise<number | null> {
    const history = await this.call(`/clients/${agent.id}/history`, { token: agent.token }) as { messages?: AgentMessage[] };
    const status = await this.call(`/clients/${agent.id}/requests/${encodeURIComponent(requestId)}`, { token: agent.token }) as {
      outcome?: { error?: string };
      prompt?: string;
    };
    const messages = (history.messages ?? []).map(localizeMessage);
    const promptText = typeof status.prompt === "string" ? status.prompt : null;
    let start = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as { role?: string };
      if (message.role === "user" && (promptText === null || userText(messages[index]) === promptText)) {
        start = index;
        break;
      }
    }
    const runMessages = start >= 0 ? messages.slice(start) : [];
    const known = new Set(this.state.messages.map((message) => JSON.stringify(localizeMessage(message))));
    this.state.messages.push(...runMessages.filter((message) => !known.has(JSON.stringify(message))));
    const last = [...runMessages].reverse().find((message) => (message as { role?: string }).role === "assistant");
    if (last) await this.emit({ type: "turn_end", message: last, toolResults: [] });
    if (status.outcome) {
      if (!this.heldAgentEnd) this.heldAgentEnd = { type: "agent_end", messages: runMessages };
      await this.settle(status.outcome);
      return null;
    }
    return await this.currentCursor(agent);
  }

  private async run(method: "prompt" | "continue", params: Record<string, unknown>) {
    const config = await this.options.prepareRun();
    const agent = await this.agent(config);
    await this.configureRun(agent, config);
    const cursor = await this.currentCursor(agent);
    const requestId = crypto.randomUUID();
    this.options.store.saveRun({ requestId, cursor });
    this.sawAgentEnd = false;
    this.state.isStreaming = true;
    try {
      await this.request(method, params, requestId);
      await this.relay(agent, requestId, cursor);
    } finally {
      this.options.store.saveRun(null);
      this.state.isStreaming = false;
      this.streamAbort = null;
    }
  }

  prompt(message: AgentMessage): Promise<void> {
    const actor = this.options.actor();
    this.sentUserMessages.push(message);
    const instructions = this.options.runInstructions?.();
    const text = instructions ? `${instructions}\n\n${userText(message)}` : userText(message);
    const promise = this.run("prompt", { text, ...(actor ? { actor } : {}) });
    this.running = promise.catch(() => undefined);
    return promise;
  }

  /**
   * Resume after a DO restart: relay the run in flight from its start cursor
   * (the DO rebuilds the stream from a replay), or, with none, do nothing; the
   * runtime already finished or never took it.
   */
  async continue(): Promise<void> {
    const run = this.options.store.run();
    const agent = this.options.store.agent();
    this.sawAgentEnd = false;
    const accepted = run && agent
      ? await this.call(`/clients/${agent.id}/requests/${encodeURIComponent(run.requestId)}`, { token: agent.token })
          .then(() => true, (error) => {
            if (error instanceof RuntimeAgentError && error.status === 404) return false;
            throw error;
          })
      : false;
    if (!run || !agent || !accepted) {
      // The DO stopped before the runtime took the message.
      this.options.store.saveRun(null);
      await this.settle({ error: "This message did not reach the agent. Please send it again." });
      return;
    }
    this.state.isStreaming = true;
    const promise = this.relay(agent, run.requestId, run.cursor).finally(() => {
      this.options.store.saveRun(null);
      this.state.isStreaming = false;
      this.streamAbort = null;
    });
    this.running = promise.catch(() => undefined);
    return promise;
  }

  steer(message: AgentMessage): void {
    this.sentUserMessages.push(message);
    // A steered message joins the run in flight, which keeps its actor.
    void this.request("steer", { text: userText(message) }).catch((error) => {
      console.error("[RuntimeAgentSession] steer failed", error);
    });
  }

  abort(): void {
    this.inputAbort?.abort();
    // The runtime ends the run (and cancels its tool calls); its agent_end and
    // response then arrive on the stream as usual.
    void this.request("abort", {}).catch((error) => {
      console.error("[RuntimeAgentSession] abort failed", error);
      this.streamAbort?.abort();
    });
  }

  /** Whether a run was started and not seen to its end (the DO may have restarted during it). */
  hasRunInFlight(): boolean {
    return this.options.store.run() !== null;
  }

  async waitForIdle(): Promise<void> {
    await this.running;
  }

  /** Stop relaying without touching the runtime (DO teardown). */
  dispose(): void {
    this.streamAbort?.abort();
    this.listeners.clear();
  }
}
