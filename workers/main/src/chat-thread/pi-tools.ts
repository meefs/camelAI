// Pi tool-definition surface for ChatThreadDO, extracted as free functions
// with explicit deps: the executor-style top-level tool list (file/
// js_exec/subagent + passthrough tools), the Agent/Explore subagent runner,
// and the subagent system prompt. `PiToolSurfaceDeps` members are the DO
// operations the tools invoke; sibling steps (createPiToolDefinitions /
// runPiSubagentTool / createPiSubagentSystemPrompt) arrive as injected
// callbacks that route back through the owning DO's same-named delegates, so
// dynamic dispatch (and every `ChatThreadDO.prototype['method'].call(fake)`
// test seam that stubs a sibling on the fake) behaves exactly as it did when
// the bodies lived on the DO.
import { Type } from "typebox";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  CODE_MODE_DEFAULT_TIMEOUT_MS,
  CODE_MODE_MAX_TIMEOUT_MS,
  CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS,
  CODE_MODE_TOOL_DEFINITIONS,
  type CodeModeToolsBinding,
} from "../code-mode-tools";
import { PI_CONTAINER_TOOL_DEFINITIONS } from "../pi-container-tools";
import {
  PI_SKILL_DESCRIPTIONS,
  PI_SKILL_NAMES,
} from "../pi-skills-bundle";
import { createPiSubagentSystemPrompt as buildPiSubagentSystemPrompt } from "../pi-system-prompt";
import {
  extractToolContent,
  extractLatestPiAssistantText,
  extractPiMessageText,
} from "./pi-message-helpers";
import type {
  PiBillingSource,
  PiResolvedModelConfig,
} from "./pi-model-config";
import type {
  ChatContextState,
  CodeModeJavascriptRequest,
  CodeModeJavascriptResult,
} from "./types";
import type { HostedCapability } from "../../../../src/lib/capability-allowances";

export interface PiToolDefinitionOptions {
  includeSubagents?: boolean;
  includeResearch?: boolean;
  includeOracle?: boolean;
}

const RESEARCH_CAPABILITY_MODEL = "deepseek-v4-auto";
const ORACLE_CAPABILITY_MODEL = "gpt-5.6-luna";

type ChildToolActivity = {
  toolCallId: string;
  toolName: string;
  label: string;
  status: "running" | "complete" | "error";
};

function stringToolArg(args: unknown, ...names: string[]): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function truncateActivityDetail(value: string, max = 72): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

/** Keep the real child tool name visible, with only a small useful argument summary. */
export function describeChildAgentActivity(toolName: string, args?: unknown): string {
  const normalized = toolName.toLowerCase();
  let detail = "";
  if (["read", "write", "edit", "delete", "ls", "find", "grep", "glob"].includes(normalized)) {
    detail = stringToolArg(args, "path", "file_path", "pattern");
  } else if (["javascript", "js_exec"].includes(normalized)) {
    detail = stringToolArg(args, "description");
  } else if (["websearch", "web_search"].includes(normalized)) {
    detail = stringToolArg(args, "query");
  } else if (["webfetch", "web_fetch"].includes(normalized)) {
    detail = stringToolArg(args, "url");
  } else if (["create_project", "build_project", "deploy_project"].includes(normalized)) {
    detail = stringToolArg(args, "project", "name", "script_name");
  } else if (normalized === "take_screenshot") {
    detail = stringToolArg(args, "script_name");
  }
  return detail ? `${toolName} · ${truncateActivityDetail(detail)}` : toolName;
}

