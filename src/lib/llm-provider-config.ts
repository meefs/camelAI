import type { LlmModel, LlmProvider, LlmProviderConfigPublic } from '../types';
import { decryptCredentials } from './integration-crypto';

export const DEFAULT_LLM_MODEL: LlmModel = 'sonnet';

export const LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  { value: 'sonnet', label: 'Sonnet', description: 'Default and recommended' },
  { value: 'opus', label: 'Opus', description: 'Smarter, but slower and more expensive' },
];

export interface LlmProviderStoredConfig {
  aws_region?: string;
}

export function isLlmModel(value: unknown): value is LlmModel {
  return value === 'sonnet' || value === 'opus';
}

export function normalizeLlmModel(value: unknown): LlmModel {
  return isLlmModel(value) ? value : DEFAULT_LLM_MODEL;
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
    const primaryKey = record.provider === 'anthropic' ? creds.api_key : creds.bearer_token;
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
