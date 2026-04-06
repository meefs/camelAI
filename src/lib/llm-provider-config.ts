import type {
  ChatHarness,
  LlmModel,
  LlmProvider,
  LlmProviderConfigPublic,
  OrganizationExperimentalSettings,
} from '../types';
import { decryptCredentials } from './integration-crypto';

export const DEFAULT_LLM_MODEL: LlmModel = 'sonnet';
export const DEFAULT_CODEX_MODEL: LlmModel = 'gpt-5.4';
export const THREAD_MODEL_LOCK_MESSAGE =
  'This thread is locked to its original model. Start a new thread to use a different model.';

export const CLAUDE_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  { value: 'sonnet', label: 'Sonnet', description: 'Default and recommended' },
  { value: 'opus', label: 'Opus', description: 'Smarter, but slower and more expensive' },
];

export const CODEX_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Default and recommended' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Faster and cheaper' },
];

export const LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = CLAUDE_LLM_MODEL_OPTIONS;

export interface LlmProviderStoredConfig {
  aws_region?: string;
}

export const DEFAULT_ORG_EXPERIMENTAL_SETTINGS: OrganizationExperimentalSettings = {
  codex_gpt_models: false,
};

export function parseOrganizationExperimentalSettings(raw: unknown): OrganizationExperimentalSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_ORG_EXPERIMENTAL_SETTINGS };
  }

  const settings = raw as Record<string, unknown>;
  return {
    codex_gpt_models: settings.codex_gpt_models === true,
  };
}

export function isExperimentalCodexModelsEnabled(
  settings: OrganizationExperimentalSettings | null | undefined,
): boolean {
  return Boolean(settings?.codex_gpt_models);
}

export function getDefaultThreadProvider(
  orgProvider: string | null | undefined,
  experimentalSettings?: OrganizationExperimentalSettings | null,
): ChatHarness {
  return orgProvider === 'openai' && isExperimentalCodexModelsEnabled(experimentalSettings)
    ? 'codex'
    : 'claude';
}

export function getDefaultLlmModel(provider: ChatHarness): LlmModel {
  return provider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_LLM_MODEL;
}

export function getLlmModelOptions(provider: ChatHarness): ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> {
  return provider === 'codex' ? CODEX_LLM_MODEL_OPTIONS : CLAUDE_LLM_MODEL_OPTIONS;
}

export function getProviderForModel(
  model: LlmModel | null | undefined,
  fallbackProvider: ChatHarness = 'claude',
): ChatHarness {
  if (model === 'gpt-5.4' || model === 'gpt-5.4-mini') {
    return 'codex';
  }
  if (model === 'sonnet' || model === 'opus') {
    return 'claude';
  }
  return fallbackProvider;
}

export function getChatHarnessesForLlmProvider(
  provider: string | null | undefined,
): ChatHarness[] {
  if (provider === 'openai') {
    return ['codex'];
  }
  if (provider === 'anthropic' || provider === 'bedrock') {
    return ['claude'];
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
    ])
  );
}

export function getVisibleLlmModelOptions(
  provider: ChatHarness,
  experimentalSettings?: OrganizationExperimentalSettings | null,
  includeModel?: LlmModel | null,
  options?: {
    allowModelFamilySwitch?: boolean;
  },
): ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> {
  const codexModelsEnabled = isExperimentalCodexModelsEnabled(experimentalSettings);
  const baseOptions = options?.allowModelFamilySwitch && codexModelsEnabled
    ? [...CLAUDE_LLM_MODEL_OPTIONS, ...CODEX_LLM_MODEL_OPTIONS]
    : provider === 'codex'
      ? (codexModelsEnabled ? CODEX_LLM_MODEL_OPTIONS : [])
      : CLAUDE_LLM_MODEL_OPTIONS;

  if (!includeModel || baseOptions.some((option) => option.value === includeModel)) {
    return baseOptions;
  }

  const fallbackOption = [...CODEX_LLM_MODEL_OPTIONS, ...CLAUDE_LLM_MODEL_OPTIONS]
    .find((option) => option.value === includeModel);

  return fallbackOption ? [fallbackOption, ...baseOptions] : baseOptions;
}

export function isLlmModel(value: unknown, provider?: ChatHarness): value is LlmModel {
  if (provider === 'codex') {
    return value === 'gpt-5.4' || value === 'gpt-5.4-mini';
  }
  if (provider === 'claude') {
    return value === 'sonnet' || value === 'opus';
  }
  return (
    value === 'sonnet' ||
    value === 'opus' ||
    value === 'gpt-5.4' ||
    value === 'gpt-5.4-mini'
  );
}

export function normalizeLlmModel(value: unknown, provider: ChatHarness = 'claude'): LlmModel {
  return isLlmModel(value, provider) ? value : getDefaultLlmModel(provider);
}

export function parseStoredLlmProviderConfig(raw: unknown): LlmProviderStoredConfig {
  let config: Record<string, unknown> = {};

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
  } else if (raw && typeof raw === 'object') {
    config = raw as Record<string, unknown>;
  }

  const awsRegion = typeof config.aws_region === 'string' && config.aws_region.trim()
    ? config.aws_region.trim()
    : undefined;

  return {
    ...(awsRegion ? { aws_region: awsRegion } : {}),
  };
}

export function parseLlmProviderStoredConfig(raw: unknown): LlmProviderStoredConfig {
  return parseStoredLlmProviderConfig(raw);
}

export function stringifyStoredLlmProviderConfig(config: Partial<LlmProviderStoredConfig>): string {
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
  integrationSecretKey: string
): Promise<LlmProviderConfigPublic> {
  let hint = '********';

  try {
    const creds = await decryptCredentials<Record<string, string>>(
      record.credentials_encrypted,
      integrationSecretKey
    );
    const primaryKey =
      record.provider === 'anthropic' || record.provider === 'openai'
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
