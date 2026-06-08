import type {
  LlmModel,
  LlmProvider,
  LlmProviderConfigPublic,
  OrganizationExperimentalSettings,
} from "../types";
import { decryptCredentials } from "./integration-crypto";

export const DEFAULT_LLM_MODEL: LlmModel = "sonnet";
export const DEFAULT_CODEX_MODEL: LlmModel = "gpt-5.4";
export const DEFAULT_OPENROUTER_MODEL: LlmModel = "kimi-k2.6";
export const CUSTOM_LLM_MODEL: LlmModel = "custom";
export const THREAD_MODEL_LOCK_MESSAGE =
  "This thread is locked to its original model. Start a new thread to use a different model.";

const LEGACY_LLM_MODEL_REPLACEMENTS = {
  "gemini-3.1-pro-preview": "gemini-3.5-flash",
  opus: "opus-4.8",
  "opus-4.7": "opus-4.8",
} as const satisfies Record<string, LlmModel>;

type LegacyLlmModel = keyof typeof LEGACY_LLM_MODEL_REPLACEMENTS;

export function replaceLegacyLlmModel(value: unknown): unknown {
  if (
    typeof value === "string" &&
    Object.hasOwn(LEGACY_LLM_MODEL_REPLACEMENTS, value)
  ) {
    return LEGACY_LLM_MODEL_REPLACEMENTS[value as LegacyLlmModel];
  }
  return value;
}

// When adding a model here, also add it to the picker catalog at
// src/lib/model-catalog.ts and the pricing table at src/lib/usage-pricing.ts.
export const CLAUDE_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  {
    value: "opus-4.8",
    label: "Opus 4.8",
    description: "Smartest Claude model",
  },
  {
    value: "sonnet",
    label: "Sonnet 4.6",
    description: "Default and recommended",
  },
  { value: "haiku", label: "Haiku 4.5", description: "Faster and cheaper" },
];

export const CODEX_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  {
    value: "gpt-5.5",
    label: "GPT-5.5",
    description: "OpenAI flagship reasoning model",
  },
  {
    value: "gpt-5.4",
    label: "GPT-5.4",
    description: "Default and recommended",
  },
  {
    value: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "Faster and cheaper",
  },
  {
    value: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    description: "OpenRouter/camelAI hosted fast high-intelligence coding model",
  },
  {
    value: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    description: "OpenRouter/camelAI hosted fast reasoning model",
  },
  {
    value: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "OpenRouter/camelAI hosted flagship reasoning model",
  },
  {
    value: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "OpenRouter/camelAI hosted faster and cheaper model",
  },
  {
    value: "kimi-k2.6",
    label: "Kimi K2.6",
    description: "OpenRouter/camelAI hosted model",
  },
  {
    value: "grok-4.3",
    label: "Grok 4.3",
    description: "OpenRouter/camelAI hosted model",
  },
];

export const CUSTOM_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  {
    value: CUSTOM_LLM_MODEL,
    label: "Custom model",
    description: "Model configured on your custom provider",
  },
];

export const LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  ...CLAUDE_LLM_MODEL_OPTIONS,
  ...CODEX_LLM_MODEL_OPTIONS,
  ...CUSTOM_LLM_MODEL_OPTIONS,
];

const OPENROUTER_ONLY_CODEX_MODELS = new Set<LlmModel>([
  "kimi-k2.6",
  "grok-4.3",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]);

export interface LlmProviderStoredConfig {
  aws_region?: string;
  custom_name?: string;
  custom_base_url?: string;
  custom_auth_type?: "bearer" | "x-api-key";
  custom_api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  custom_model_id?: string;
}

export type CustomLlmProviderApi = NonNullable<
  LlmProviderStoredConfig["custom_api"]
>;

interface LlmProviderModelOptions {
  customApi?: CustomLlmProviderApi | null;
  customModelId?: string | null;
}

export const DEFAULT_ORG_EXPERIMENTAL_SETTINGS: OrganizationExperimentalSettings =
  {
    claude_proxy_models: false,
  };

export function parseOrganizationExperimentalSettings(
  raw: unknown,
): OrganizationExperimentalSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_ORG_EXPERIMENTAL_SETTINGS };
  }

  const settings = raw as Record<string, unknown>;
  return {
    claude_proxy_models: settings.claude_proxy_models === true,
  };
}

export function isClaudeProxyModelsEnabled(
  settings: OrganizationExperimentalSettings | null | undefined,
): boolean {
  return Boolean(settings?.claude_proxy_models);
}

