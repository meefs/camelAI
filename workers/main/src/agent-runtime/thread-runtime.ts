/**
 * Threads that run directly on the hosted agent runtime, with no
 * ChatThreadDO (plans/runtime-threads-direct.md §4). Chiridion keeps one
 * OrgDO row per thread (`thread_runtime`: the agent's id and the configuration
 * last applied) and no transcript; the browser reads the agent itself with a
 * short-lived browser token minted here. Every write goes through these
 * functions, which call the runtime's tenant API with chiridion's operator
 * token after the caller checked access.
 */
import { resolveMessageAuthorDisplayName } from "../../../../src/lib/message-author";
import type { RuntimeInputAnswer } from "../../../../src/lib/agent-runtime-shared";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import type { ThreadRuntimeRecord } from "../identity/org-do";
import { ChatThreadMetadata, type ChatThreadMetadataEnv } from "../chat-thread/metadata";
import { runtimeConfigured } from "../chat-thread/runtime-agent";
import { isOrgBanned } from "../ban-list";
import { injectFileSafetyMessage } from "../file-safety";
import { applyMentionContext } from "../mention-context";
import { WorkspaceFilesystemClient } from "../workspace-filesystem-do";
import { HOSTED_KEY_SCOPE } from "./key-scopes";
import { RuntimeApiError, runtimeApi, runtimeUrl } from "./runtime-api";
import { codexError, codexRoute, codexUpstreamCall, forwardedResponseHeaders } from "./codex-forwarder";
import { HostedModelFallbackRequiredError } from "../chat-thread/pi-model-config";
import { assertUserLlmUsageAccess, UserLlmUsageLimitError } from "../user-llm-usage-policy";
import {
  prepareThreadRuntimeRun,
  resolveThreadRuntimeRoute,
  RuntimeRunRefused,
  runtimeSystemPromptAppend,
  type PreparedRuntimeRun,
  type ThreadModelFallback,
} from "./run-gates";

/** How long a browser token lives; the watcher renews it a minute before. */
export const BROWSER_TOKEN_TTL_SECONDS = 900;

/**
 * The event types a thread viewer's token receives: the ones the watcher
 * folds messages from, plus what the chat shows live (tool progress, inputs,
 * compaction and retries). The runtime's own frames are never sent.
 */
export const BROWSER_TOKEN_EVENTS = [
  "agent_start", "agent_end", "turn_opened", "message_start", "message_update", "message_end",
  "message_retracted", "event_omitted",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "input_required", "input_resolved", "compaction_start", "compaction_end",
  "auto_retry_start", "auto_retry_end",
] as const;

export interface RuntimeThreadSender {
  userId: string;
  userName: string | null;
  userEmail: string | null;
}

export type RuntimeTurnResult =
  | { status: "accepted"; requestId: string; agentId: string; fallback: ThreadModelFallback | null }
  | { status: "busy" | "error"; error: string; code?: string };

/** Whether this deployment can run threads on the runtime (its tenant, token and definition). */
export function runtimeThreadsEnabled(env: Partial<ChatEnv>): boolean {
  return runtimeConfigured(env as Parameters<typeof runtimeConfigured>[0]);
}

/**
 * Whether new web threads run directly on the runtime here: the runtime
 * tenant is configured and AGENT_RUNTIME_DIRECT_THREADS is on (staging first).
 */
export function runtimeDirectThreadsEnabled(env: Partial<ChatEnv>): boolean {
  return runtimeThreadsEnabled(env) && env.AGENT_RUNTIME_DIRECT_THREADS?.trim() === "1";
}

/**
 * Pin a new thread to the runtime, when direct threads are on here and its
 * model has a runtime route (custom endpoints and self-host providers stay on
 * ChatThreadDO). The row is the thread's backend from then on. Null: it runs
 * on ChatThreadDO.
 */
export async function pinNewThreadToRuntime(env: ChatEnv, context: ChatContextState): Promise<ThreadRuntimeRecord | null> {
  if (!runtimeDirectThreadsEnabled(env)) return null;
  let route: Awaited<ReturnType<typeof resolveThreadRuntimeRoute>>["route"];
  try {
    ({ route } = await resolveThreadRuntimeRoute(env, context));
  } catch (error) {
    console.warn("[runtime-thread] new thread stays on ChatThreadDO: its model did not resolve", error);
    return null;
  }
  if (!route) return null;
  const org = orgStub(env, context.orgId);
  if (!await org.pinThreadRuntime(context.threadId)) return null;
  return await org.getThreadRuntime(context.threadId);
}

