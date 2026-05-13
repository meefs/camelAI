import type {
  ChatHarness,
  LlmModel,
  LlmProvider,
  LlmProviderConfigPublic,
  OrganizationExperimentalSettings,
} from "../types";
import { decryptCredentials } from "./integration-crypto";

export const DEFAULT_LLM_MODEL: LlmModel = "sonnet";
export const DEFAULT_CODEX_MODEL: LlmModel = "gpt-5.4";
export const DEFAULT_OPENROUTER_MODEL: LlmModel = "kimi-k2.6";
export const THREAD_MODEL_LOCK_MESSAGE =
  "This thread is locked to its original model. Start a new thread to use a different model.";

// When adding a model here, also add it to the picker catalog at
// src/lib/model-catalog.ts and the pricing table at src/lib/usage-pricing.ts.
export const CLAUDE_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  {
    value: "opus-4.7",
    label: "Opus 4.7",
    description: "Smartest Claude model",
  },
  {
    value: "opus",
    label: "Opus 4.6",
    description: "Smarter, but slower and more expensive",
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
    value: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    description: "OpenRouter/camelAI hosted flagship reasoning model",
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

export const LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = CLAUDE_LLM_MODEL_OPTIONS;

const OPENROUTER_ONLY_CODEX_MODELS = new Set<LlmModel>([
  "kimi-k2.6",
  "grok-4.3",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]);

export interface LlmProviderStoredConfig {
  aws_region?: string;
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

export function getAllowedChatHarnessesForNewThread(
  orgProvider: string | null | undefined,
  experimentalSettings?: OrganizationExperimentalSettings | null,
): ChatHarness[] {
  if (orgProvider === "anthropic" || orgProvider === "bedrock") {
    return ["claude"];
  }
  if (orgProvider === "openrouter") {
    return ["codex", "claude"];
  }
  if (orgProvider === "openai") {
    return ["codex"];
  }
  return ["claude", "codex"];
}

export function getDefaultThreadProvider(
  orgProvider: string | null | undefined,
  experimentalSettings?: OrganizationExperimentalSettings | null,
): ChatHarness {
  return (
    getAllowedChatHarnessesForNewThread(orgProvider, experimentalSettings)[0] ??
    "claude"
  );
}

export function getDefaultLlmModel(
  provider: ChatHarness,
  orgProvider?: string | null,
): LlmModel {
  if (provider === "codex" && orgProvider === "openrouter") {
    return DEFAULT_OPENROUTER_MODEL;
  }
  return provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_LLM_MODEL;
}

export function getLlmModelOptions(provider: ChatHarness): ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> {
  return provider === "codex"
    ? CODEX_LLM_MODEL_OPTIONS
    : CLAUDE_LLM_MODEL_OPTIONS;
}

export function getProviderForModel(
  model: LlmModel | null | undefined,
  fallbackProvider: ChatHarness = "claude",
): ChatHarness {
  if (CODEX_LLM_MODEL_OPTIONS.some((option) => option.value === model)) {
    return "codex";
  }
  if (CLAUDE_LLM_MODEL_OPTIONS.some((option) => option.value === model)) {
    return "claude";
  }
  return fallbackProvider;
}

export function getChatHarnessesForLlmProvider(
  provider: string | null | undefined,
): ChatHarness[] {
  if (provider === "openrouter") {
    return ["codex", "claude"];
  }
  if (provider === "openai") {
    return ["codex"];
  }
  if (provider === "anthropic" || provider === "bedrock") {
    return ["claude"];
  }
  return [];
}

export function getAffectedChatHarnessesForLlmProviderChange(
  previousProvider: string | null | undefined,
  nextProvider: string | null | undefined,
): ChatHarness[] {
  return Array.from(
    new Set([
      ...getChatHarnessesForLlmProvider(previousProvider),
      ...getChatHarnessesForLlmProvider(nextProvider),
    ]),
  );
}

export function getVisibleLlmModelOptions(
  provider: ChatHarness,
  experimentalSettings?: OrganizationExperimentalSettings | null,
  includeModel?: LlmModel | null,
  options?: {
    allowModelFamilySwitch?: boolean;
    orgProvider?: string | null;
  },
): ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> {
  const visibleHarnesses = options?.allowModelFamilySwitch
    ? getAllowedChatHarnessesForNewThread(
        options.orgProvider,
        experimentalSettings,
      )
    : [provider];
  const baseOptions = visibleHarnesses
    .flatMap((visibleProvider) =>
      visibleProvider === "codex"
        ? CODEX_LLM_MODEL_OPTIONS
        : CLAUDE_LLM_MODEL_OPTIONS,
    )
    .filter((option) =>
      isLlmModelAllowedForOrgProvider(option.value, options?.orgProvider),
    );

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
): value is LlmModel {
  if (!isLlmModel(value)) return false;
  const provider = getProviderForModel(value);
  return (
    getAllowedChatHarnessesForNewThread(
      orgProvider,
      experimentalSettings,
    ).includes(provider) && isLlmModelAllowedForOrgProvider(value, orgProvider)
  );
}

export function isLlmModel(
  value: unknown,
  provider?: ChatHarness,
): value is LlmModel {
  if (provider === "codex") {
    return CODEX_LLM_MODEL_OPTIONS.some((option) => option.value === value);
  }
  if (provider === "claude") {
    return CLAUDE_LLM_MODEL_OPTIONS.some((option) => option.value === value);
  }
  return (
    CODEX_LLM_MODEL_OPTIONS.some((option) => option.value === value) ||
    CLAUDE_LLM_MODEL_OPTIONS.some((option) => option.value === value)
  );
}

export function isLlmModelAllowedForOrgProvider(
  model: LlmModel,
  orgProvider?: string | null,
): boolean {
  if (OPENROUTER_ONLY_CODEX_MODELS.has(model)) {
    return orgProvider !== "openai";
  }
  return true;
}

export function normalizeLlmModel(
  value: unknown,
  provider: ChatHarness = "claude",
  orgProvider?: string | null,
): LlmModel {
  return isLlmModel(value, provider) &&
    isLlmModelAllowedForOrgProvider(value, orgProvider)
    ? value
    : getDefaultLlmModel(provider, orgProvider);
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

  return {
    ...(awsRegion ? { aws_region: awsRegion } : {}),
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
      record.provider === "openrouter"
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