function createAgentProgressReporter(
  onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
) {
  const activities: string[] = [];
  const toolActivities: ChildToolActivity[] = [];
  const emit = (activity: string, details: Record<string, unknown> = {}) => {
    onUpdate?.({
      content: [{ type: "text", text: `${activity}\n` }],
      details: { status: "running", activity, ...details },
    });
  };
  return {
    activities,
    toolActivities,
    reportStatus(activity: string, details: Record<string, unknown> = {}) {
      emit(activity, details);
    },
    startTool(
      toolCallId: string,
      toolName: string,
      args: unknown,
      details: Record<string, unknown> = {},
    ) {
      const label = describeChildAgentActivity(toolName, args);
      const activity: ChildToolActivity = {
        toolCallId,
        toolName,
        label,
        status: "running",
      };
      activities.push(label);
      toolActivities.push(activity);
      emit(label, { ...details, toolActivity: activity });
    },
    finishTool(toolCallId: string, isError: boolean) {
      for (let index = toolActivities.length - 1; index >= 0; index -= 1) {
        const activity = toolActivities[index];
        if (activity?.toolCallId !== toolCallId) continue;
        activity.status = isError ? "error" : "complete";
        break;
      }
    },
  };
}

// Passthrough harness tools in these categories are NOT advertised in the model's
// top-level tool list. They remain fully callable inside js_exec via `tools.<name>()`
// and discoverable through `tools.search()` / `tools.help()`; we simply stop spending
// per-turn context on their schemas (the executor-style "search → describe → call"
// approach). These are long-tail, rarely-needed tools the agent reliably rediscovers
// by category; the app/project lifecycle categories (workspace, apps, user_interaction,
// web, agents) intentionally STAY top-level, because dropping them led the agent to
// guess tool names on complex build+deploy tasks instead of searching.
const TOP_LEVEL_EXCLUDED_CATEGORIES = new Set<string>([
  "workflows",
  "schedules",
  "integrations",
  "domains",
  "connections",
  "communication",
]);

// Passthrough tools that always stay top-level even though their category is excluded:
// they block on human input and so cannot run inside js_exec's short-lived sandbox.
// Keep in sync with the js_exec-excluded names in code-mode-tools.ts.
const ALWAYS_TOP_LEVEL_PASSTHROUGH_NAMES = new Set<string>([
  "prompt_connection_setup",
  "delete_connection",
  "delete_project",
  "AskUserQuestion",
]);

// The names-only inventory of tools reachable only inside js_exec (executor's
// "Available integrations" pattern): names are cheap in the cached prompt prefix
// and directly prevent tool-name guessing, while the schemas stay behind
// tools.search()/tools.describe(). Computed over the full catalog (not just the
// passthrough list — communication tools like send_email were never advertised
// top-level) so it can never drift from the actual top-level exclusion.
const JS_EXEC_ONLY_TOOL_INVENTORY = (() => {
  const byCategory = new Map<string, string[]>();
  for (const definition of CODE_MODE_TOOL_DEFINITIONS) {
    if (definition.hidden) continue;
    if (ALWAYS_TOP_LEVEL_PASSTHROUGH_NAMES.has(definition.name)) continue;
    if (!TOP_LEVEL_EXCLUDED_CATEGORIES.has(definition.category)) continue;
    const names = byCategory.get(definition.category) ?? [];
    names.push(definition.name);
    byCategory.set(definition.category, names);
  }
  return [...byCategory.entries()]
    .map(([category, names]) => `${category}: ${names.join(", ")}`)
    .join("; ");
})();