function orgStub(env: ChatEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as {
    getThread(id: string): Promise<{ created_by?: string | null } | null>;
    getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
    pinThreadRuntime(threadId: string): Promise<boolean>;
    setThreadRuntimeAgent(threadId: string, update: {
      agentId: string;
      model: string | null;
      keyScope: string | null;
      configured?: Record<string, unknown> | null;
    }): Promise<ThreadRuntimeRecord | null>;
    getWorkspaceIntegrations(workspaceId: string): Promise<Parameters<typeof applyMentionContext>[1]["integrations"]>;
  };
}

/** The user's text as the model gets it: the file-safety notice and @-mention context, when they apply. */
async function modelText(env: ChatEnv, context: ChatContextState, text: string): Promise<string> {
  const safe = injectFileSafetyMessage(text);
  if (!safe.includes("@")) return safe;
  const [integrations, projects] = await Promise.all([
    orgStub(env, context.orgId).getWorkspaceIntegrations(context.workspaceId).catch((error) => {
      console.error("[runtime-thread] getWorkspaceIntegrations for mentions failed", error);
      return [];
    }),
    new WorkspaceFilesystemClient(env, context.workspaceId).listProjects().catch((error) => {
      console.error("[runtime-thread] listProjects for mentions failed", error);
      return [];
    }),
  ]);
  return applyMentionContext(safe, { integrations, projects }).content;
}

/**
 * The thread's agent: the one on its row, or a new one (idempotent per
 * thread, so concurrent first sends get the same agent), then configured for
 * this run where the model, key scope or spend limit changed.
 */
async function ensureConfiguredAgent(
  env: ChatEnv,
  context: ChatContextState,
  row: ThreadRuntimeRecord,
  run: PreparedRuntimeRun,
): Promise<string> {
  const org = orgStub(env, context.orgId);
  let agentId = row.agentId;
  if (!agentId) {
    const thread = await org.getThread(context.threadId);
    const subject = thread?.created_by?.trim() || context.userId || "";
    const created = await runtimeApi(env, "POST", "/v1/agents", {
      definition: env.AGENT_RUNTIME_DEFINITION,
      name: context.threadId,
      type: "camelai-thread",
      ttlSeconds: null,
      model: run.model,
      ...(run.keyScope ? { keyScope: run.keyScope } : {}),
      ...(run.spendLimitUsd !== null ? { spendLimit: { usd: run.spendLimitUsd } } : {}),
      ...(run.modelHeaders ? { modelHeaders: run.modelHeaders } : {}),
      thinkingLevel: run.thinkingLevel,
      systemPromptAppend: runtimeSystemPromptAppend(env, context),
      fileTools: false,
      ...(subject ? { subject } : {}),
      context: { org: context.orgId, workspace: context.workspaceId, thread: context.threadId },
    }, { "Idempotency-Key": `thread_${context.threadId}` }) as { id?: unknown };
    if (typeof created?.id !== "string") throw new Error("Agent runtime returned no agent id");
    agentId = created.id;
    await org.setThreadRuntimeAgent(context.threadId, {
      agentId,
      model: run.model,
      keyScope: run.keyScope,
      configured: { thinkingLevel: run.thinkingLevel, spendLimitUsd: run.spendLimitUsd },
    });
    return agentId;
  }
  const modelChanged = row.model !== run.model;
  const scopeChanged = (row.keyScope ?? null) !== run.keyScope;
  const lastLimit = row.configured?.spendLimitUsd ?? null;
  // A spend limit is a budget from now: set before every run that has one.
  if (!modelChanged && !scopeChanged && run.spendLimitUsd === null && lastLimit === null) return agentId;
  await runtimeApi(env, "PATCH", `/v1/agents/${encodeURIComponent(agentId)}/configuration`, {
    requestId: `run_${crypto.randomUUID()}`,
    spendLimit: run.spendLimitUsd === null ? null : { usd: run.spendLimitUsd },
    ...(modelChanged ? { model: run.model, thinkingLevel: run.thinkingLevel } : {}),
    ...(scopeChanged ? { keyScope: run.keyScope, modelHeaders: run.modelHeaders } : {}),
  });
  await org.setThreadRuntimeAgent(context.threadId, {
    agentId,
    model: run.model,
    keyScope: run.keyScope,
    configured: { thinkingLevel: modelChanged ? run.thinkingLevel : row.configured?.thinkingLevel ?? run.thinkingLevel, spendLimitUsd: run.spendLimitUsd },
  });
  return agentId;
}

