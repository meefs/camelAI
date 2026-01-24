/**
 * OpenRouter API key provisioning for per-org usage tracking.
 * Creates sub-keys under a parent provisioning key for each organization.
 */

import { encryptCredentials, decryptCredentials } from '../../../src/lib/integration-crypto';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

export interface OpenRouterKeyCreateParams {
  name: string;
  limit?: number; // Credits limit (optional)
}

export interface OpenRouterKeyResponse {
  key: string;
  data: {
    label: string;
    usage: number;
    limit: number | null;
    is_free_tier: boolean;
    is_provisioning_key: boolean;
    rate_limit: {
      requests: number;
      interval: string;
    };
    created_at: string;
    updated_at: string;
    hash: string;
  };
}

export interface OpenRouterKeyInfo {
  label: string;
  usage: number;
  limit: number | null;
  is_free_tier: boolean;
  created_at: string;
  updated_at: string;
  hash: string;
}

/**
 * Create a new OpenRouter API key using the provisioning key.
 */
export async function createOpenRouterKey(
  provisioningKey: string,
  params: OpenRouterKeyCreateParams
): Promise<OpenRouterKeyResponse> {
  const response = await fetch(`${OPENROUTER_API_BASE}/keys`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provisioningKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: params.name,
      limit: params.limit,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${text}`);
  }

  return response.json() as Promise<OpenRouterKeyResponse>;
}

/**
 * Get info about an OpenRouter API key.
 */
export async function getOpenRouterKeyInfo(
  apiKey: string
): Promise<OpenRouterKeyInfo> {
  const response = await fetch(`${OPENROUTER_API_BASE}/keys/current`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${text}`);
  }

  const data = await response.json() as { data: OpenRouterKeyInfo };
  return data.data;
}

/**
 * Delete an OpenRouter API key.
 */
export async function deleteOpenRouterKey(
  provisioningKey: string,
  keyHash: string
): Promise<void> {
  const response = await fetch(`${OPENROUTER_API_BASE}/keys/${keyHash}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${provisioningKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${text}`);
  }
}

/**
 * Encrypt an OpenRouter API key for storage.
 */
export async function encryptOpenRouterKey(
  key: string,
  secretKey: string
): Promise<string> {
  return encryptCredentials({ key }, secretKey);
}

/**
 * Decrypt an OpenRouter API key from storage.
 */
export async function decryptOpenRouterKey(
  encryptedKey: string,
  secretKey: string
): Promise<string> {
  const data = await decryptCredentials<{ key: string }>(encryptedKey, secretKey);
  return data.key;
}

/**
 * Get the first 8 characters of a key for identification (hash prefix).
 */
export function getKeyHash(key: string): string {
  // OpenRouter keys start with 'sk-or-v1-' so skip that prefix
  const keyBody = key.replace(/^sk-or-v1-/, '');
  return keyBody.slice(0, 8);
}