// The js_exec tool description, kept executor-style small: a one-line intro, a
// pointer to the on-demand guide (`await tools.help()` inside the sandbox), the
// search → describe → call recipe, and the names-only inventory above. The
// long-form usage guidance lives in JS_EXEC_GUIDE in code-mode-runner.ts so it
// is fetched only when the model actually writes code, instead of sitting in
// every turn's prompt prefix.
const JS_EXEC_DESCRIPTION =
  "Run JavaScript or TypeScript (types are stripped) in a Worker-style sandbox with every workspace tool on the global `tools` object plus runtime bindings (`env.CONNECTIONS`, `env.AI`, `env.CAMELAI`, `env.WORKSPACE`, `env.PROJECTS`). The final expression is returned and console output is captured. " +
  "Before writing non-trivial code, run `await tools.help()` once — it returns the full usage guide (file locations, projects, connections, hosted helpers) plus the tool catalog by category. " +
  "NEVER guess a tool name: `await tools.search(\"<intent + key nouns>\")`, then `await tools.describe(items[0].name)`, then invoke as the result's `call` field shows (kind \"tool\" runs as `await tools.<name>(args)`; kind \"runtime\" results are sandbox globals, never on `tools`). " +
  "Every `tools.<name>(args)` call resolves to `{ ok: true, data }` or `{ ok: false, error: { message } }` — branch on `result.ok` instead of try/catch; failed calls do not throw, so you can describe the tool and retry in the same run. " +
  `Tools reachable ONLY here (not in your tool list) — ${JS_EXEC_ONLY_TOOL_INVENTORY}. ` +
  "`deploy_project` returns the live app URL and automatically opens a successful deploy in preview, so no manual `set_preview` or `list_apps` call is needed; `set_preview` remains available for an explicit preview switch. " +
  "Interactive tools that wait for the user (prompt_connection_setup, delete_connection, delete_project, AskUserQuestion) are top-level tools and cannot be called from js_exec.";

export interface PiToolSurfaceDeps {
  // DO operations the tool closures invoke.
  scopedCodeModeTools(context: ChatContextState): CodeModeToolsBinding;
  keepPiTurnToolProgressAliveWhile<T>(fn: () => Promise<T>): Promise<T>;
  runCodeModeJavascript(
    request: CodeModeJavascriptRequest,
  ): Promise<CodeModeJavascriptResult>;
  resolvePiModel(
    context: ChatContextState,
    envVars: Record<string, string>,
    getModelFn: (provider: never, modelId: never) => Model<any>,
  ): Promise<PiResolvedModelConfig>;
  resolvePiCapabilityModel(
    context: ChatContextState,
    modelId: string,
    getModelFn: (provider: never, modelId: never) => Model<any>,
  ): Promise<PiResolvedModelConfig>;
  consumeCapabilityAllowance(
    context: ChatContextState,
    capability: HostedCapability,
    idempotencyKey: string,
  ): Promise<{
    allowed: boolean;
    remaining: number | null;
    reset_at_ms: number;
  }>;
  /** Reads the DO's current `piModelResolver` field (null when no main turn set one). */
  piModelResolver(): (() => Promise<PiResolvedModelConfig>) | null;
  afterPiToolCall(
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined>;
  streamPiModel(
    model: Model<any>,
    context: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[1],
    options: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[2],
    streamSimple: typeof import("@earendil-works/pi-ai/compat").streamSimple,
  ): ReturnType<typeof import("@earendil-works/pi-ai/compat").streamSimple>;
  recordPiAssistantUsage(
    message: AgentMessage,
    durationMs: number,
    billingSource: PiBillingSource,
    creditChargeable: boolean,
    usageProvider?: string | null,
  ): Promise<void>;
  waitUntil(promise: Promise<unknown>): void;
  // Sibling routing back through the owning DO's same-named delegates, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  createPiToolDefinitions(
    context: ChatContextState,
    options?: PiToolDefinitionOptions,
  ): AgentTool[];
  runPiSubagentTool(
    context: ChatContextState,
    toolName: "Agent" | "Explore",
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
  ): Promise<AgentToolResult<unknown>>;
  createPiSubagentSystemPrompt(
    context: ChatContextState,
    isExplore: boolean,
  ): Promise<string>;
}