/**
 * Send a user's message to a runtime thread (plans/runtime-threads-direct.md
 * §4.2): the ban check, the run gates as the sender, the agent created or
 * configured, then `prompt` with `requestId` = the client's message id, so a
 * retry is the same request. A message sent while a turn runs is queued as
 * the next turn. Thread bookkeeping (last message, title) runs after, in
 * `waitUntil`.
 */
export async function startRuntimeTurn(
  env: ChatEnv,
  input: {
    context: ChatContextState;
    row: ThreadRuntimeRecord;
    sender: RuntimeThreadSender;
    text: string;
    clientMessageId: string;
    source?: string;
    waitUntil(promise: Promise<unknown>): void;
  },
): Promise<RuntimeTurnResult> {
  const { context, sender } = input;
  const text = input.text.trim();
  if (!text) return { status: "error", error: "Empty message" };
  if (await isOrgBanned(env.APP_KV, { orgId: context.orgId })) {
    return { status: "error", error: "Organization is blocked" };
  }
  let run: PreparedRuntimeRun;
  try {
    run = await prepareThreadRuntimeRun(env, context, sender.userId);
  } catch (error) {
    if (error instanceof RuntimeRunRefused) return { status: "error", error: error.message, code: error.code };
    throw error;
  }
  const agentId = await ensureConfiguredAgent(env, context, input.row, run);
  const name = resolveMessageAuthorDisplayName(sender.userName, sender.userEmail);
  let request: { id?: unknown };
  try {
    request = await runtimeApi(env, "POST", `/v1/agents/${encodeURIComponent(agentId)}/prompt`, {
      text: await modelText(env, context, text),
      from: { id: sender.userId, ...(name ? { name: name.slice(0, 200) } : {}) },
      actor: sender.userId,
      requestId: input.clientMessageId,
      // Once the runtime takes them: `whileRunning: "steer"` (join a running
      // turn instead of queueing the next one) and `meta: {source,
      // clientMessageId}` (the page then matches its bubble by id, not text).
    }) as { id?: unknown };
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status === 429) {
      return { status: "busy", error: "The agent has too many messages queued; try again when it finishes." };
    }
    throw error;
  }
  // Running/idle in the sidebar and end-of-turn work wait for the runtime's
  // lifecycle webhook (run.started / run.finished); nothing sets them here.
  input.waitUntil(
    threadMetadata(env, context, input.waitUntil).updateThreadMetadataForUserMessage(text, input.source ?? "web").catch((error) => {
      console.error("[runtime-thread] failed to update thread metadata after a user message", error);
    }),
  );
  return {
    status: "accepted",
    requestId: typeof request?.id === "string" ? request.id : input.clientMessageId,
    agentId,
    fallback: run.fallback,
  };
}

/** Thread titles and first-message bookkeeping, as ChatThreadDO does them, without its live state. */
function threadMetadata(env: ChatEnv, context: ChatContextState, waitUntil: (promise: Promise<unknown>) => void): ChatThreadMetadata {
  let titleInFlight = false;
  return new ChatThreadMetadata({
    chatContext: () => context,
    env: () => env as unknown as ChatThreadMetadataEnv,
    waitUntil,
    titleGenerationInFlight: () => titleInFlight,
    setTitleGenerationInFlight: (value) => { titleInFlight = value; },
    setAssistantCompletionRecordedAt: () => {},
    setAssistantCompletionSummaryRequestedAt: () => {},
    // The page reads the title from OrgDO; nothing live to update here.
    setTitle: async () => {},
    broadcastChat: () => {},
    recordWorkspaceThreadStreaming: async () => {},
    retryChatDurableObjectRpc: (_operation, fn) => fn(),
    recordChatThreadObservabilityEvent: () => {},
  });
}

export interface BrowserToken {
  token: string;
  expiresAt: number;
  agentId: string;
  url: string;
}

/**
 * A read-only token for one thread's agent, for `userId`'s browser: events,
 * state, history and inputs, for 15 minutes. Hosted-key threads do not show
 * the provider's cost.
 */
export async function mintRuntimeBrowserToken(
  env: ChatEnv,
  row: ThreadRuntimeRecord & { agentId: string },
  userId: string,
): Promise<BrowserToken> {
  const minted = await runtimeApi(env, "POST", `/v1/agents/${encodeURIComponent(row.agentId)}/browser-tokens`, {
    ttlSeconds: BROWSER_TOKEN_TTL_SECONDS,
    scopes: ["events", "state", "history", "inputs"],
    events: [...BROWSER_TOKEN_EVENTS],
    ...(row.keyScope === null || row.keyScope === HOSTED_KEY_SCOPE ? { redact: ["usage.cost"] } : {}),
    subject: userId,
  }) as { token: string; expiresAt: number; url?: string };
  return {
    token: minted.token,
    expiresAt: minted.expiresAt,
    agentId: row.agentId,
    url: (minted.url || runtimeUrl(env)).replace(/\/+$/, ""),
  };
}