export function getDefaultLlmModel(
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): LlmModel {
  if (orgProvider === "openai") return DEFAULT_CODEX_MODEL;
  if (orgProvider === "openrouter") return DEFAULT_OPENROUTER_MODEL;
  if (orgProvider === "custom" && hasCustomModelId(options?.customModelId)) {
    return CUSTOM_LLM_MODEL;
  }
  if (orgProvider === "custom" && isOpenAiCompatibleCustomApi(options?.customApi)) {
    return DEFAULT_CODEX_MODEL;
  }
  return DEFAULT_LLM_MODEL;
}

export function getLlmModelOptions(
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> {
  if (orgProvider === "custom" && hasCustomModelId(options?.customModelId)) {
    return CUSTOM_LLM_MODEL_OPTIONS;
  }
  return LLM_MODEL_OPTIONS.filter((option) =>
    isLlmModelAllowedForOrgProvider(option.value, orgProvider, options),
  );
}

export function isClaudeLlmModel(model: unknown): model is LlmModel {
  return CLAUDE_LLM_MODEL_OPTIONS.some((option) => option.value === model);
}

export function isCodexLlmModel(model: unknown): model is LlmModel {
  return CODEX_LLM_MODEL_OPTIONS.some((option) => option.value === model);
}

export function getVisibleLlmModelOptions(
  experimentalSettings?: OrganizationExperimentalSettings | null,
  includeModel?: LlmModel | null,
  options?: {
    orgProvider?: string | null;
    customApi?: CustomLlmProviderApi | null;
    customModelId?: string | null;
  },
): ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> {
  const baseOptions = getLlmModelOptions(options?.orgProvider, {
    customApi: options?.customApi,
    customModelId: options?.customModelId,
  });

  if (
    !includeModel ||
    baseOptions.some((option) => option.value === includeModel)
  ) {
    return baseOptions;
  }

  const fallbackOption = [
    ...CODEX_LLM_MODEL_OPTIONS,
    ...CLAUDE_LLM_MODEL_OPTIONS,
  ].find((option) => option.value === includeModel);

  return fallbackOption ? [fallbackOption, ...baseOptions] : baseOptions;
}

export function isLlmModelAllowedForNewThread(
  value: unknown,
  orgProvider: string | null | undefined,
  experimentalSettings?: OrganizationExperimentalSettings | null,
  options?: LlmProviderModelOptions,
): value is LlmModel {
  return (
    isLlmModel(value) &&
    isLlmModelAllowedForOrgProvider(value, orgProvider, options)
  );
}

export function isLlmModel(value: unknown): value is LlmModel {
  return (
    isCodexLlmModel(value) ||
    isClaudeLlmModel(value) ||
    value === CUSTOM_LLM_MODEL
  );
}

export function isLlmModelAllowedForOrgProvider(
  model: LlmModel,
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): boolean {
  if (orgProvider === "openai") {
    return isCodexLlmModel(model) && !OPENROUTER_ONLY_CODEX_MODELS.has(model);
  }
  if (orgProvider === "anthropic" || orgProvider === "bedrock") {
    return isClaudeLlmModel(model);
  }
  if (orgProvider === "custom") {
    if (model === CUSTOM_LLM_MODEL) {
      return hasCustomModelId(options?.customModelId);
    }
    if (options?.customApi === "anthropic-messages") {
      return isClaudeLlmModel(model);
    }
    if (isOpenAiCompatibleCustomApi(options?.customApi)) {
      return isCodexLlmModel(model) && !OPENROUTER_ONLY_CODEX_MODELS.has(model);
    }
    return true;
  }
  if (OPENROUTER_ONLY_CODEX_MODELS.has(model)) {
    return orgProvider !== "openai";
  }
  if (model === CUSTOM_LLM_MODEL) return false;
  return true;
}

export function isLlmModelCoveredByByokProvider(
  model: LlmModel | null | undefined,
  provider: string | null | undefined,
): boolean {
  if (!provider) return false;
  if (!model) return true;
  if (provider === "openrouter") return true;
  if (provider === "anthropic" || provider === "bedrock") {
    return isClaudeLlmModel(model);
  }
  if (provider === "openai") {
    return isCodexLlmModel(model) && !OPENROUTER_ONLY_CODEX_MODELS.has(model);
  }
  if (provider === "custom") return true;
  return false;
}

export function normalizeLlmModel(
  value: unknown,
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): LlmModel {
  const normalizedValue = replaceLegacyLlmModel(value);
  return isLlmModel(normalizedValue) &&
    isLlmModelAllowedForOrgProvider(normalizedValue, orgProvider, options)
    ? normalizedValue
    : getDefaultLlmModel(orgProvider, options);
}

export function isOpenAiCompatibleCustomApi(
  customApi: CustomLlmProviderApi | null | undefined,
): boolean {
  return customApi === "openai-completions" || customApi === "openai-responses";
}

export function hasCustomModelId(customModelId: string | null | undefined): boolean {
  return Boolean(customModelId?.trim());
}

export function parseStoredLlmProviderConfig(
  raw: unknown,
): LlmProviderStoredConfig {
  let config: Record<string, unknown> = {};

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
  } else if (raw && typeof raw === "object") {
    config = raw as Record<string, unknown>;
  }

  const awsRegion =
    typeof config.aws_region === "string" && config.aws_region.trim()
      ? config.aws_region.trim()
      : undefined;
  const customName =
    typeof config.custom_name === "string" && config.custom_name.trim()
      ? config.custom_name.trim().slice(0, 80)
      : undefined;
  const customBaseUrl =
    typeof config.custom_base_url === "string" && config.custom_base_url.trim()
      ? config.custom_base_url.trim().replace(/\/+$/, "")
      : undefined;
  const customAuthType =
    config.custom_auth_type === "bearer" || config.custom_auth_type === "x-api-key"
      ? config.custom_auth_type
      : undefined;
  const customApi =
    config.custom_api === "openai-completions" ||
    config.custom_api === "openai-responses" ||
    config.custom_api === "anthropic-messages"
      ? config.custom_api
      : undefined;
  const customModelId =
    typeof config.custom_model_id === "string" && config.custom_model_id.trim()
      ? config.custom_model_id.trim().slice(0, 200)
      : undefined;

  return {
    ...(awsRegion ? { aws_region: awsRegion } : {}),
    ...(customName ? { custom_name: customName } : {}),
    ...(customBaseUrl ? { custom_base_url: customBaseUrl } : {}),
    ...(customAuthType ? { custom_auth_type: customAuthType } : {}),
    ...(customApi ? { custom_api: customApi } : {}),
    ...(customModelId ? { custom_model_id: customModelId } : {}),
  };
}