// Executor-style tool surface: the model sees the core file/js_exec/subagent
// tools plus the app/project-lifecycle passthrough tools, and reaches everything
// else by writing code in js_exec (tools.search / tools.describe / tools.<name>).
export function createPiToolDefinitions(
  deps: PiToolSurfaceDeps,
  context: ChatContextState,
  options: PiToolDefinitionOptions = {},
): AgentTool[] {
  const tools = deps.scopedCodeModeTools(context);
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    // Let the caller attach its rejection handler before an already-aborted
    // signal rejects; workerd otherwise reports the synchronous async-function
    // rejection as unhandled for one microtask.
    await Promise.resolve();
    if (signal?.aborted) throw new Error("Operation aborted");
    const result = await deps.keepPiTurnToolProgressAliveWhile(() => tools.callTool(name, args));
    if (signal?.aborted) throw new Error("Operation aborted");
    return {
      content: extractToolContent(result),
      details: result,
    };
  };

  const definitions: AgentTool[] = [
    {
      name: PI_CONTAINER_TOOL_DEFINITIONS.read.name,
      label: PI_CONTAINER_TOOL_DEFINITIONS.read.label,
      description: `${PI_CONTAINER_TOOL_DEFINITIONS.read.description} Also supports bundled skill files.`,
      parameters: PI_CONTAINER_TOOL_DEFINITIONS.read.parameters,
      execute: async (_id, params, signal) => call("read", params as Record<string, unknown>, signal),
    },
    {
      name: PI_CONTAINER_TOOL_DEFINITIONS.write.name,
      label: PI_CONTAINER_TOOL_DEFINITIONS.write.label,
      description: PI_CONTAINER_TOOL_DEFINITIONS.write.description,
      parameters: PI_CONTAINER_TOOL_DEFINITIONS.write.parameters,
      execute: async (_id, params, signal) => call("write", params as Record<string, unknown>, signal),
      executionMode: "sequential",
    },
    {
      name: PI_CONTAINER_TOOL_DEFINITIONS.edit.name,
      label: PI_CONTAINER_TOOL_DEFINITIONS.edit.label,
      description: PI_CONTAINER_TOOL_DEFINITIONS.edit.description,
      parameters: PI_CONTAINER_TOOL_DEFINITIONS.edit.parameters,
      execute: async (_id, params, signal) => call("edit", params as Record<string, unknown>, signal),
      executionMode: "sequential",
    },
    {
      name: PI_CONTAINER_TOOL_DEFINITIONS.delete.name,
      label: PI_CONTAINER_TOOL_DEFINITIONS.delete.label,
      description: PI_CONTAINER_TOOL_DEFINITIONS.delete.description,
      parameters: PI_CONTAINER_TOOL_DEFINITIONS.delete.parameters,
      execute: async (_id, params, signal) => call("delete", params as Record<string, unknown>, signal),
      executionMode: "sequential",
    },
    {
      name: PI_CONTAINER_TOOL_DEFINITIONS.ls.name,
      label: PI_CONTAINER_TOOL_DEFINITIONS.ls.label,
      description: `${PI_CONTAINER_TOOL_DEFINITIONS.ls.description} Also supports bundled skill directories.`,
      parameters: PI_CONTAINER_TOOL_DEFINITIONS.ls.parameters,
      execute: async (_id, params, signal) => call("ls", params as Record<string, unknown>, signal),
    },
    {
      name: "js_exec",
      label: "JavaScript",
      description: JS_EXEC_DESCRIPTION,
      parameters: Type.Object({
        description: Type.String({
          description:
            "Required concise description of what this JavaScript will do. This is shown in the chat UI.",
        }),
        code: Type.String(),
        timeoutMs: Type.Optional(Type.Number({
          description:
            `Optional wall-clock timeout in milliseconds for this JavaScript run. Defaults to ${CODE_MODE_DEFAULT_TIMEOUT_MS}ms and can be raised up to ${CODE_MODE_MAX_TIMEOUT_MS}ms for longer-running scripts.`,
        })),
        maxOutputCharacters: Type.Optional(Type.Number()),
      }),
      execute: async (toolUseId, params) => {
        const raw = params as {
          code?: unknown;
          description?: unknown;
          timeoutMs?: unknown;
          maxOutputCharacters?: unknown;
        };
        const result = await deps.keepPiTurnToolProgressAliveWhile(() => deps.runCodeModeJavascript({
          code: typeof raw.code === "string" ? raw.code : "",
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId: context.threadId,
          userId: context.userId ?? undefined,
          toolUseId,
          timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : null,
          maxOutputCharacters:
            typeof raw.maxOutputCharacters === "number"
              ? raw.maxOutputCharacters
              : null,
        }));
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: result,
        };
      },
      executionMode: "sequential",
    },
  ];

  for (const definition of CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS) {
    const { name } = definition;
    // Hidden tools (deprecated aliases) never register top-level.
    if (definition.hidden) continue;
    // Drop long-tail-category passthrough tools from the top-level list; they stay
    // reachable inside js_exec and discoverable via tools.search(). Human-input tools
    // and app/project-lifecycle categories are always kept top-level.
    if (
      !ALWAYS_TOP_LEVEL_PASSTHROUGH_NAMES.has(name) &&
      TOP_LEVEL_EXCLUDED_CATEGORIES.has(definition.category)
    ) {
      continue;
    }
    definitions.push({
      name,
      label: name,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (toolUseId, params) => {
        const raw = params && typeof params === "object"
          ? params as Record<string, unknown>
          : {};
        return call(name, {
          ...raw,
          toolUseId,
        });
      },
      executionMode: "sequential",
    });
  }

  if (options.includeSubagents !== false) {
    const runAgent = (
      toolName: "Agent" | "Explore",
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
    ) => deps.keepPiTurnToolProgressAliveWhile(() =>
      deps.runPiSubagentTool(context, toolName, params, signal, onUpdate)
    );

    definitions.push(
      {
        name: "Agent",
        label: "Agent",
        description:
          "Run a focused subagent in the same workspace. Use this for bounded investigation or implementation tasks that benefit from an isolated context.",
        parameters: Type.Object({
          prompt: Type.String(),
          description: Type.Optional(Type.String()),
          agent: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
        }),
        execute: async (_id, params, signal, onUpdate) =>
          runAgent("Agent", params, signal, onUpdate),
        executionMode: "sequential",
      },
      {
        name: "Explore",
        label: "Explore",
        description:
          "Run a focused read-oriented exploration subagent in the same workspace. Use this to inspect code and report findings.",
        parameters: Type.Object({
          prompt: Type.Optional(Type.String()),
          query: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          agent: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
        }),
        execute: async (_id, params, signal, onUpdate) =>
          runAgent("Explore", params, signal, onUpdate),
        executionMode: "sequential",
      },
    );
  }

  const runCapability = (
    capability: "Research" | "Oracle",
    toolUseId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
  ) => deps.keepPiTurnToolProgressAliveWhile(() =>
    runPiCapabilityAgentTool(
      deps,
      context,
      capability,
      toolUseId,
      params,
      signal,
      onUpdate,
    )
  );

  if (options.includeResearch !== false) {
    definitions.push({
      name: "Research",
      label: "Research",
      description:
        "Delegate an open-ended, multi-source web investigation to a focused research agent. Use WebSearch for one quick lookup and WebFetch for a known URL; use Research when the answer needs several sources or synthesis.",
      parameters: Type.Object({
        question: Type.String(),
      }),
      execute: async (toolUseId, params, signal, onUpdate) =>
        runCapability("Research", toolUseId, params, signal, onUpdate),
      executionMode: "sequential",
    });
  }

  if (options.includeOracle === true) {
    definitions.push({
      name: "Oracle",
      label: "Oracle",
      description:
        "Use Oracle when you are stuck or repeatedly hitting an issue, or when stronger reasoning is likely to materially improve a difficult architecture, debugging, planning, or implementation task. Oracle can directly investigate and fix issues for you, and can create or start ambitious projects rather than only advising about them.",
      parameters: Type.Object({
        question: Type.String(),
      }),
      execute: async (toolUseId, params, signal, onUpdate) =>
        runCapability("Oracle", toolUseId, params, signal, onUpdate),
      executionMode: "sequential",
    });
  }

  return definitions;
}

