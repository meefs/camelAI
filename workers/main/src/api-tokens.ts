/**
 * API Token utilities with direct KV access.
 *
 * Tokens are stored in the APP_KV KV namespace with automatic TTL expiration.
 * No DO coordination needed - KV faults to origin if key isn't in local cache.
 */

export interface ApiTokenData {
  org_id: string;
  user_id: string;
  integration_id: string | null;
  name: string;
  scopes: string[];
  created_at: number;
  expires_at: number | null;
}

export interface CreateApiTokenInput {
  orgId: string;
  userId: string;
  name: string;
  scopes: string[];
  integrationId?: string | null;
  expiresAt?: number | null;
}

/**
 * Generate a secure token ID with tok_ prefix
 */
function generateTokenId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `tok_${base64}`;
}

/**
 * Create an API token and store it in KV
 */
export async function createApiToken(
  kv: KVNamespace,
  input: CreateApiTokenInput
): Promise<{ tokenId: string; tokenData: ApiTokenData }> {
  const tokenId = generateTokenId();
  const tokenData: ApiTokenData = {
    org_id: input.orgId,
    user_id: input.userId,
    integration_id: input.integrationId ?? null,
    name: input.name,
    scopes: input.scopes,
    created_at: Date.now(),
    expires_at: input.expiresAt ?? null,
  };

  const kvOptions: KVNamespacePutOptions = {};
  if (input.expiresAt) {
    // Set TTL in seconds
    kvOptions.expirationTtl = Math.max(1, Math.floor((input.expiresAt - Date.now()) / 1000));
  }

  await kv.put(tokenId, JSON.stringify(tokenData), kvOptions);

  return { tokenId, tokenData };
}

/**
 * Validate an API token from KV
 * Returns null if token doesn't exist or is expired
 */
export async function validateApiToken(
  kv: KVNamespace,
  tokenId: string
): Promise<ApiTokenData | null> {
  const data = await kv.get(tokenId);
  if (!data) return null;

  const tokenData = JSON.parse(data) as ApiTokenData;

  // Double-check expiration (KV TTL should handle this, but be safe)
  if (tokenData.expires_at && tokenData.expires_at < Date.now()) {
    await kv.delete(tokenId);
    return null;
  }

  return tokenData;
}

/**
 * Delete an API token from KV
 */
export async function deleteApiToken(kv: KVNamespace, tokenId: string): Promise<void> {
  await kv.delete(tokenId);
}
