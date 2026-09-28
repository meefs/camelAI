/**
 * Analytics Engine events for threads that run directly on the hosted agent
 * runtime: a send the runtime did not take, and a browser token that could not
 * be minted. Component `runtime_thread`; ids, classes and status codes only,
 * never message text.
 */
import { recordErrorEvent, recordObservabilityEvent, type ObservabilityEnv } from "../observability.js";
import { RuntimeApiError } from "./runtime-api.js";
import type { RuntimeTurnResult } from "./thread-runtime.js";

export interface RuntimeThreadTelemetryContext {
  orgId: string;
  workspaceId: string;
  threadId: string;
  userId?: string | null;
}

export type RuntimeFailureClass = { status: "runtime_4xx" | "runtime_5xx" | "exception"; statusCode: number | null };

/** A thrown error: the runtime refused (4xx), the runtime failed (5xx), or anything else. */
export function classifyRuntimeFailure(error: unknown): RuntimeFailureClass {
  if (error instanceof RuntimeApiError) {
    return { status: error.status >= 500 ? "runtime_5xx" : "runtime_4xx", statusCode: error.status };
  }
  return { status: "exception", statusCode: null };
}

function ids(context: RuntimeThreadTelemetryContext) {
  return {
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    threadId: context.threadId,
    userId: context.userId ?? null,
  };
}

/**
 * `runtime_thread_send_failed`: a message the runtime did not accept. Status
 * `refused` (chiridion's gates; errorName is the refusal's code), `busy`, or
 * the class of a thrown error. Nothing for an accepted send.
 */
export function recordRuntimeSendFailure(
  env: ObservabilityEnv | undefined,
  context: RuntimeThreadTelemetryContext,
  operation: "send" | "first_send",
  outcome: { result?: RuntimeTurnResult; error?: unknown },
): void {
  const base = { event: "runtime_thread_send_failed", component: "runtime_thread", operation, ...ids(context) };
  if (outcome.result) {
    if (outcome.result.status === "accepted") return;
    const refused = outcome.result.status === "error";
    recordObservabilityEvent(env, {
      ...base,
      severity: "warn",
      status: refused ? "refused" : "busy",
      errorName: refused ? outcome.result.code ?? "unspecified" : null,
    });
    return;
  }
  const failure = classifyRuntimeFailure(outcome.error);
  recordErrorEvent(env, { ...base, status: failure.status, statusCode: failure.statusCode, error: outcome.error });
}

/**
 * `runtime_token_mint_failed`: the browser could not get a watch token, from
 * the token route or the page's first load. Status `no_agent` (the thread has
 * no agent yet), or the class of a thrown error.
 */
export function recordRuntimeTokenMintFailure(
  env: ObservabilityEnv | undefined,
  context: RuntimeThreadTelemetryContext,
  operation: "token_route" | "page_seed",
  outcome: { status: "no_agent"; statusCode: number } | { error: unknown },
): void {
  const base = { event: "runtime_token_mint_failed", component: "runtime_thread", operation, ...ids(context) };
  if ("status" in outcome) {
    recordObservabilityEvent(env, { ...base, severity: "warn", status: outcome.status, statusCode: outcome.statusCode });
    return;
  }
  const failure = classifyRuntimeFailure(outcome.error);
  recordErrorEvent(env, { ...base, status: failure.status, statusCode: failure.statusCode, error: outcome.error });
}