export function parseLlmProviderStoredConfig(
  raw: unknown,
): LlmProviderStoredConfig {
  return parseStoredLlmProviderConfig(raw);
}

export function stringifyStoredLlmProviderConfig(
  config: Partial<LlmProviderStoredConfig>,
): string {
  const normalized = parseStoredLlmProviderConfig(config);
  return JSON.stringify({
    ...(normalized.aws_region ? { aws_region: normalized.aws_region } : {}),
    ...(normalized.custom_name ? { custom_name: normalized.custom_name } : {}),
    ...(normalized.custom_base_url ? { custom_base_url: normalized.custom_base_url } : {}),
    ...(normalized.custom_auth_type ? { custom_auth_type: normalized.custom_auth_type } : {}),
    ...(normalized.custom_api ? { custom_api: normalized.custom_api } : {}),
    ...(normalized.custom_model_id ? { custom_model_id: normalized.custom_model_id } : {}),
  });
}

export interface LlmProviderConfigRecord {
  provider: string;
  credentials_encrypted: string;
  config: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export function getStoredCustomLlmProviderApi(
  record: Pick<LlmProviderConfigRecord, "provider" | "config"> | null | undefined,
): CustomLlmProviderApi | null {
  if (record?.provider !== "custom") return null;
  return parseStoredLlmProviderConfig(record.config).custom_api ?? null;
}

export function getStoredCustomLlmProviderModelId(
  record: Pick<LlmProviderConfigRecord, "provider" | "config"> | null | undefined,
): string | null {
  if (record?.provider !== "custom") return null;
  return parseStoredLlmProviderConfig(record.config).custom_model_id ?? null;
}

export function keyHint(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 8)}...`;
}

export async function buildPublicLlmProviderConfig(
  record: LlmProviderConfigRecord,
  integrationSecretKey: string,
): Promise<LlmProviderConfigPublic> {
  let hint = "********";

  try {
    const creds = await decryptCredentials<Record<string, string>>(
      record.credentials_encrypted,
      integrationSecretKey,
    );
    const primaryKey =
      record.provider === "anthropic" ||
      record.provider === "openai" ||
      record.provider === "openrouter" ||
      record.provider === "custom"
        ? creds.api_key
        : creds.bearer_token;
    if (primaryKey) {
      hint = keyHint(primaryKey);
    }
  } catch {
    // Fall back to a generic redacted hint.
  }

  return {
    provider: record.provider as LlmProvider,
    config: parseStoredLlmProviderConfig(record.config),
    key_hint: hint,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
