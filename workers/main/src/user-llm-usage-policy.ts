import type {
  CheckUserLlmUsageAccessInput,
  UserLlmUsageAccessResult,
  UserLlmUsageLimitStatus,
} from "./identity/org/usage-controls";
import { recordObservabilityEvent, type ObservabilityEnv } from "./observability";

export type UserLlmUsageLimitErrorCode =
  | "limit_exceeded"
  | "pricing_unavailable"
  | "usage_policy_unavailable";

function windowLabel(limit: UserLlmUsageLimitStatus | null): string {
  if (!limit) return "configured rolling window";
  return limit.label?.trim() || `${limit.window_hours}-hour window`;
}

export class UserLlmUsageLimitError extends Error {
  constructor(
    readonly code: UserLlmUsageLimitErrorCode,
    readonly access: UserLlmUsageAccessResult | null = null,
    readonly provider?: string,
    readonly model?: string,
  ) {
    const blocking = access?.blocking_limit ?? null;
    let message: string;
    if (code === "limit_exceeded") {
      const retry = blocking?.retry_at_ms
        ? ` Try again after ${new Date(blocking.retry_at_ms).toISOString()}.`
        : "";
      message = `LLM usage limit ${windowLabel(blocking)} reached (${(blocking?.spent_usd ?? 0).toFixed(6)} USD spent of ${(blocking?.limit_usd ?? 0).toFixed(6)} USD).${retry}`;
    } else if (code === "pricing_unavailable") {
      message = `LLM usage is blocked because ${provider || "this provider"}/${model || "this model"} is unpriced or the active limit window contains unpriced LLM usage. Configure an exact pricing override in the admin API.`;
    } else {
      message = "LLM usage policy could not be verified. The provider was not called; try again or ask the operator to check the organization usage service.";
    }
    super(message);
    this.name = "UserLlmUsageLimitError";
  }
}

export interface UserLlmUsagePolicyStub {
  checkUserLlmUsageAccess(input: CheckUserLlmUsageAccessInput): Promise<UserLlmUsageAccessResult>;
}

export interface UserLlmUsagePolicyContext {
  env?: ObservabilityEnv;
  orgId: string;
  workspaceId?: string | null;
  threadId?: string | null;
  userId: string;
  provider: string;
  model: string;
}

export async function assertUserLlmUsageAccess(
  stub: UserLlmUsagePolicyStub,
  context: UserLlmUsagePolicyContext,
): Promise<UserLlmUsageAccessResult> {
  let access: UserLlmUsageAccessResult;
  try {
    access = await stub.checkUserLlmUsageAccess({
      user_id: context.userId,
      provider: context.provider,
      model: context.model,
    });
  } catch {
    recordObservabilityEvent(context.env, {
      event: "user_llm_usage_limit_denied",
      severity: "error",
      component: "llm_usage_policy",
      operation: "check_user_llm_usage_access",
      status: "usage_policy_unavailable",
      orgId: context.orgId,
      workspaceId: context.workspaceId,
      threadId: context.threadId,
      userId: context.userId,
      provider: context.provider,
      model: context.model,
    });
    throw new UserLlmUsageLimitError(
      "usage_policy_unavailable",
      null,
      context.provider,
      context.model,
    );
  }
  if (access.allowed) return access;

  const blocking = access.blocking_limit;
  recordObservabilityEvent(context.env, {
    event: "user_llm_usage_limit_denied",
    severity: "warn",
    component: "llm_usage_policy",
    operation: "check_user_llm_usage_access",
    status: access.reason,
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    threadId: context.threadId,
    userId: context.userId,
    provider: context.provider,
    model: context.model,
    extraCounts: [
      blocking?.window_hours ?? 0,
      blocking?.spent_usd ?? 0,
      blocking?.limit_usd ?? 0,
    ],
  });
  throw new UserLlmUsageLimitError(
    access.reason === "pricing_unavailable" ? "pricing_unavailable" : "limit_exceeded",
    access,
    context.provider,
    context.model,
  );
}
