import type { Env } from './types.js';
import { requireSession } from './helpers/auth.js';
import { getUserStub } from './helpers/stubs.js';

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
  // Extra config for providers that need additional state (e.g., subdomain for Zendesk, shop_domain for Shopify)
  extra_config?: Record<string, unknown>;
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
  redirectUrl: string,
  extraConfig?: Record<string, unknown>
): Promise<string> {
  const state = crypto.randomUUID();
  const data: IntegrationOAuthState = {
    integration_type: integrationType,
    workspace_id: workspaceId,
    user_id: userId,
    redirect_url: redirectUrl,
    created_at: Date.now(),
    extra_config: extraConfig,
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
  state: string,
  context: { req: Request; env: Env },
): Promise<IntegrationOAuthState | null> {
  const key = stateKey(state);
  const data = (await kv.get(key, 'json')) as IntegrationOAuthState | null;

  if (!isFreshState(data)) {
    return null;
  }

  const auth = await requireSession(context.req, context.env);
  if ('error' in auth || auth.session.user_id !== data.user_id) return null;
  const consumed = await getUserStub(context.env, data.user_id).consumeOAuthNonce(
    `integration:${state}`, data.created_at + INTEGRATION_OAUTH_STATE_TTL_SECONDS * 1000,
  );
  if (!consumed) return null;
  await kv.delete(key);

  return data;
}

/**
 * Read an OAuth state without consuming it. This is only for provider-denied
 * callbacks that need to return to the originating UI while leaving the setup
 * request retryable; successful/token callbacks must use the single-use helper.
 */
export async function readIntegrationOAuthState(
  kv: KVNamespace,
  state: string,
): Promise<IntegrationOAuthState | null> {
  const data = (await kv.get(stateKey(state), 'json')) as IntegrationOAuthState | null;
  return isFreshState(data) ? data : null;
}

function isFreshState(data: IntegrationOAuthState | null): data is IntegrationOAuthState {
  return !!data && typeof data.user_id === 'string' && typeof data.workspace_id === 'string'
    && Number.isFinite(data.created_at) && data.created_at <= Date.now()
    && data.created_at + INTEGRATION_OAUTH_STATE_TTL_SECONDS * 1000 > Date.now();
}
