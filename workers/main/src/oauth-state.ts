/**
 * OAuth state management using KV storage for CSRF protection.
 * States are short-lived (5 minutes) and single-use.
 */

import type { OAuthProvider } from '../../../src/lib/oauth-config';

export interface OAuthState {
  provider: OAuthProvider;
  redirect_url: string;
  created_at: number;
}

const OAUTH_STATE_TTL_SECONDS = 5 * 60; // 5 minutes
const OAUTH_STATE_PREFIX = 'oauth_state:';

function stateKey(state: string): string {
  return `${OAUTH_STATE_PREFIX}${state}`;
}

/**
 * Create a new OAuth state and store it in KV.
 */
export async function createOAuthState(
  kv: KVNamespace,
  provider: OAuthProvider,
  redirectUrl: string
): Promise<string> {
  const state = crypto.randomUUID();
  const data: OAuthState = {
    provider,
    redirect_url: redirectUrl,
    created_at: Date.now(),
  };

  await kv.put(stateKey(state), JSON.stringify(data), {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });

  return state;
}

/**
 * Validate and consume an OAuth state (single-use).
 * Returns the state data if valid, null if invalid or expired.
 */
export async function validateAndConsumeOAuthState(
  kv: KVNamespace,
  state: string
): Promise<OAuthState | null> {
  const key = stateKey(state);
  const data = await kv.get(key, 'json') as OAuthState | null;

  if (!data) {
    return null;
  }

  // Delete immediately to ensure single-use
  await kv.delete(key);

  return data;
}
