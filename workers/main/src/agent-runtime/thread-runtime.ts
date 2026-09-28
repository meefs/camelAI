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
import { SCRATCH_MOUNT, runtimeDirectThreadsEnabled as directThreadsEnabled, type RuntimeInputAnswer } from "../../../../src/lib/agent-runtime-shared";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import type { ThreadRuntimeRecord } from "../identity/org-do";
import { ChatThreadMetadata, type ChatThreadMetadataEnv } from "../chat-thread/metadata";
import { RUNTIME_PROMPT_VERSION, runtimeConfigured } from "../chat-thread/runtime-agent";
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
  return directThreadsEnabled(env);
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
 * What chiridion records on a runtime thread's user message (runtime
 * `metadata`, never shown to the model): its source, and the thread it
 * belongs to, so the run's webhook events route without a lookup.
 */
export function runtimeMessageMetadata(context: ChatContextState, source: string): Record<string, string> {
  return { source, org: context.orgId, workspace: context.workspaceId, thread: context.threadId };
}

/** Where a runtime agent's thread is, by agent id: for events of runs no chiridion message started. */
export function runtimeAgentThreadKey(agentId: string): string {
  return `agent-runtime:thread-of:${agentId}`;
}

async function rememberAgentThread(env: ChatEnv, agentId: string, context: ChatContextState): Promise<void> {
  await env.APP_KV.put(runtimeAgentThreadKey(agentId), JSON.stringify({
    org: context.orgId,
    workspace: context.workspaceId,
    thread: context.threadId,
  })).catch((error: unknown) => console.error("[runtime-thread] failed to remember an agent's thread", error));
}

/** The runtime's agent id for a provisioning key (its `agentId(tenant, key)`), to find an agent it already made. */
async function provisionedAgentId(tenant: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${tenant}:${key}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `client_${hex.slice(0, 40)}`;
}

/**
 * Create the thread's agent, idempotently per thread. When the runtime
 * answers that the key was used with a different configuration (the agent
 * definition changed since), adopt the agent it made then; the caller
 * reconfigures it. `adopted` says so.
 */
