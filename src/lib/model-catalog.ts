import type {
  ChatHarness,
  LlmModel,
  LlmProvider,
  OrganizationExperimentalSettings,
} from "../types";
import { getVisibleLlmModelOptions } from "./llm-provider-config";
import type { EffectiveModelPickerConfig } from "./model-picker-config";

// Adding a new model - checklist
//
// 1. Add the canonical ID to the LlmModel union in src/types.ts.
// 2. Add the harness-routing branches in src/lib/llm-provider-config.ts:
//    getProviderForModel, isLlmModel, isLlmModelAllowedForOrgProvider, and
//    CLAUDE_LLM_MODEL_OPTIONS or CODEX_LLM_MODEL_OPTIONS.
// 3. Add per-token pricing in
//    services/sandbox-host/internal/app/usage_pricing.go.
// 4. Add a MODEL_CATALOG entry below with a version-qualified label, logo type,
//    provider order, cost bucket, intelligence, and speed.
// 5. Update defaultOrgModelPickerConfig if it should ship in the default picker.
// 6. Add or update the catalog tests so the TS catalog, logos, and Go pricing do
//    not drift apart.

export type ProviderLogoType =
  | "claude"
  | "openai"
  | "kimi"
  | "grok"
  | "gemini"
  | "deepseek";
export type CostBucket = "$" | "$$" | "$$$";
export type Intelligence = "low" | "medium" | "high";
export type Speed = "slow" | "balanced" | "fast";

export interface ModelCatalogEntry {
  id: LlmModel;
  label: string;
  providerLogo: ProviderLogoType;
  providerOrder: number;
  modelOrder: number;
  cost: CostBucket;
  intelligence: Intelligence;
  speed: Speed;
}

export const ALL_LLM_MODELS: readonly LlmModel[] = [
  "opus-4.7",
  "opus",
  "haiku",
  "sonnet",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.6",
  "grok-4.3",
];

export const LLM_MODEL_TO_PRICING_KEY: Readonly<Record<LlmModel, string>> = {
  "opus-4.7": "claude-opus-4-7",
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "gpt-5.5": "gpt-5.5",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "kimi-k2.6": "kimi-k2.6",
  "grok-4.3": "grok-4.3",
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "gemini-3.1-pro-preview": "google/gemini-3.1-pro-preview",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
};

// Cost buckets are derived by hand from per-token pricing in
// services/sandbox-host/internal/app/usage_pricing.go. If you change pricing
// there, update the `cost` field below in the same PR.
//
// Buckets (USD per million tokens):
//   $   = input < $2 AND output < $10
//   $$  = input $2-4 AND output $10-20
//   $$$ = input >= $5 OR output >= $20
export const MODEL_CATALOG: Readonly<Record<LlmModel, ModelCatalogEntry>> = {
  "opus-4.7": {
    id: "opus-4.7",
    label: "Opus 4.7",
    providerLogo: "claude",
    providerOrder: 0,
    modelOrder: 0,
    cost: "$$$",
    intelligence: "high",
    speed: "slow",
  },
  opus: {
    id: "opus",
    label: "Opus 4.6",
    providerLogo: "claude",
    providerOrder: 0,
    modelOrder: 1,
    cost: "$$$",
    intelligence: "high",
    speed: "slow",
  },
  sonnet: {
    id: "sonnet",
    label: "Sonnet 4.6",
    providerLogo: "claude",
    providerOrder: 0,
    modelOrder: 2,
    cost: "$$",
    intelligence: "medium",
    speed: "balanced",
  },
  haiku: {
    id: "haiku",
    label: "Haiku 4.5",
    providerLogo: "claude",
    providerOrder: 0,
    modelOrder: 3,
    cost: "$",
    intelligence: "low",
    speed: "fast",
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    label: "GPT-5.5",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 0,
    cost: "$$$",
    intelligence: "high",
    speed: "balanced",
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    label: "GPT-5.4",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 1,
    cost: "$$",
    intelligence: "high",
    speed: "balanced",
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 2,
    cost: "$",
    intelligence: "low",
    speed: "fast",
  },
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    providerLogo: "gemini",
    providerOrder: 2,
    modelOrder: 0,
    cost: "$$",
    intelligence: "high",
    speed: "balanced",
  },
  "gemini-3-flash-preview": {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    providerLogo: "gemini",
    providerOrder: 2,
    modelOrder: 1,
    cost: "$",
    intelligence: "low",
    speed: "fast",
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    providerLogo: "deepseek",
    providerOrder: 3,
    modelOrder: 0,
    cost: "$",
    intelligence: "medium",
    speed: "balanced",
  },
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    providerLogo: "deepseek",
    providerOrder: 3,
    modelOrder: 1,
    cost: "$",
    intelligence: "low",
    speed: "fast",
  },
  "kimi-k2.6": {
    id: "kimi-k2.6",
    label: "Kimi K2.6",
    providerLogo: "kimi",
    providerOrder: 4,
    modelOrder: 0,
    cost: "$",
    intelligence: "medium",
    speed: "balanced",
  },
  "grok-4.3": {
    id: "grok-4.3",
    label: "Grok 4.3",
    providerLogo: "grok",
    providerOrder: 5,
    modelOrder: 0,
    cost: "$",
    intelligence: "medium",
    speed: "fast",
  },
};

export interface ResolvedModelCatalogEntry extends ModelCatalogEntry {
  addedAt: number;
}

export function compareModelCatalogEntries(
  a: ModelCatalogEntry,
  b: ModelCatalogEntry,
): number {
  return (
    a.providerOrder - b.providerOrder ||
    a.modelOrder - b.modelOrder ||
    a.label.localeCompare(b.label)
  );
}

export function resolveModelPickerCatalog(args: {
  effectiveConfig: EffectiveModelPickerConfig;
  provider: ChatHarness;
  experimentalSettings?: OrganizationExperimentalSettings | null;
  orgProvider?: LlmProvider | string | null;
}): ResolvedModelCatalogEntry[] {
  const visibleModelIds = new Set(
    getVisibleLlmModelOptions(args.provider, args.experimentalSettings, null, {
      allowModelFamilySwitch: true,
      orgProvider: args.orgProvider,
    }).map((option) => option.value),
  );

  return args.effectiveConfig.models
    .filter((model) => visibleModelIds.has(model.id))
    .map((model) => ({
      ...MODEL_CATALOG[model.id],
      addedAt: model.added_at,
    }))
    .sort(compareModelCatalogEntries);
}

export function modelCatalogEntriesForIds(
  ids: readonly LlmModel[],
): ModelCatalogEntry[] {
  return ids.map((id) => MODEL_CATALOG[id]).filter(Boolean);
}

export function sortAdditionalModelCatalogEntries(
  entries: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  return [...entries].sort(compareModelCatalogEntries);
}
