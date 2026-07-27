import {
  CAMEL_CODE_LLM_MODEL,
  isCreditFreeHostedModel,
  isLlmModelCoveredByByokProvider,
  isLlmModelCoveredByOpenAiSubscription,
} from "@/lib/llm-provider-config";
import type { ModelCatalogEntry } from "@/lib/model-catalog";
import type { BillingStatus, LlmProvider } from "@/types";

export type ModelPausedReason =
  | "payg_credits_exhausted"
  | "included_credits_exhausted"
  | "trial_credits_exhausted"
  | "subscription_unavailable";

export type ModelPickerOption = ModelCatalogEntry & {
  locked?: boolean;
  unlockHint?: "openai" | "generic";
  pausedReason?: ModelPausedReason;
};

export type ModelPickerBillingAccessMode =
  | "enterprise"
  | "subscription"
  | "byok"
  | "credits"
  | "selfhost"
  | "camel_free";

export interface HostedCreditPauseBilling {
  billingStatus?: BillingStatus | null;
  availableCreditsCents: number | null;
}

interface HostedCreditPauseResult {
  modelOptions: ModelPickerOption[];
  hostedCreditsPaused: { reason: ModelPausedReason } | null;
}

function clearHostedCreditPause(
  entry: ModelPickerOption,
): ModelPickerOption {
  if (!entry.pausedReason) return entry;
  const {
    locked: _locked,
    pausedReason: _pausedReason,
    ...unpausedEntry
  } = entry;
  return unpausedEntry;
}

function modelCostRank(entry: ModelPickerOption): number {
  return entry.cost === "Free" ? 0 : entry.cost.length;
}

export function findCheapestSelectableModel(
  modelOptions: ReadonlyArray<ModelPickerOption>,
): ModelPickerOption | null {
  return modelOptions.reduce<ModelPickerOption | null>((cheapest, entry) => {
    if (entry.locked) return cheapest;
    if (!cheapest || modelCostRank(entry) < modelCostRank(cheapest)) {
      return entry;
    }
    return cheapest;
  }, null);
}

export function shouldPromptToAddCamelCode(
  modelOptions: ReadonlyArray<ModelPickerOption>,
  hostedCreditsPaused: { reason: ModelPausedReason } | null,
): boolean {
  const hasBillingLockedModel = modelOptions.some((entry) => entry.locked);
  return Boolean(
    (hostedCreditsPaused || hasBillingLockedModel) &&
    !modelOptions.some((entry) => !entry.locked) &&
    !modelOptions.some((entry) => entry.id === CAMEL_CODE_LLM_MODEL),
  );
}

/**
 * Applies the hosted-credit pause to a picker catalog. This is shared by the
 * route loaders and the live chat credit refresh so rows lock immediately when
 * the balance crosses zero, without waiting for a route revalidation.
 */
export function deriveHostedCreditPause(args: {
  modelOptions: ReadonlyArray<ModelPickerOption>;
  billingAccessMode: ModelPickerBillingAccessMode | null;
  llmProvider: LlmProvider | null;
  allowOpenAiSubscription: boolean;
  billing: HostedCreditPauseBilling | null;
}): HostedCreditPauseResult {
  const subscriptionUnavailable =
    args.billing?.billingStatus === "past_due" &&
    args.billingAccessMode !== "selfhost";
  if (
    !args.billing ||
    (!subscriptionUnavailable &&
      args.billingAccessMode !== "subscription" &&
      args.billingAccessMode !== "credits")
  ) {
    return {
      modelOptions: [...args.modelOptions],
      hostedCreditsPaused: null,
    };
  }

  // A fresh positive balance should also clear pause-only locks from loader
  // data that predates the live credit refresh.
  const modelOptions = args.modelOptions.map(clearHostedCreditPause);
  let reason: ModelPausedReason | null = null;
  if (subscriptionUnavailable) {
    reason = "subscription_unavailable";
  } else if (
    args.billing.availableCreditsCents !== null &&
    args.billing.availableCreditsCents <= 0
  ) {
    reason =
      args.billing.billingStatus === "trialing"
        ? "trial_credits_exhausted"
        : args.billing.billingStatus === "active" ||
            args.billingAccessMode === "subscription"
          ? "included_credits_exhausted"
          : "payg_credits_exhausted";
  }
  if (!reason) {
    return {
      modelOptions,
      hostedCreditsPaused: null,
    };
  }

  // Keep this chargeability mirror aligned with checkHostedPiModelAccess in
  // workers/main/src/chat-thread/pi-model-config.ts.
  const pausedModelOptions = modelOptions.map((entry) => {
    const coveredByByok =
      args.llmProvider &&
      isLlmModelCoveredByByokProvider(entry.id, args.llmProvider);
    const coveredByOpenAi =
      args.allowOpenAiSubscription &&
      isLlmModelCoveredByOpenAiSubscription(entry.id);
    if (
      isCreditFreeHostedModel(entry.id) ||
      coveredByByok ||
      coveredByOpenAi
    ) {
      return entry;
    }
    return {
      ...entry,
      locked: true,
      pausedReason: reason,
    };
  });
  const hasPausedModel = pausedModelOptions.some(
    (entry) => entry.pausedReason === reason,
  );
  if (!hasPausedModel) {
    return {
      modelOptions: pausedModelOptions,
      hostedCreditsPaused: null,
    };
  }

  return {
    modelOptions: pausedModelOptions,
    hostedCreditsPaused: { reason },
  };
}