export async function runPiSubagentTool(
  deps: PiToolSurfaceDeps,
  context: ChatContextState,
  toolName: "Agent" | "Explore",
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
): Promise<AgentToolResult<unknown>> {
  const raw = params && typeof params === "object"
    ? params as Record<string, unknown>
    : {};
  const isExplore = toolName === "Explore";
  const prompt =
    typeof raw.prompt === "string" && raw.prompt.trim()
      ? raw.prompt.trim()
      : typeof raw.query === "string" && raw.query.trim()
        ? raw.query.trim()
        : "";
  if (!prompt) {
    throw new Error(`${toolName} requires a prompt`);
  }

  const { Agent } = await import("@earendil-works/pi-agent-core");
  const { getModel, streamSimple } = await import("@earendil-works/pi-ai/compat");
  const resolveCurrentModel =
    deps.piModelResolver() ?? (() => deps.resolvePiModel(context, {}, getModel));
  let modelConfig = await resolveCurrentModel();
  const child = new Agent({
    initialState: {
      systemPrompt: await deps.createPiSubagentSystemPrompt(context, isExplore),
      model: modelConfig.model,
      tools: deps.createPiToolDefinitions(context, {
        includeSubagents: false,
        includeResearch: false,
        includeOracle: false,
      }),
      messages: [],
      thinkingLevel: "medium",
    },
    getApiKey: async () => {
      const current = await resolveCurrentModel();
      modelConfig = current;
      child.state.model = current.model;
      return current.apiKey;
    },
    afterToolCall: (toolContext, signal) =>
      deps.afterPiToolCall(toolContext, signal),
    streamFn: (model, llmContext, options) =>
      deps.streamPiModel(model, llmContext, options, streamSimple),
    sessionId: `${context.threadId}:${toolName}:${crypto.randomUUID()}`,
    toolExecution: "parallel",
  });

  let assistantText = "";
  let latestAssistantText = "";
  let toolUseCount = 0;
  let turnStartedAtMs = Date.now();
  let finalMessages: AgentMessage[] = [];
  const startedAtMs = Date.now();
  const progress = createAgentProgressReporter(onUpdate);

  const unsubscribe = child.subscribe((event) => {
    try {
      if (event.type === "turn_start") {
        turnStartedAtMs = Date.now();
        return;
      }
      if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent as {
          type?: string;
          delta?: string;
        };
        if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
          assistantText += assistantEvent.delta;
        }
        return;
      }
      if (event.type === "message_end") {
        latestAssistantText = extractPiMessageText(event.message) || assistantText;
        return;
      }
      if (event.type === "tool_execution_start") {
        toolUseCount += 1;
        progress.startTool(event.toolCallId, event.toolName, event.args, {
          toolName: event.toolName,
          toolUseCount,
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        progress.finishTool(event.toolCallId, event.isError);
        return;
      }
      if (event.type === "turn_end") {
        const durationMs = Math.max(0, Date.now() - turnStartedAtMs);
        deps.waitUntil(
          deps.recordPiAssistantUsage(
            event.message,
            durationMs,
            modelConfig.billingSource,
            modelConfig.creditChargeable,
            modelConfig.usageProvider,
          ).catch((error) => {
            console.error("[ChatThreadDO] failed to record Pi subagent usage", error);
          }),
        );
        return;
      }
      if (event.type === "agent_end") {
        finalMessages = event.messages;
      }
    } catch (error) {
      console.error("[ChatThreadDO] Pi subagent event handler failed", error);
    }
  });

  const abort = () => child.abort();
  if (signal?.aborted) {
    unsubscribe();
    throw new Error(`${toolName} was aborted`);
  }
  signal?.addEventListener("abort", abort, { once: true });

  try {
    progress.reportStatus(isExplore ? "Starting exploration" : "Starting agent", {
      toolName,
    });
    await child.prompt({
      role: "user",
      content: isExplore
        ? `Explore the workspace and answer this request. Do not edit files.\n\n${prompt}`
        : prompt,
      timestamp: Date.now(),
    } as AgentMessage);
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe();
  }

  const finalText =
    latestAssistantText ||
    extractLatestPiAssistantText(finalMessages) ||
    assistantText.trim() ||
    `${toolName} completed without text output.`;
  return {
    content: [{ type: "text", text: finalText }],
    details: {
      status: "completed",
      toolName,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      toolUseCount,
      activities: progress.activities,
      toolActivities: progress.toolActivities,
    },
  };
}

