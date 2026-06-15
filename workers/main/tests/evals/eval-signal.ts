import type { AgentEvalSessionResult } from "../../src/chat-thread-do";

export type EvalSignalEnv = {
  EVAL_ENFORCE_SIGNAL?: string;
  EVAL_MAX_ASSISTANT_TURNS?: string;
  EVAL_MAX_BAD_TOOL_CALLS?: string;
  EVAL_MAX_SDK_TURNS?: string;
};

export type EvalSignalThresholds = {
  maxAssistantTurns?: number;
  maxBadToolCalls?: number;
  maxSdkTurns?: number;
};

export type EvalToolCallSummary = {
  id?: string;
  tool: string;
  reason: string;
  status?: string;
  output?: string;
};

export type EvalSignal = {
  assistantTurnCount: number;
  sdkTurnStartCount: number;
  messageCount: number;
  toolCallCount: number;
  toolCallsByName: Record<string, number>;
  harnessErrorCount: number;
  harnessErrors: EvalToolCallSummary[];
  badToolCallCount: number;
  badToolCalls: EvalToolCallSummary[];
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
    maxSdkTurns:
      parsePositiveInt(env.EVAL_MAX_SDK_TURNS, "EVAL_MAX_SDK_TURNS") ??
      defaults.maxSdkTurns,
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

  let sdkTurnStartCount = 0;
  for (const rawEvent of result.events) {
    const event = asRecord(rawEvent);
    const sdkEvent = asRecord(event?.event);
    if (event?.type === "sdk_event" && sdkEvent?.type === "turn_start") {
      sdkTurnStartCount += 1;
    }

    if (event?.type !== "runtime_event") continue;
    if (sdkEvent?.method !== "item/completed") continue;
    const params = asRecord(sdkEvent.params);
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
    thresholds.maxSdkTurns !== undefined &&
    sdkTurnStartCount > thresholds.maxSdkTurns
  ) {
    violations.push(
      `sdk turns ${sdkTurnStartCount} exceeded max ${thresholds.maxSdkTurns}`,
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
    sdkTurnStartCount,
    messageCount: result.messages.length,
    toolCallCount,
    toolCallsByName,
    harnessErrorCount: 0,
    harnessErrors: [],
    badToolCallCount: badToolCalls.length,
    badToolCalls,
    thresholds,
    violations,
  };
}
