/**
 * OAuth state management for integration connections.
 * States are short-lived (5 minutes) and single-use.
 */

export interface IntegrationOAuthState {
  integration_type: string;
  workspace_id: string;
  user_id: string;
  redirect_url: string;
  created_at: number;
}

const INTEGRATION_OAUTH_STATE_TTL_SECONDS = 5 * 60; // 5 minutes
const INTEGRATION_OAUTH_STATE_PREFIX = 'integration_oauth_state:';

function stateKey(state: string): string {
  return `${INTEGRATION_OAUTH_STATE_PREFIX}${state}`;
}

/**
 * Create a new integration OAuth state and store it in KV.
 */
export async function createIntegrationOAuthState(
  kv: KVNamespace,
  integrationType: string,
  workspaceId: string,
  userId: string,
  redirectUrl: string
): Promise<string> {
  const state = crypto.randomUUID();
  const data: IntegrationOAuthState = {
    integration_type: integrationType,
    workspace_id: workspaceId,
    user_id: userId,
    redirect_url: redirectUrl,
    created_at: Date.now(),
  };

  await kv.put(stateKey(state), JSON.stringify(data), {
    expirationTtl: INTEGRATION_OAUTH_STATE_TTL_SECONDS,
  });

  return state;
}

/**
 * Validate and consume an integration OAuth state (single-use).
 * Returns the state data if valid, null if invalid or expired.
 */
export async function validateAndConsumeIntegrationOAuthState(
  kv: KVNamespace,
  state: string
): Promise<IntegrationOAuthState | null> {
  const key = stateKey(state);
  const data = (await kv.get(key, 'json')) as IntegrationOAuthState | null;

  if (!data) {
    return null;
  }

  // Delete immediately to ensure single-use
  await kv.delete(key);

  return data;
}