export async function runPiCapabilityAgentTool(
  deps: PiToolSurfaceDeps,
  context: ChatContextState,
  toolName: "Research" | "Oracle",
  toolUseId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
): Promise<AgentToolResult<unknown>> {
  const raw = params && typeof params === "object"
    ? params as Record<string, unknown>
    : {};
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) {
    throw new Error(`${toolName} requires a question`);
  }

  const capability: HostedCapability = toolName === "Research" ? "research" : "oracle";
  const allowance = await deps.consumeCapabilityAllowance(
    context,
    capability,
    `${context.threadId}:${toolUseId}`,
  );
  if (!allowance.allowed) {
    throw new Error(
      `${toolName} daily allowance reached. It resets at ${new Date(allowance.reset_at_ms).toISOString()}.`,
    );
  }

  const { Agent } = await import("@earendil-works/pi-agent-core");
  const { getModel, streamSimple } = await import("@earendil-works/pi-ai/compat");
  const isResearch = toolName === "Research";
  const capabilityModel = isResearch
    ? RESEARCH_CAPABILITY_MODEL
    : ORACLE_CAPABILITY_MODEL;
  let modelConfig = await deps.resolvePiCapabilityModel(
    context,
    capabilityModel,
    getModel,
  );
  const capOutputTokens = (model: Model<any>): Model<any> => ({
    ...model,
    maxTokens: Math.min(Number(model.maxTokens || 16_384), 16_384),
  });
  let researchRequestCount = 0;
  const capabilityTools = isResearch
    ? deps.createPiToolDefinitions(context, {
        includeSubagents: false,
        includeResearch: false,
        includeOracle: false,
      })
        .filter((tool) => tool.name === "WebSearch" || tool.name === "WebFetch")
        .map((tool) => ({
          ...tool,
          execute: async (...args: Parameters<AgentTool["execute"]>) => {
            if (researchRequestCount >= 8) {
              throw new Error("Research reached its per-job limit of 8 web requests");
            }
            researchRequestCount += 1;
            return await tool.execute(...args);
          },
        }))
    : deps.createPiToolDefinitions(context, {
        includeSubagents: false,
        includeResearch: false,
        includeOracle: false,
      });
  const systemPrompt = isResearch
    ? [
        "You are camelAI's focused web research agent.",
        "Investigate the question using WebSearch and WebFetch, then return a concise synthesis with direct source URLs.",
        "Use multiple independent sources when the claim warrants it. Distinguish facts from inference and mention important uncertainty.",
        "Keep the task bounded: use no more than 3 searches and 5 fetches. Do not attempt workspace edits or unrelated work.",
      ].join(" ")
    : [
        "You are camelAI's Oracle, a high-capability reasoning and execution agent.",
        "Handle only the supplied question or task. For advice, give a direct recommendation, the strongest reasoning, important tradeoffs, and uncertainty.",
        "When asked to investigate or fix an issue, inspect the workspace and use your tools to implement and verify the fix directly rather than only describing it.",
        "When asked to create or start an ambitious project, use your tools to establish a concrete, working foundation and report what you completed.",
        "Do not delegate to other agents. Keep the work focused, actionable, and honest about anything you could not verify.",
      ].join(" ");

  const child = new Agent({
    initialState: {
      systemPrompt,
      model: capOutputTokens(modelConfig.model),
      tools: capabilityTools,
      messages: [],
      thinkingLevel: isResearch ? "medium" : "high",
    },
    getApiKey: async () => {
      const current = await deps.resolvePiCapabilityModel(
        context,
        capabilityModel,
        getModel,
      );
      modelConfig = current;
      child.state.model = capOutputTokens(current.model);
      return current.apiKey;
    },
    afterToolCall: (toolContext, childSignal) =>
      deps.afterPiToolCall(toolContext, childSignal),
    streamFn: (model, llmContext, options) =>
      deps.streamPiModel(model, llmContext, options, streamSimple),
    sessionId: `${context.threadId}:${toolName}:${crypto.randomUUID()}`,
    toolExecution: "sequential",
  });

  let assistantText = "";
  let latestAssistantText = "";
  let toolUseCount = 0;
  const childToolsUsed: string[] = [];
  let turnStartedAtMs = Date.now();
  let finalMessages: AgentMessage[] = [];
  const startedAtMs = Date.now();
  const progress = createAgentProgressReporter(onUpdate);

  const unsubscribe = child.subscribe((event) => {
    try {
      if (event.type === "turn_start") {
        turnStartedAtMs = Date.now();
        return;
      }
      if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent as {
          type?: string;
          delta?: string;
        };
        if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
          assistantText += assistantEvent.delta;
        }
        return;
      }
      if (event.type === "message_end") {
        latestAssistantText = extractPiMessageText(event.message) || assistantText;
        return;
      }
      if (event.type === "tool_execution_start") {
        toolUseCount += 1;
        childToolsUsed.push(event.toolName);
        progress.startTool(event.toolCallId, event.toolName, event.args, {
          toolName: event.toolName,
          toolUseCount,
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        progress.finishTool(event.toolCallId, event.isError);
        return;
      }
      if (event.type === "turn_end") {
        const durationMs = Math.max(0, Date.now() - turnStartedAtMs);
        deps.waitUntil(
          deps.recordPiAssistantUsage(
            event.message,
            durationMs,
            modelConfig.billingSource,
            modelConfig.creditChargeable,
            modelConfig.usageProvider,
          ).catch((error) => {
            console.error(`[ChatThreadDO] failed to record Pi ${capability} usage`, error);
          }),
        );
        return;
      }
      if (event.type === "agent_end") {
        finalMessages = event.messages;
      }
    } catch (error) {
      console.error(`[ChatThreadDO] Pi ${capability} event handler failed`, error);
    }
  });

  const abort = () => child.abort();
  if (signal?.aborted) {
    unsubscribe();
    throw new Error(`${toolName} was aborted`);
  }
  signal?.addEventListener("abort", abort, { once: true });

  try {
    progress.reportStatus(isResearch ? "Starting research" : "Starting Oracle", {
      toolName,
      ...(isResearch ? { model: capabilityModel } : {}),
      remaining: allowance.remaining,
      resetAtMs: allowance.reset_at_ms,
    });
    await child.prompt({
      role: "user",
      content: question,
      timestamp: Date.now(),
    } as AgentMessage);
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe();
  }

  const finalText =
    latestAssistantText ||
    extractLatestPiAssistantText(finalMessages) ||
    assistantText.trim() ||
    `${toolName} completed without text output.`;
  return {
    content: [{ type: "text", text: finalText }],
    details: {
      status: "completed",
      toolName,
      ...(isResearch ? { model: capabilityModel } : {}),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      toolUseCount,
      childToolsUsed: [...new Set(childToolsUsed)],
      activities: progress.activities,
      toolActivities: progress.toolActivities,
      remaining: allowance.remaining,
      resetAtMs: allowance.reset_at_ms,
    },
  };
}

export async function createPiSubagentSystemPrompt(
  context: ChatContextState,
  isExplore: boolean,
): Promise<string> {
  return buildPiSubagentSystemPrompt(
    context,
    isExplore ? "explore" : "agent",
    {
      skillNames: PI_SKILL_NAMES,
      skillDescriptions: PI_SKILL_DESCRIPTIONS,
    },
  );
}