/** One page of the agent's history, newest first page without `before` (the runtime's turn-aligned paging). */
export async function runtimeHistoryPage(
  env: ChatEnv,
  agentId: string,
  page: { limit?: number; before?: number | null } = {},
): Promise<{ entries: Array<{ index: number; message: unknown }>; next: number | null; total?: number }> {
  const params = new URLSearchParams({ limit: String(page.limit ?? 50) });
  if (typeof page.before === "number") params.set("before", String(page.before));
  return await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(agentId)}/history?${params}`) as {
    entries: Array<{ index: number; message: unknown }>;
    next: number | null;
    total?: number;
  };
}

/** Answer a human input the agent waits on, as `userId` (the runtime checks they may). */
export async function answerRuntimeInput(
  env: ChatEnv,
  agentId: string,
  inputId: string,
  answer: RuntimeInputAnswer,
  sender: RuntimeThreadSender,
): Promise<{ status: number; body: unknown }> {
  const name = resolveMessageAuthorDisplayName(sender.userName, sender.userEmail);
  try {
    const body = await runtimeApi(env, "POST", `/v1/agents/${encodeURIComponent(agentId)}/inputs/${encodeURIComponent(inputId)}`, {
      action: answer.action,
      ...(answer.content !== undefined ? { content: answer.content } : {}),
      from: { id: sender.userId, ...(name ? { name: name.slice(0, 200) } : {}) },
    });
    return { status: 200, body };
  } catch (error) {
    if (error instanceof RuntimeApiError && [400, 403, 404, 409].includes(error.status)) {
      return { status: error.status, body: { error: error.message } };
    }
    throw error;
  }
}

/** Stop the agent's running turn (its tool calls are cancelled; the stream shows the end). */
export async function abortRuntimeThread(env: ChatEnv, agentId: string): Promise<void> {
  await runtimeApi(env, "POST", `/v1/agents/${encodeURIComponent(agentId)}/abort`);
}

/**
 * One Codex call of a runtime thread's agent (routes/agent-runtime-llm.ts),
 * as ChatThreadDO.runtimeProviderRequest does it for the threads it hosts:
 * the acting user's limits, the org's ChatGPT subscription swapped in for the
 * runtime's credentials, and the bytes passed through both ways.
 */
export async function forwardRuntimeThreadCodexCall(
  env: ChatEnv,
  request: { provider: string; path: string; search: string; method: string; headers: [string, string][]; body: ArrayBuffer | null },
  caller: { orgId: string; workspaceId: string; threadId: string; userId: string },
): Promise<Response> {
  if (request.provider !== "openai-codex") {
    return codexError(404, `chiridion forwards only openai-codex, not ${request.provider}`, "not_found");
  }
  const context: ChatContextState = { ...caller, userName: null, userEmail: null };
  let config: Awaited<ReturnType<typeof resolveThreadRuntimeRoute>>["config"];
  try {
    ({ config } = await resolveThreadRuntimeRoute(env, context));
    if (caller.userId) {
      await assertUserLlmUsageAccess(env.ORG.get(env.ORG.idFromName(caller.orgId)) as never, {
        env,
        orgId: caller.orgId,
        workspaceId: caller.workspaceId,
        threadId: caller.threadId,
        userId: caller.userId,
        provider: config.usageProvider || config.model.provider,
        model: config.model.id,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UserLlmUsageLimitError) return codexError(429, message, "usage_limit");
    if (error instanceof HostedModelFallbackRequiredError) return codexError(402, message, "insufficient_credits");
    throw error;
  }
  const route = codexRoute(config);
  if (!route) {
    return codexError(409, "This thread's model no longer uses the ChatGPT subscription; send the message again.", "route_mismatch");
  }
  const body = request.body ? new Uint8Array(request.body) : new Uint8Array(0);
  const call = codexUpstreamCall(route, request.path, request.search, request.headers, body);
  if ("error" in call) return codexError(409, call.error, "route_mismatch");
  const upstream = await fetch(call.url, {
    method: request.method,
    headers: call.headers,
    // The bytes as the runtime sent them (zstd).
    body: body.byteLength > 0 ? body : undefined,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardedResponseHeaders(upstream.headers),
  });
}
