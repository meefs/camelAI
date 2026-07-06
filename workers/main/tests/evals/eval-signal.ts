import type { AgentEvalSessionResult } from "../../src/chat-thread-do";

export type EvalSignalEnv = {
  EVAL_ENFORCE_SIGNAL?: string;
  EVAL_MAX_ASSISTANT_TURNS?: string;
  EVAL_MAX_BAD_TOOL_CALLS?: string;
};

export type EvalSignalThresholds = {
  maxAssistantTurns?: number;
  maxBadToolCalls?: number;
};

export type EvalToolCallSummary = {
  id?: string;
  tool: string;
  reason: string;
  status?: string;
  output?: string;
};

export type EvalTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  turnCount: number;
  costUsd?: number;
};

export type EvalSignal = {
  assistantTurnCount: number;
  messageCount: number;
  toolCallCount: number;
  toolCallsByName: Record<string, number>;
  harnessErrorCount: number;
  harnessErrors: EvalToolCallSummary[];
  badToolCallCount: number;
  badToolCalls: EvalToolCallSummary[];
  tokenUsage: EvalTokenUsage;
  thresholds: EvalSignalThresholds;
  violations: string[];
};

type RecordValue = Record<string, unknown>;

const MAX_OUTPUT_LENGTH = 500;

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayFromContent(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function excerpt(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > MAX_OUTPUT_LENGTH
    ? `${text.slice(0, MAX_OUTPUT_LENGTH)}...`
    : text;
}

// Known eval-env limitation: the Miniflare eval environment has no BROWSER
// binding, so both take_screenshot and env.BROWSER.launch always fail with these
// messages (app-screenshot-binding.ts / app-browser-binding.ts). That is not
// agent misbehavior, so such failures must not count against the bad-tool-call
// budget. Production behavior is unchanged — this only filters eval signal.
function isKnownEvalEnvToolLimitation(output: string | undefined): boolean {
  if (output === undefined) return false;
  return (
    output.includes("Screenshot capture requires the BROWSER binding")
    || output.includes("Browser sessions require the BROWSER binding")
  );
}

function classifyFailedToolCall(
  tool: string,
  output: string | undefined,
): string | undefined {
  if (output?.includes("Validation failed for tool")) return "validation_failed";
  if (output?.includes("SessionTerminatedError")) return "session_terminated";
  if (tool === "js_exec" && output?.includes("command is required")) {
    return "malformed_vm_exec";
  }
  if (
    tool === "js_exec" &&
    output?.includes("Identifier 'projects' has already been declared")
  ) {
    return "js_runtime_helper_name_collision";
  }
  return undefined;
}

function emptyEvalTokenUsage(): EvalTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    turnCount: 0,
  };
}

function parseNonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function extractEvalTurnUsage(usage: RecordValue): EvalTokenUsage & { costUsd?: number } {
  const inputTokens = parseNonNegativeInt(
    usage.input ?? usage.input_tokens ?? usage.inputTokens,
  );
  const outputTokens = parseNonNegativeInt(
    usage.output ?? usage.output_tokens ?? usage.outputTokens,
  );
  const cacheReadInputTokens = parseNonNegativeInt(
    usage.cacheRead ??
      usage.cache_read_input_tokens ??
      usage.cacheReadInputTokens,
  );
  const cacheCreationInputTokens = parseNonNegativeInt(
    usage.cacheWrite ??
      usage.cache_creation_input_tokens ??
      usage.cacheCreationInputTokens,
  );
  const explicitTotal = parseNonNegativeInt(
    usage.totalTokens ?? usage.total_tokens,
  );
  const totalTokens = Math.max(
    explicitTotal,
    inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
  );
  const costRecord = asRecord(usage.cost);
  const rawCost = Number(costRecord?.total ?? usage.costUsd ?? usage.cost_usd);
  const costUsd =
    Number.isFinite(rawCost) && rawCost > 0 ? rawCost : undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens,
    turnCount: totalTokens > 0 ? 1 : 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export function countEvalTokenUsage(
  result: Pick<AgentEvalSessionResult, "events">,
): EvalTokenUsage {
  const total = emptyEvalTokenUsage();
  let costUsd = 0;
  let hasCost = false;

  for (const rawEvent of result.events) {
    const event = asRecord(rawEvent);
    if (event?.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(event.event);
    if (runtimeEvent?.method !== "turn/completed") continue;
    const params = asRecord(runtimeEvent.params);
    const usage = asRecord(params?.usage);
    if (!usage) continue;

    const parsed = extractEvalTurnUsage(usage);
    if (parsed.turnCount <= 0) continue;
    total.inputTokens += parsed.inputTokens;
    total.outputTokens += parsed.outputTokens;
    total.cacheReadInputTokens += parsed.cacheReadInputTokens;
    total.cacheCreationInputTokens += parsed.cacheCreationInputTokens;
    total.totalTokens += parsed.totalTokens;
    total.turnCount += parsed.turnCount;
    if (parsed.costUsd !== undefined) {
      costUsd += parsed.costUsd;
      hasCost = true;
    }
  }

  return {
    ...total,
    ...(hasCost ? { costUsd } : {}),
  };
}

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function getEvalSignalThresholds(
  env: EvalSignalEnv,
  defaults: EvalSignalThresholds = {},
): EvalSignalThresholds {
  return {
    maxAssistantTurns:
      parsePositiveInt(env.EVAL_MAX_ASSISTANT_TURNS, "EVAL_MAX_ASSISTANT_TURNS") ??
      defaults.maxAssistantTurns,
    maxBadToolCalls:
      parsePositiveInt(env.EVAL_MAX_BAD_TOOL_CALLS, "EVAL_MAX_BAD_TOOL_CALLS") ??
      defaults.maxBadToolCalls,
  };
}

export function evalSignalShouldBeEnforced(env: EvalSignalEnv): boolean {
  return env.EVAL_ENFORCE_SIGNAL === "1";
}

export function assertEvalSignal(
  signal: EvalSignal,
  env: EvalSignalEnv,
): void {
  if (!evalSignalShouldBeEnforced(env) || signal.violations.length === 0) {
    return;
  }

  throw new Error(
    `Eval signal thresholds failed:\n${signal.violations.join("\n")}`,
  );
}

export function evaluateAgentEvalSignal(
  result: Pick<AgentEvalSessionResult, "events" | "messages">,
  thresholds: EvalSignalThresholds = {},
): EvalSignal {
  const toolCallsByName: Record<string, number> = {};
  const badToolCallsByKey = new Map<string, EvalToolCallSummary>();

  let toolCallCount = 0;
  let assistantTurnCount = 0;
  for (const message of result.messages) {
    if (message.role !== "assistant") continue;
    assistantTurnCount += 1;

    for (const block of arrayFromContent(message.content)) {
      const item = asRecord(block);
      if (!item) continue;
      if (item.type === "tool_use") {
        const name = asString(item.name) ?? "unknown";
        toolCallCount += 1;
        toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
      }
      if (item.type === "tool_result") {
        const content = asString(item.content);
        if (content?.includes("Validation failed for tool")) {
          const toolUseId = asString(item.tool_use_id);
          badToolCallsByKey.set(toolUseId ?? `message:${badToolCallsByKey.size}`, {
            id: toolUseId,
            tool: "unknown",
            reason: "validation_failed",
            output: excerpt(content),
          });
        }
      }
    }
  }

  for (const rawEvent of result.events) {
    const event = asRecord(rawEvent);
    const runtimeEvent = asRecord(event?.event);
    if (event?.type !== "runtime_event") continue;
    if (runtimeEvent?.method !== "item/completed") continue;
    const params = asRecord(runtimeEvent.params);
    const item = asRecord(params?.item);
    if (!item) continue;

    const id = asString(item.id);
    const key = id ?? `runtime:${badToolCallsByKey.size}`;
    const tool =
      asString(item.tool) ??
      (item.type === "commandExecution" ? "bash" : undefined) ??
      "unknown";
    const resultRecord = asRecord(item.result);
    const details = asRecord(resultRecord?.details);
    const output =
      asString(item.aggregatedOutput) ??
      asString(details?.text) ??
      excerpt(resultRecord?.content);
    const status = asString(item.status);
    const exitCode = details?.exitCode;
    const success = details?.success;

    let reason: string | undefined;
    if (status === "failed") {
      reason = classifyFailedToolCall(tool, output) ?? "tool_status_failed";
    } else if (success === false) {
      reason = "tool_result_unsuccessful";
    } else if (typeof exitCode === "number" && exitCode !== 0) {
      reason = "nonzero_exit_code";
    } else if (classifyFailedToolCall(tool, output)) {
      reason = classifyFailedToolCall(tool, output);
    } else if (
      tool === "ls" &&
      asString(asRecord(item.arguments)?.path)?.includes(".") &&
      details?.source === "bundled_skill"
    ) {
      reason = "ls_file_path_resolved_to_skill_catalog";
    }

    if (!reason) continue;
    if (isKnownEvalEnvToolLimitation(output)) continue;
    badToolCallsByKey.set(key, {
      id,
      tool,
      reason,
      status,
      output: excerpt(output),
    });
  }

  const badToolCalls = [...badToolCallsByKey.values()];
  const violations: string[] = [];
  if (
    thresholds.maxAssistantTurns !== undefined &&
    assistantTurnCount > thresholds.maxAssistantTurns
  ) {
    violations.push(
      `assistant turns ${assistantTurnCount} exceeded max ${thresholds.maxAssistantTurns}`,
    );
  }
  if (
    thresholds.maxBadToolCalls !== undefined &&
    badToolCalls.length > thresholds.maxBadToolCalls
  ) {
    violations.push(
      `bad tool calls ${badToolCalls.length} exceeded max ${thresholds.maxBadToolCalls}`,
    );
  }

  return {
    assistantTurnCount,
    messageCount: result.messages.length,
    toolCallCount,
    toolCallsByName,
    harnessErrorCount: 0,
    harnessErrors: [],
    badToolCallCount: badToolCalls.length,
    badToolCalls,
    tokenUsage: countEvalTokenUsage(result),
    thresholds,
    violations,
  };
}