async function createThreadAgent(
  env: ChatEnv,
  context: ChatContextState,
  run: PreparedRuntimeRun,
): Promise<{ agentId: string; adopted: boolean }> {
  const key = `thread_${context.threadId}`;
  const thread = await orgStub(env, context.orgId).getThread(context.threadId);
  const subject = thread?.created_by?.trim() || context.userId || "";
  try {
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
    }, { "Idempotency-Key": key }) as { id?: unknown };
    if (typeof created?.id !== "string") throw new Error("Agent runtime returned no agent id");
    return { agentId: created.id, adopted: false };
  } catch (error) {
    if (!(error instanceof RuntimeApiError && error.status === 409 && /different configuration/i.test(error.message))) throw error;
    const tenant = env.AGENT_RUNTIME_TENANT?.trim() ?? "";
    const byKey = await provisionedAgentId(tenant, key);
    const found = await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(byKey)}`).then(() => byKey, () => null)
      ?? ((await runtimeApi(env, "GET", "/v1/agents")) as Array<{ id: string; name?: string }>)
        .find((agent) => agent.name === context.threadId)?.id
      ?? null;
    if (!found) throw error;
    return { agentId: found, adopted: true };
  }
}

/** Whether the agent is running a turn now, and whether it already has `requestId` (a retried send). */
async function agentActivity(env: ChatEnv, agentId: string, requestId: string): Promise<{ running: boolean; retried: boolean }> {
  const base = `/v1/agents/${encodeURIComponent(agentId)}`;
  const [state, retried] = await Promise.all([
    runtimeApi(env, "GET", `${base}/state`) as Promise<{ requests?: Array<{ state?: string; method?: string }> }>,
    runtimeApi(env, "GET", `${base}/requests/${encodeURIComponent(requestId)}`).then(() => true, (error) => {
      if (error instanceof RuntimeApiError && error.status === 404) return false;
      throw error;
    }),
  ]);
  const running = (state?.requests ?? []).some((request) =>
    request.state === "running" && ["prompt", "continue", "resume"].includes(request.method ?? ""));
  return { running, retried };
}

/**
 * The thread's agent, created (or adopted) on first use and configured for
 * this send where the model, key scope or spend limit changed.
 *
 * A spend limit is a budget from now: the runtime resets what was spent and
 * applies it at once, to a running turn too. So it is set only while the
 * agent is idle; a send during a turn (another member's, or a retry) leaves
 * the running turn's budget alone, and a retried request changes nothing.
 */
async function ensureConfiguredAgent(
  env: ChatEnv,
  context: ChatContextState,
  row: ThreadRuntimeRecord,
  run: PreparedRuntimeRun,
  requestId: string,
): Promise<string> {
  const org = orgStub(env, context.orgId);
  let agentId = row.agentId;
  /** An agent made under an earlier configuration (adopted): bring all of it up to date. */
  let stale = false;
  if (!agentId) {
    const made = await createThreadAgent(env, context, run);
    agentId = made.agentId;
    if (!made.adopted) {
      await org.setThreadRuntimeAgent(context.threadId, {
        agentId,
        model: run.model,
        keyScope: run.keyScope,
        configured: { thinkingLevel: run.thinkingLevel, spendLimitUsd: run.spendLimitUsd, promptVersion: RUNTIME_PROMPT_VERSION },
      });
      return agentId;
    }
    stale = true;
  }
  const { running, retried } = await agentActivity(env, agentId, requestId);
  if (retried) return agentId;
  const modelChanged = stale || row.model !== run.model;
  const scopeChanged = stale || (row.keyScope ?? null) !== run.keyScope;
  const lastLimit = (row.configured?.spendLimitUsd as number | null | undefined) ?? null;
  const setLimit = !running && (stale || run.spendLimitUsd !== null || lastLimit !== null);
  // Instructions from an earlier version (or none recorded): send the current ones.
  const promptChanged = stale || row.configured?.promptVersion !== RUNTIME_PROMPT_VERSION;
  if (!modelChanged && !scopeChanged && !setLimit && !promptChanged) return agentId;
  await runtimeApi(env, "PATCH", `/v1/agents/${encodeURIComponent(agentId)}/configuration`, {
    requestId: `run_${crypto.randomUUID()}`,
    ...(setLimit ? { spendLimit: run.spendLimitUsd === null ? null : { usd: run.spendLimitUsd } } : {}),
    ...(modelChanged ? { model: run.model, thinkingLevel: run.thinkingLevel } : {}),
    ...(scopeChanged ? { keyScope: run.keyScope, modelHeaders: run.modelHeaders } : {}),
    ...(promptChanged ? { systemPromptAppend: runtimeSystemPromptAppend(env, context) } : {}),
  });
  await org.setThreadRuntimeAgent(context.threadId, {
    agentId,
    model: run.model,
    keyScope: run.keyScope,
    configured: {
      thinkingLevel: modelChanged ? run.thinkingLevel : row.configured?.thinkingLevel ?? run.thinkingLevel,
      spendLimitUsd: setLimit ? run.spendLimitUsd : lastLimit,
      promptVersion: RUNTIME_PROMPT_VERSION,
    },
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
  const agentId = await ensureConfiguredAgent(env, context, input.row, run, input.clientMessageId);
  const name = resolveMessageAuthorDisplayName(sender.userName, sender.userEmail);
  let request: { id?: unknown };
  try {
    request = await runtimeApi(env, "POST", `/v1/agents/${encodeURIComponent(agentId)}/prompt`, {
      text: await modelText(env, context, text),
      from: { id: sender.userId, ...(name ? { name: name.slice(0, 200) } : {}) },
      actor: sender.userId,
      // Echoed on the user message: the page matches its optimistic bubble by it.
      requestId: input.clientMessageId,
      // A message sent while a turn runs joins it, as in the DO's chat; with
      // none running it starts one.
      whileRunning: "steer",
      // On the message and on the run's webhook events (routes/agent-runtime-events.ts).
      metadata: runtimeMessageMetadata(context, input.source ?? "web"),
    }) as { id?: unknown };
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status === 429) {
      return { status: "busy", error: "The agent has too many messages queued; try again when it finishes." };
    }
    throw error;
  }
  // Running/idle in the sidebar and end-of-turn work come from the runtime's
  // run events (routes/agent-runtime-events.ts), for every run however started;
  // runs no message of ours started (a resume after an input) find the thread here.
  input.waitUntil(rememberAgentThread(env, agentId, context));
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

/**
 * The thread's scratch volume: the one its agent mounts at /workspace, read
 * from the runtime once and kept on the thread's row. Null before the agent
 * exists, or when it has no such mount.
 */
export async function threadScratchVolume(
  env: ChatEnv,
  context: ChatContextState,
  row: ThreadRuntimeRecord,
): Promise<string | null> {
  const known = row.configured?.scratchVolumeId;
  if (typeof known === "string" && known) return known;
  if (!row.agentId) return null;
  const agent = await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(row.agentId)}`) as {
    mounts?: Array<{ volumeId?: string; path?: string; mode?: string }>;
  };
  const volumeId = agent.mounts?.find((mount) => mount.path === SCRATCH_MOUNT && typeof mount.volumeId === "string")?.volumeId;
  if (!volumeId) return null;
  await orgStub(env, context.orgId).setThreadRuntimeAgent(context.threadId, {
    agentId: row.agentId,
    model: row.model,
    keyScope: row.keyScope,
    configured: { ...row.configured, scratchVolumeId: volumeId },
  });
  return volumeId;
}

/** A scratch file's bytes from the runtime, as it answers (200, 206 for a range, 404). */
export async function fetchScratchFile(
  env: ChatEnv,
  volumeId: string,
  volumePath: string,
  range?: string | null,
): Promise<Response> {
  const encoded = volumePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return await fetch(`${runtimeUrl(env)}/v1/volumes/${encodeURIComponent(volumeId)}/files/${encoded}`, {
    headers: {
      Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`,
      ...(range ? { Range: range } : {}),
    },
  });
}

/** A short-lived link to a scratch file, which the runtime serves without a token (for import_file). */
export async function scratchFileLink(env: ChatEnv, volumeId: string, volumePath: string, expiresIn = 60): Promise<string> {
  const link = await runtimeApi(env, "POST", `/v1/volumes/${encodeURIComponent(volumeId)}/links`, {
    path: volumePath,
    method: "GET",
    expiresIn,
  }) as { url?: unknown };
  if (typeof link?.url !== "string") throw new Error("Agent runtime returned no link");
  return link.url;
}
